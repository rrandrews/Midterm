//! Midterm's tools served to the agent as the MCP server `midterm`, over the
//! ACP connection itself (MCP-over-ACP, MCP revision 2026-07-28: stateless,
//! no `initialize`, `server/discover` first). Hand-written against the SDK's
//! `McpService`: the three methods are a few lines each and the tool list is
//! dynamic, so the rmcp bridge would add a dependency without saving code.
//!
//! A `tools/call` is not run here: it becomes a `toolCall` event for the
//! webview, which runs the skill (with its confirmation) and answers with
//! `ai_acp_tool_result`. If the prompt is cancelled meanwhile, the call is
//! answered with an error and a later result for it is ignored.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use agent_client_protocol::mcp_server::{McpOutcome, McpRequest, McpRequestContext, McpService};
use agent_client_protocol::v1::schema::McpError;
use agent_client_protocol::{Agent, Error};
use futures::future::BoxFuture;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use super::AcpEvent;
use super::agents::SERVER_NAME;
use crate::ai::agent::ToolDef;

/// Sends events to the running prompt's channel (through its gate).
pub type Emit = Arc<dyn Fn(AcpEvent) + Send + Sync>;

/// A tool result from the webview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutcome {
    pub content: String,
    pub is_error: bool,
}

/// The running prompt, as tool calls see it.
struct Turn {
    id: u64,
    emit: Emit,
    cancelled: bool,
}

/// State shared by the session task, the MCP service and the manager.
pub struct Shared {
    turn: Mutex<Option<Turn>>,
    /// Call id → where its result goes.
    pending: Mutex<HashMap<String, oneshot::Sender<ToolOutcome>>>,
    /// Tool calls waiting for the webview (the idle watchdog pauses).
    awaiting: AtomicUsize,
    /// When the agent last showed signs of life.
    activity: Mutex<Instant>,
    next_call: AtomicU64,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            turn: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            awaiting: AtomicUsize::new(0),
            activity: Mutex::new(Instant::now()),
            next_call: AtomicU64::new(1),
        }
    }
}

impl Shared {
    pub fn touch(&self) {
        *self.activity.lock().unwrap() = Instant::now();
    }

    pub fn idle_for(&self) -> std::time::Duration {
        self.activity.lock().unwrap().elapsed()
    }

    pub fn awaiting(&self) -> bool {
        self.awaiting.load(Ordering::SeqCst) > 0
    }

    pub fn busy(&self) -> bool {
        self.turn.lock().unwrap().is_some()
    }

    pub fn start_turn(&self, id: u64, emit: Emit) {
        *self.turn.lock().unwrap() = Some(Turn {
            id,
            emit,
            cancelled: false,
        });
        self.touch();
    }

    /// Ends the turn; pending calls are answered with an error.
    pub fn end_turn(&self) {
        *self.turn.lock().unwrap() = None;
        self.pending.lock().unwrap().clear();
    }

    /// Marks turn `id` cancelled: no more events, and pending calls are
    /// answered with an error. Returns whether it was the running turn.
    pub fn cancel_turn(&self, id: u64) -> bool {
        let mut turn = self.turn.lock().unwrap();
        match turn.as_mut() {
            Some(t) if t.id == id => {
                t.cancelled = true;
                drop(turn);
                self.pending.lock().unwrap().clear();
                true
            }
            _ => false,
        }
    }

    /// Emits to the running turn, unless it was cancelled.
    pub fn emit(&self, event: AcpEvent) {
        let emit = match self.turn.lock().unwrap().as_ref() {
            Some(t) if !t.cancelled => t.emit.clone(),
            _ => return,
        };
        emit(event);
    }

    /// Delivers the webview's result for `call_id`. Unknown (finished or
    /// cancelled) calls are ignored.
    pub fn deliver(&self, call_id: &str, outcome: ToolOutcome) {
        if let Some(tx) = self.pending.lock().unwrap().remove(call_id) {
            let _ = tx.send(outcome);
            self.touch();
        }
    }

    /// Registers a call: its id (the agent's tool use id when given and
    /// free) and where its result arrives. `None` when no turn is running.
    fn register(
        &self,
        preferred: Option<&str>,
    ) -> Option<(String, Emit, oneshot::Receiver<ToolOutcome>)> {
        // The turn stays locked while the call is added, so a cancel either
        // sees the call (and drops it) or is seen here.
        let turn = self.turn.lock().unwrap();
        let emit = match turn.as_ref() {
            Some(t) if !t.cancelled => t.emit.clone(),
            _ => return None,
        };
        let mut pending = self.pending.lock().unwrap();
        let id = match preferred {
            Some(id) if !id.is_empty() && !pending.contains_key(id) => id.to_string(),
            _ => format!("call-{}", self.next_call.fetch_add(1, Ordering::SeqCst)),
        };
        let (tx, rx) = oneshot::channel();
        pending.insert(id.clone(), tx);
        Some((id, emit, rx))
    }
}

/// The `midterm` MCP server.
pub struct Tools {
    pub defs: Arc<Vec<ToolDef>>,
    pub shared: Arc<Shared>,
}

/// Results are never cached by the client: the tool list is per session.
fn uncached(mut result: Map<String, Value>) -> Value {
    result.insert("ttlMs".into(), json!(0));
    result.insert("cacheScope".into(), json!("private"));
    Value::Object(result)
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

pub fn discover_result() -> Value {
    uncached(object(json!({
        "resultType": "complete",
        "supportedVersions": ["2026-07-28"],
        "capabilities": { "tools": {} },
        "_meta": {
            "io.modelcontextprotocol/serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") }
        },
    })))
}

pub fn list_result(defs: &[ToolDef]) -> Value {
    let tools: Vec<Value> = defs
        .iter()
        .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": t.input_schema }))
        .collect();
    uncached(object(json!({ "resultType": "complete", "tools": tools })))
}

pub fn call_result(text: &str, is_error: bool) -> Value {
    let mut result = json!({
        "resultType": "complete",
        "content": [{ "type": "text", "text": text }],
    });
    if is_error {
        result["isError"] = json!(true);
    }
    result
}

/// What the model sees for a call that was cut short.
pub const CANCELLED_CALL: &str = "The user stopped this request; the tool was not run.";

impl McpService<Agent> for Tools {
    fn execute(
        &self,
        request: McpRequest,
        context: McpRequestContext<Agent>,
    ) -> BoxFuture<'static, Result<McpOutcome, Error>> {
        self.shared.touch();
        let params = request.params.unwrap_or_default();
        let outcome = match request.method.as_str() {
            "server/discover" => McpOutcome::Result(discover_result()),
            "tools/list" => McpOutcome::Result(list_result(&self.defs)),
            "ping" => McpOutcome::Result(json!({})),
            "tools/call" => {
                return Box::pin(call(
                    self.defs.clone(),
                    self.shared.clone(),
                    params,
                    context,
                ));
            }
            other => McpOutcome::Error(McpError::new(-32601, format!("Unknown method: {other}"))),
        };
        Box::pin(async move { Ok(outcome) })
    }
}

async fn call(
    defs: Arc<Vec<ToolDef>>,
    shared: Arc<Shared>,
    params: Map<String, Value>,
    context: McpRequestContext<Agent>,
) -> Result<McpOutcome, Error> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !defs.iter().any(|t| t.name == name) {
        return Ok(McpOutcome::Result(call_result(
            &format!("Unknown tool {name:?}."),
            true,
        )));
    }
    let input = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let tool_use = params
        .get("_meta")
        .and_then(|m| m.get("claudecode/toolUseId"))
        .and_then(Value::as_str);
    let Some((call_id, emit, rx)) = shared.register(tool_use) else {
        return Ok(McpOutcome::Result(call_result(CANCELLED_CALL, true)));
    };
    emit(AcpEvent::ToolCall {
        call_id: call_id.clone(),
        name,
        input,
    });
    shared.awaiting.fetch_add(1, Ordering::SeqCst);
    let outcome = tokio::select! {
        result = rx => result.ok(),
        _ = context.operation_cancellation().cancelled() => None,
    };
    shared.awaiting.fetch_sub(1, Ordering::SeqCst);
    shared.pending.lock().unwrap().remove(&call_id);
    shared.touch();
    Ok(McpOutcome::Result(match outcome {
        Some(o) => call_result(&o.content, o.is_error),
        None => call_result(CANCELLED_CALL, true),
    }))
}
