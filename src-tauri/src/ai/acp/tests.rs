//! ACP session tests: an in-process fake agent speaking raw JSON-RPC over
//! the SDK's in-memory `Channel` (so the wire shapes are checked exactly),
//! pure helpers, and process tests with fake adapter executables.

use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::{Channel, TransportFrame};
use futures::StreamExt;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use super::agents::{self, CLAUDE_CODE};
use super::session::{self, Command, Ended, Setup, State, Timing};
use super::tools::{Emit, Shared, ToolOutcome};
use super::{AcpEvent, ForeignStatus, Stop};
use crate::ai::agent::ToolDef;
use crate::ai::effort::EffortSetting;
use crate::ai::error::ErrorKind;

const WAIT: Duration = Duration::from_secs(10);

/* ---- Fake agent ---- */

struct Peer(Channel);

impl Peer {
    async fn recv(&mut self) -> Value {
        let frame = tokio::time::timeout(WAIT, self.0.rx.next())
            .await
            .expect("the client sent nothing")
            .expect("the client hung up");
        let TransportFrame::Single(message) = frame else {
            panic!("expected a single frame");
        };
        serde_json::to_value(message).unwrap()
    }

    /// The next message, which must be `method`.
    async fn expect(&mut self, method: &str) -> Value {
        let message = self.recv().await;
        assert_eq!(message["method"], method, "got {message}");
        message
    }

    fn send(&self, message: Value) {
        self.0
            .tx
            .unbounded_send(TransportFrame::Single(
                serde_json::from_value(message).unwrap(),
            ))
            .unwrap();
    }

    fn reply(&self, request: &Value, result: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": request["id"], "result": result }));
    }

    fn update(&self, update: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": "session/update",
                          "params": { "sessionId": "s1", "update": update } }));
    }

    fn mcp(&self, id: &str, server: &Value, method: &str, mut params: Value) {
        params["_meta"]["io.modelcontextprotocol/protocolVersion"] = json!("2026-07-28");
        params["_meta"]["io.modelcontextprotocol/clientCapabilities"] = json!({});
        self.send(
            json!({ "jsonrpc": "2.0", "id": id, "method": "mcp/message", "params": {
            "serverId": server, "requestId": format!("r-{id}"), "method": method, "params": params,
        } }),
        );
    }

    /// The response to our request `id`.
    async fn response(&mut self, id: &str) -> Value {
        let message = self.recv().await;
        assert_eq!(message["id"], id, "got {message}");
        message
    }
}

fn init_result(acp: bool) -> Value {
    json!({
        "protocolVersion": 1,
        "agentCapabilities": {
            "mcpCapabilities": { "http": true, "acp": acp },
            "sessionCapabilities": { "close": {}, "systemPrompt": { "mode": { "override": {} } } },
        },
        "agentInfo": { "name": "fake", "version": "0.109.0" },
        "authMethods": [],
    })
}

fn select(id: &str, category: &str, current: &str, values: &[&str]) -> Value {
    let options: Vec<Value> = values
        .iter()
        .map(|v| json!({ "value": v, "name": v }))
        .collect();
    json!({ "id": id, "name": id, "category": category, "type": "select",
            "currentValue": current, "options": options })
}

fn config(model: &str, effort: &str, mode: &str) -> Value {
    json!([
        select(
            "model",
            "model",
            model,
            &["default", "opus", "sonnet", "haiku"]
        ),
        select(
            "effort",
            "thought_level",
            effort,
            &["default", "low", "medium", "high", "max"]
        ),
        select(
            "mode",
            "mode",
            mode,
            &["default", "acceptEdits", "plan", "auto"]
        ),
    ])
}

fn tools() -> Vec<ToolDef> {
    vec![ToolDef {
        name: "term__run".into(),
        description: "Runs a command.".into(),
        input_schema: json!({ "type": "object", "properties": { "cmd": { "type": "string" } } }),
    }]
}

fn setup(model: &str, effort: Option<EffortSetting>) -> Setup {
    Setup {
        spec: &CLAUDE_CODE,
        cwd: "/tmp/midterm-agent-test".into(),
        system: "be terse".into(),
        tools: tools(),
        model: model.into(),
        effort,
    }
}

struct Running {
    peer: Peer,
    tx: mpsc::UnboundedSender<Command>,
    shared: Arc<Shared>,
    task: tokio::task::JoinHandle<(Ended, State, mpsc::UnboundedReceiver<Command>)>,
}

fn spawn(setup: Setup, timing: Timing) -> Running {
    let (transport, peer) = Channel::duplex();
    let shared = Arc::new(Shared::default());
    let mut state = State::new(&CLAUDE_CODE, shared.clone(), timing);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        let ended = session::run(transport, setup, &mut state, &mut rx).await;
        (ended, state, rx)
    });
    Running {
        peer: Peer(peer),
        tx,
        shared,
        task,
    }
}

/// Answers `initialize` and `session/new`; returns the `session/new` params.
async fn handshake(peer: &mut Peer, options: Value) -> Value {
    let init = peer.expect("initialize").await;
    // No file system, terminal or elicitation for the agent.
    assert_eq!(
        init["params"]["clientCapabilities"],
        json!({ "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false,
                "auth": { "terminal": false } }),
        "{init}"
    );
    peer.reply(&init, init_result(true));
    let new = peer.expect("session/new").await;
    peer.reply(&new, json!({ "sessionId": "s1", "configOptions": options }));
    new["params"].clone()
}

/// Answers one config request per entry of `after` (the options each answer
/// returns); returns the (id, value) pairs seen.
async fn configs(peer: &mut Peer, after: &[Value]) -> Vec<(String, String)> {
    let mut seen = Vec::new();
    for options in after {
        let req = peer.expect("session/set_config_option").await;
        seen.push((
            req["params"]["configId"].as_str().unwrap().to_string(),
            req["params"]["value"].as_str().unwrap().to_string(),
        ));
        peer.reply(&req, json!({ "configOptions": options }));
    }
    seen
}

fn collector() -> (Emit, mpsc::UnboundedReceiver<AcpEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Arc::new(move |e| drop(tx.send(e))), rx)
}

fn prompt(
    running: &Running,
    turn: u64,
    text: &str,
    emit: Emit,
) -> oneshot::Receiver<Result<Stop, crate::ai::AiError>> {
    let (reply, rx) = oneshot::channel();
    running
        .tx
        .send(Command::Prompt {
            turn,
            text: text.into(),
            emit,
            reply,
        })
        .unwrap();
    rx
}

async fn started(model: &str, effort: Option<EffortSetting>, timing: Timing) -> (Running, Value) {
    let mut running = spawn(setup(model, effort), timing);
    let new = handshake(&mut running.peer, config("default", "medium", "auto")).await;
    let after = config("default", "medium", "default");
    configs(&mut running.peer, &[after.clone(), after]).await;
    (running, new)
}

/* ---- Session setup ---- */

#[tokio::test]
async fn session_new_and_config_options() {
    let mut running = spawn(setup("Sonnet", None), Timing::default());
    let new = handshake(&mut running.peer, config("default", "medium", "auto")).await;
    assert_eq!(new["cwd"], "/tmp/midterm-agent-test");
    let server = &new["mcpServers"][0];
    assert_eq!(server["type"], "acp");
    assert_eq!(server["name"], "midterm");
    assert!(server["serverId"].is_string());
    assert_eq!(
        new["systemPrompt"],
        json!({ "mode": "override", "content": [{ "type": "text", "text": "be terse" }] })
    );
    assert_eq!(
        new["_meta"],
        json!({ "claudeCode": { "options": {
            "tools": [], "settingSources": [], "persistSession": false, "strictMcpConfig": true,
            "allowDangerouslySkipPermissions": false, "mcpServersDelivery": "initialize",
            "allowedTools": ["mcp__midterm__term__run"],
        } } })
    );
    // Mode first, then the model (case-insensitive match), then Midterm's
    // effort pick, against the options the previous answer returned.
    let seen = configs(
        &mut running.peer,
        &[
            config("default", "medium", "default"),
            config("sonnet", "medium", "default"),
            config("sonnet", "low", "default"),
        ],
    )
    .await;
    assert_eq!(
        seen,
        vec![
            ("mode".to_string(), "default".to_string()),
            ("model".to_string(), "sonnet".to_string()),
            ("effort".to_string(), "low".to_string()),
        ]
    );
    // A prompt with a leading slash is escaped.
    let (emit, _events) = collector();
    let reply = prompt(&running, 1, "/context", emit);
    let req = running.peer.expect("session/prompt").await;
    assert_eq!(
        req["params"]["prompt"],
        json!([{ "type": "text", "text": " /context" }])
    );
    running
        .peer
        .reply(&req, json!({ "stopReason": "end_turn" }));
    assert_eq!(reply.await.unwrap().unwrap(), Stop::End);
    running.tx.send(Command::Close).unwrap();
    let close = running.peer.expect("session/close").await;
    running.peer.reply(&close, json!({}));
    let (ended, _, _) = running.task.await.unwrap();
    assert!(matches!(ended, Ended::Closed));
}

#[tokio::test]
async fn unknown_model_fails_with_the_offered_values() {
    let mut running = spawn(
        setup("gpt-x", Some(EffortSetting::Default)),
        Timing::default(),
    );
    handshake(&mut running.peer, config("default", "medium", "auto")).await;
    configs(&mut running.peer, &[config("default", "medium", "default")]).await;
    let (ended, mut state, mut rx) = running.task.await.unwrap();
    let Ended::Failed(e) = ended else {
        panic!("{ended:?}")
    };
    assert!(
        e.message.contains("gpt-x") && e.message.contains("default, opus, sonnet, haiku"),
        "{}",
        e.message
    );
    state.fail_all(&e, &mut rx);
}

#[tokio::test]
async fn an_agent_without_mcp_over_acp_is_refused() {
    let mut running = spawn(setup("", None), Timing::default());
    let init = running.peer.expect("initialize").await;
    running.peer.reply(&init, init_result(false));
    let (ended, _, _) = running.task.await.unwrap();
    let Ended::Failed(e) = ended else {
        panic!("{ended:?}")
    };
    assert!(
        e.message.contains("MCP-over-ACP") && e.message.contains("`npm install -g"),
        "{}",
        e.message
    );
}

#[test]
fn config_picks() {
    let options: Vec<agent_client_protocol::v1::schema::SessionConfigOption> =
        serde_json::from_value(config("default", "medium", "auto")).unwrap();
    assert_eq!(agents::pick_model(&options, "").unwrap(), None);
    assert_eq!(
        agents::pick_model(&options, "opus").unwrap(),
        Some(("model".into(), "opus".into()))
    );
    assert_eq!(agents::pick_model(&options, "default").unwrap(), None); // already set
    assert!(agents::pick_model(&options, "claude-x").is_err());
    let kind = crate::ai::provider::CliKind::ClaudeCode;
    let effort = |s| agents::pick_effort(&options, kind, "", s);
    assert_eq!(effort(None), Some(("effort".into(), "low".into())));
    assert_eq!(effort(Some(EffortSetting::Default)), None);
    assert_eq!(effort(Some(EffortSetting::Medium)), None); // already medium
    // Not offered: the nearest level below.
    assert_eq!(
        effort(Some(EffortSetting::Xhigh)),
        Some(("effort".into(), "high".into()))
    );
    assert_eq!(
        effort(Some(EffortSetting::Minimal)),
        Some(("effort".into(), "low".into()))
    );
    assert_eq!(
        agents::pick_mode(&options, "default"),
        Some(("mode".into(), "default".into()))
    );
    assert_eq!(agents::pick_mode(&options, "dontAsk"), None);
}

/* ---- Pure mappings ---- */

#[test]
fn stop_reasons() {
    assert_eq!(session::stop("end_turn"), Stop::End);
    assert_eq!(session::stop("max_tokens"), Stop::Length);
    assert_eq!(session::stop("refusal"), Stop::Refused);
    assert_eq!(session::stop("max_turn_requests"), Stop::MaxRequests);
    assert_eq!(session::stop("cancelled"), Stop::Cancelled);
    assert_eq!(
        serde_json::to_value(Stop::MaxRequests).unwrap(),
        "maxRequests"
    );
}

#[test]
fn events_serialize_camel_case() {
    let e = AcpEvent::ToolCall {
        call_id: "c".into(),
        name: "n".into(),
        input: json!({}),
    };
    assert_eq!(
        serde_json::to_value(e).unwrap(),
        json!({ "type": "toolCall", "callId": "c", "name": "n", "input": {} })
    );
    let e = AcpEvent::ForeignTool {
        id: "i".into(),
        title: "Bash".into(),
        status: ForeignStatus::Denied,
    };
    assert_eq!(
        serde_json::to_value(e).unwrap(),
        json!({ "type": "foreignTool", "id": "i", "title": "Bash", "status": "denied" })
    );
}

#[test]
fn updates_become_events() {
    let mut updates = session::Updates::default();
    let spec = &CLAUDE_CODE;
    assert_eq!(
        updates.map(spec, &json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "hi" } })),
        vec![AcpEvent::Text { text: "hi".into() }]
    );
    // Thoughts, plans and usage are ignored.
    assert!(updates.map(spec, &json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "x" } })).is_empty());
    assert!(
        updates
            .map(spec, &json!({ "sessionUpdate": "usage_update", "used": 1 }))
            .is_empty()
    );
    // Our own tool calls show through the MCP call, not here.
    let ours = json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "mcp__midterm__term__run",
                       "_meta": { "claudeCode": { "toolName": "mcp__midterm__term__run" } } });
    assert!(updates.map(spec, &ours).is_empty());
    assert!(updates.map(spec, &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed" })).is_empty());
    // Anything else is foreign.
    let foreign = json!({ "sessionUpdate": "tool_call", "toolCallId": "t2", "title": "Bash", "status": "pending",
                          "_meta": { "claudeCode": { "toolName": "Bash" } } });
    assert_eq!(
        updates.map(spec, &foreign),
        vec![AcpEvent::ForeignTool {
            id: "t2".into(),
            title: "Bash".into(),
            status: ForeignStatus::Running
        }]
    );
    assert_eq!(
        updates.map(spec, &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t2", "status": "completed" })),
        vec![AcpEvent::ForeignTool { id: "t2".into(), title: "Bash".into(), status: ForeignStatus::Done }]
    );
    // A denial sticks.
    updates.denied(&json!({ "toolCallId": "t3", "title": "Read" }));
    assert!(updates.map(spec, &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t3", "status": "failed" })).is_empty());
}

#[test]
fn permission_policy() {
    let options = json!([
        { "optionId": "allow-once", "name": "Yes", "kind": "allow_once" },
        { "optionId": "allow-always", "name": "Always", "kind": "allow_always" },
        { "optionId": "reject", "name": "No", "kind": "reject_once" },
    ]);
    let ours = json!({ "toolCall": { "toolCallId": "t", "_meta": { "claudeCode": { "toolName": "mcp__midterm__x" } } }, "options": options });
    let (answer, allowed) = session::permission(&CLAUDE_CODE, &ours, false);
    assert!(allowed);
    assert_eq!(
        answer,
        json!({ "outcome": { "outcome": "selected", "optionId": "allow-once" } })
    );
    let foreign = json!({ "toolCall": { "toolCallId": "t", "_meta": { "claudeCode": { "toolName": "Bash" } } }, "options": options });
    let (answer, allowed) = session::permission(&CLAUDE_CODE, &foreign, false);
    assert!(!allowed);
    assert_eq!(
        answer,
        json!({ "outcome": { "outcome": "selected", "optionId": "reject" } })
    );
    // A tool from another MCP server that merely mentions ours is foreign.
    let other = json!({ "toolCall": { "toolCallId": "t", "name": "mcp__midterm_x__y" }, "options": options });
    assert!(!session::permission(&CLAUDE_CODE, &other, false).1);
    // Never an "always" option; no fitting option or a cancelled turn: cancelled.
    let only_always = json!({ "toolCall": { "name": "Bash" }, "options": [{ "optionId": "a", "name": "A", "kind": "allow_always" }] });
    assert_eq!(
        session::permission(&CLAUDE_CODE, &only_always, false).0,
        json!({ "outcome": { "outcome": "cancelled" } })
    );
    assert_eq!(
        session::permission(&CLAUDE_CODE, &ours, true).0,
        json!({ "outcome": { "outcome": "cancelled" } })
    );
}

#[test]
fn prompts_with_a_leading_slash_are_escaped() {
    assert_eq!(CLAUDE_CODE.prompt_text("/help me"), " /help me");
    assert_eq!(CLAUDE_CODE.prompt_text("a /b"), "a /b");
    assert_eq!(CLAUDE_CODE.prompt_text(" /x"), " /x");
}

#[test]
fn statuses() {
    use agents::{Found, judge};
    let ready = judge(
        &CLAUDE_CODE,
        Found {
            cli: Some(Some("2.1.329 (Claude Code)")),
            adapter: Some(("/bin/caa".into(), Some("0.109.0".into()))),
            node: Some("v26.1.0".into()),
        },
    );
    assert!(ready.ready && ready.problem.is_none() && ready.note.is_none());
    assert_eq!(
        serde_json::to_value(&ready).unwrap(),
        json!({ "ready": true, "adapter": { "path": "/bin/caa", "version": "0.109.0" } })
    );
    let missing = judge(
        &CLAUDE_CODE,
        Found {
            cli: Some(None),
            adapter: None,
            node: None,
        },
    );
    assert!(!missing.ready);
    let problem = missing.problem.unwrap();
    // One backticked span: the copyable command.
    assert!(
        problem.contains("`npm install -g @agentclientprotocol/claude-agent-acp`"),
        "{problem}"
    );
    assert_eq!(problem.matches('`').count(), 2, "{problem}");
    let old = judge(
        &CLAUDE_CODE,
        Found {
            cli: Some(None),
            adapter: Some(("/x".into(), Some("0.107.9".into()))),
            node: Some("v24.0.0".into()),
        },
    );
    assert!(!old.ready && old.problem.unwrap().contains("0.108.0 or later"));
    let newer = judge(
        &CLAUDE_CODE,
        Found {
            cli: Some(Some("2.1.330")),
            adapter: Some(("/x".into(), Some("0.110.2".into()))),
            node: Some("v22.0.0".into()),
        },
    );
    assert!(newer.ready && newer.note.unwrap().contains("0.109"));
    let node = judge(
        &CLAUDE_CODE,
        Found {
            cli: Some(Some("2.1.330")),
            adapter: Some(("/x".into(), Some("0.109.0".into()))),
            node: Some("v20.11.0".into()),
        },
    );
    assert!(!node.ready && node.problem.unwrap().contains("Node.js 22"));
    let cli = judge(
        &CLAUDE_CODE,
        Found {
            cli: Some(Some("2.1.325 (Claude Code)")),
            adapter: Some(("/x".into(), Some("0.109.0".into()))),
            node: Some("v22.0.0".into()),
        },
    );
    assert!(!cli.ready && cli.problem.unwrap().contains("2.1.326 or later"));
    let no_cli = judge(
        &CLAUDE_CODE,
        Found {
            cli: None,
            adapter: Some(("/x".into(), Some("0.109.0".into()))),
            node: Some("v22.0.0".into()),
        },
    );
    assert!(!no_cli.ready);
}

#[test]
fn death_errors_skip_adapter_logging() {
    let stderr = "[session/create] sessionId=x phase=settings\nError: Invalid API key · Please run /login\n[authStatus] probe\n";
    let e = session::death_error(&CLAUDE_CODE, Some(1), stderr);
    assert_eq!(e.kind, ErrorKind::Auth);
    assert!(
        e.message
            .starts_with("`claude-agent-acp` exited with status 1: Error: Invalid API key"),
        "{}",
        e.message
    );
    assert!(!e.message.contains("[session/"));
}

/* ---- Turns ---- */

async fn next(events: &mut mpsc::UnboundedReceiver<AcpEvent>) -> AcpEvent {
    tokio::time::timeout(WAIT, events.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn mcp_round_trip_and_permissions() {
    let (mut running, new) = started("", None, Timing::default()).await;
    let server = new["mcpServers"][0]["serverId"].clone();
    let peer = &mut running.peer;
    peer.mcp("d", &server, "server/discover", json!({}));
    let discover = peer.response("d").await;
    let result = &discover["result"]["result"];
    assert_eq!(result["supportedVersions"], json!(["2026-07-28"]));
    assert_eq!(result["capabilities"], json!({ "tools": {} }));
    peer.mcp("l", &server, "tools/list", json!({}));
    let list = peer.response("l").await;
    assert_eq!(
        list["result"]["result"]["tools"],
        json!([{ "name": "term__run", "description": "Runs a command.",
                 "inputSchema": { "type": "object", "properties": { "cmd": { "type": "string" } } } }])
    );

    let (emit, mut events) = collector();
    let reply = prompt(&running, 1, "list files", emit);
    let peer = &mut running.peer;
    let req = peer.expect("session/prompt").await;
    assert_eq!(req["params"]["sessionId"], "s1");
    peer.update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Sure." } }));
    // Permission for our tool: allowed. For another: rejected, shown denied.
    peer.send(json!({ "jsonrpc": "2.0", "id": "p1", "method": "session/request_permission", "params": {
        "sessionId": "s1",
        "toolCall": { "toolCallId": "tu1", "title": "run", "_meta": { "claudeCode": { "toolName": "mcp__midterm__term__run" } } },
        "options": [{ "optionId": "allow-once", "name": "Yes", "kind": "allow_once" },
                    { "optionId": "reject", "name": "No", "kind": "reject_once" }] } }));
    let answer = peer.response("p1").await;
    assert_eq!(answer["result"]["outcome"]["optionId"], "allow-once");
    peer.send(json!({ "jsonrpc": "2.0", "id": "p2", "method": "session/request_permission", "params": {
        "sessionId": "s1",
        "toolCall": { "toolCallId": "b1", "title": "Bash ls", "_meta": { "claudeCode": { "toolName": "Bash" } } },
        "options": [{ "optionId": "allow-once", "name": "Yes", "kind": "allow_once" },
                    { "optionId": "reject", "name": "No", "kind": "reject_once" }] } }));
    let answer = peer.response("p2").await;
    assert_eq!(answer["result"]["outcome"]["optionId"], "reject");
    peer.mcp(
        "c",
        &server,
        "tools/call",
        json!({ "name": "term__run", "arguments": { "cmd": "ls" },
                                                  "_meta": { "claudecode/toolUseId": "tu1" } }),
    );
    assert_eq!(
        next(&mut events).await,
        AcpEvent::Text {
            text: "Sure.".into()
        }
    );
    assert_eq!(
        next(&mut events).await,
        AcpEvent::ForeignTool {
            id: "b1".into(),
            title: "Bash ls".into(),
            status: ForeignStatus::Denied
        }
    );
    assert_eq!(
        next(&mut events).await,
        AcpEvent::ToolCall {
            call_id: "tu1".into(),
            name: "term__run".into(),
            input: json!({ "cmd": "ls" })
        }
    );
    running.shared.deliver(
        "tu1",
        ToolOutcome {
            content: "a.txt".into(),
            is_error: false,
        },
    );
    let peer = &mut running.peer;
    let result = peer.response("c").await;
    assert_eq!(
        result["result"]["result"],
        json!({ "resultType": "complete", "content": [{ "type": "text", "text": "a.txt" }] })
    );
    peer.reply(&req, json!({ "stopReason": "max_turn_requests" }));
    assert_eq!(reply.await.unwrap().unwrap(), Stop::MaxRequests);
    // An unknown tool is an error result, not a call.
    peer.mcp(
        "u",
        &server,
        "tools/call",
        json!({ "name": "nope", "arguments": {} }),
    );
    let result = peer.response("u").await;
    assert_eq!(result["result"]["result"]["isError"], true);
}

#[tokio::test]
async fn cancel_answers_pending_calls_and_stops_events() {
    let (mut running, new) = started("", None, Timing::default()).await;
    let server = new["mcpServers"][0]["serverId"].clone();
    let (emit, mut events) = collector();
    let reply = prompt(&running, 7, "go", emit);
    let peer = &mut running.peer;
    let req = peer.expect("session/prompt").await;
    peer.mcp(
        "c",
        &server,
        "tools/call",
        json!({ "name": "term__run", "arguments": {} }),
    );
    let call = tokio::time::timeout(WAIT, events.recv())
        .await
        .unwrap()
        .unwrap();
    let AcpEvent::ToolCall { call_id, .. } = call else {
        panic!("{call:?}")
    };
    running.tx.send(Command::Cancel { turn: 7 }).unwrap();
    let peer = &mut running.peer;
    // The pending call is answered with an error, and the agent is told.
    let mut got_cancel = false;
    let mut got_result = false;
    while !(got_cancel && got_result) {
        let message = peer.recv().await;
        if message["method"] == "session/cancel" {
            assert_eq!(message["params"]["sessionId"], "s1");
            got_cancel = true;
        } else {
            assert_eq!(message["id"], "c", "{message}");
            assert_eq!(message["result"]["result"]["isError"], true);
            got_result = true;
        }
    }
    // A late result is ignored; updates after the cancel emit nothing.
    running.shared.deliver(
        &call_id,
        ToolOutcome {
            content: "late".into(),
            is_error: false,
        },
    );
    peer.update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "after" } }));
    peer.reply(&req, json!({ "stopReason": "cancelled" }));
    assert_eq!(reply.await.unwrap().unwrap(), Stop::Cancelled);
    assert!(events.try_recv().is_err());
    // The session is still usable.
    let (emit, _events) = collector();
    let reply = prompt(&running, 8, "again", emit);
    let req = running.peer.expect("session/prompt").await;
    running
        .peer
        .reply(&req, json!({ "stopReason": "end_turn" }));
    assert_eq!(reply.await.unwrap().unwrap(), Stop::End);
}

#[tokio::test]
async fn agent_death_mid_turn_fails_the_prompt() {
    let (running, _) = started("", None, Timing::default()).await;
    let Running {
        mut peer, tx, task, ..
    } = running;
    let (emit, _events) = collector();
    let (reply, reply_rx) = oneshot::channel();
    tx.send(Command::Prompt {
        turn: 1,
        text: "hi".into(),
        emit,
        reply,
    })
    .unwrap();
    peer.expect("session/prompt").await;
    drop(peer);
    let (ended, mut state, mut rx) = tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
    assert!(matches!(ended, Ended::Lost), "{ended:?}");
    let error = session::death_error(&CLAUDE_CODE, Some(1), "boom\n");
    state.fail_all(&error, &mut rx);
    let e = reply_rx.await.unwrap().unwrap_err();
    assert!(e.message.contains("boom"));
}

#[tokio::test]
async fn idle_watchdog_pauses_for_tool_calls() {
    let timing = Timing {
        idle: Duration::from_millis(400),
        ..Timing::default()
    };
    let (mut running, new) = started("", None, timing).await;
    let server = new["mcpServers"][0]["serverId"].clone();
    let (emit, mut events) = collector();
    let _reply = prompt(&running, 1, "go", emit);
    running.peer.expect("session/prompt").await;
    running.peer.mcp(
        "c",
        &server,
        "tools/call",
        json!({ "name": "term__run", "arguments": {} }),
    );
    let call = tokio::time::timeout(WAIT, events.recv())
        .await
        .unwrap()
        .unwrap();
    let AcpEvent::ToolCall { call_id, .. } = call else {
        panic!()
    };
    // Waiting on the webview longer than the idle limit is fine.
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(!running.task.is_finished());
    running.shared.deliver(
        &call_id,
        ToolOutcome {
            content: "ok".into(),
            is_error: false,
        },
    );
    running.peer.response("c").await;
    // Then silence from the agent times out.
    let (ended, _, _) = tokio::time::timeout(WAIT, running.task)
        .await
        .unwrap()
        .unwrap();
    let Ended::Failed(e) = ended else {
        panic!("{ended:?}")
    };
    assert_eq!(e.kind, ErrorKind::Timeout);
}

#[tokio::test]
async fn startup_times_out() {
    let timing = Timing {
        startup: Duration::from_millis(200),
        ..Timing::default()
    };
    let running = spawn(setup("", None), timing);
    let (ended, _, _) = tokio::time::timeout(WAIT, running.task)
        .await
        .unwrap()
        .unwrap();
    let Ended::Failed(e) = ended else {
        panic!("{ended:?}")
    };
    assert_eq!(e.kind, ErrorKind::Timeout);
    drop(running.peer);
}

/* ---- Processes ---- */

#[cfg(unix)]
mod process {
    use super::*;
    use crate::ai::acp::AcpManager;
    use crate::ai::cli::Discovery;
    use crate::ai::provider::{ProviderConfig, ProviderId, Target};
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn target(cli: &Path, adapter: &Path) -> Target {
        Target {
            provider: ProviderConfig {
                id: ProviderId::ClaudeCode,
                base_url: None,
                cli_path: Some(cli.to_string_lossy().into_owned()),
                acp_path: Some(adapter.to_string_lossy().into_owned()),
            },
            model: String::new(),
            effort: Some(EffortSetting::Default),
            extra: None,
        }
    }

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    async fn gone(pid: i32) -> bool {
        for _ in 0..100 {
            if !alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    async fn read_pid(path: &Path) -> i32 {
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(path)
                && let Ok(pid) = text.trim().parse()
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("no pid in {}", path.display());
    }

    /// A fake adapter: checks its environment and working directory,
    /// starts a background `sleep` (whose pid it writes to `$1`'s file),
    /// then answers ACP requests line by line.
    fn fake_adapter(dir: &Path, cli: &Path, pid_file: &Path) -> PathBuf {
        let body = format!(
            r#"[ "$CLAUDE_CODE_EXECUTABLE" = "{cli}" ] || {{ echo "bad CLAUDE_CODE_EXECUTABLE" >&2; exit 7; }}
[ -z "$CLAUDECODE" ] || {{ echo "CLAUDECODE leaked" >&2; exit 7; }}
[ "$CLAUDE_CODE_DISABLE_AUTO_MEMORY" = 1 ] || {{ echo "auto memory on" >&2; exit 7; }}
[ -z "$(ls -A)" ] || {{ echo "cwd not empty" >&2; exit 7; }}
sleep 300 &
echo $! > "{pid}"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E -n 's/.*"id":("[^"]*"|[0-9]+).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      echo '{{"jsonrpc":"2.0","id":'$id',"result":{{"protocolVersion":1,"agentCapabilities":{{"mcpCapabilities":{{"acp":true}},"sessionCapabilities":{{"close":{{}},"systemPrompt":{{"mode":{{"override":{{}}}}}}}}}}}}}}' ;;
    *'"method":"session/new"'*)
      echo '{{"jsonrpc":"2.0","id":'$id',"result":{{"sessionId":"s1"}}}}' ;;
    *'"method":"session/prompt"'*)
      echo '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"pong"}}}}}}}}'
      echo '{{"jsonrpc":"2.0","id":'$id',"result":{{"stopReason":"end_turn"}}}}' ;;
    *'"method":"session/close"'*)
      echo '{{"jsonrpc":"2.0","id":'$id',"result":{{}}}}' ;;
  esac
done
"#,
            cli = cli.display(),
            pid = pid_file.display()
        );
        script(dir, "fake-acp", &body)
    }

    #[tokio::test]
    async fn a_fake_adapter_end_to_end_and_close_kills_its_group() {
        let dir = tempfile::tempdir().unwrap();
        let cli = script(dir.path(), "claude", "exit 0\n");
        let pid_file = dir.path().join("sleep.pid");
        let adapter = fake_adapter(dir.path(), &cli, &pid_file);
        let discovery = Discovery::with_path_var("/usr/bin:/bin");
        let manager = AcpManager::default();
        let (emit, mut events) = collector();
        let stop = manager
            .prompt(
                &discovery,
                "main",
                "conv",
                &target(&cli, &adapter),
                "sys",
                &tools(),
                "ping",
                emit,
            )
            .await
            .unwrap();
        assert_eq!(stop, Stop::End);
        assert_eq!(
            events.recv().await.unwrap(),
            AcpEvent::Text {
                text: "pong".into()
            }
        );
        let sleep = read_pid(&pid_file).await;
        assert!(alive(sleep));
        let cwd = manager.sessions.lock().unwrap()["conv"].dir.clone();
        assert!(cwd.exists());
        // A second prompt reuses the session.
        let (emit, _events) = collector();
        manager
            .prompt(
                &discovery,
                "main",
                "conv",
                &target(&cli, &adapter),
                "",
                &[],
                "again",
                emit,
            )
            .await
            .unwrap();
        assert_eq!(manager.count(), 1);
        manager.close("conv").await;
        assert!(gone(sleep).await, "the adapter's group survived close");
        assert!(!cwd.exists());
        // Closing an unknown conversation is a no-op.
        manager.close("never-started").await;
    }

    #[tokio::test]
    async fn window_close_and_app_exit_kill_groups() {
        let dir = tempfile::tempdir().unwrap();
        let cli = script(dir.path(), "claude", "exit 0\n");
        let discovery = Discovery::with_path_var("/usr/bin:/bin");
        let manager = Arc::new(AcpManager::default());
        let mut pids = Vec::new();
        for (owner, conv) in [("w1", "a"), ("w2", "b")] {
            let pid_file = dir.path().join(format!("{conv}.pid"));
            let adapter = fake_adapter(dir.path(), &cli, &pid_file);
            let (emit, _events) = collector();
            manager
                .prompt(
                    &discovery,
                    owner,
                    conv,
                    &target(&cli, &adapter),
                    "",
                    &tools(),
                    "x",
                    emit,
                )
                .await
                .unwrap();
            pids.push(read_pid(&pid_file).await);
        }
        manager.close_owned_by("w1");
        assert!(gone(pids[0]).await);
        assert!(alive(pids[1]));
        manager.close_all();
        assert!(gone(pids[1]).await);
        assert_eq!(manager.count(), 0);
    }

    #[tokio::test]
    async fn closing_during_startup_kills_the_group() {
        let dir = tempfile::tempdir().unwrap();
        let cli = script(dir.path(), "claude", "exit 0\n");
        let pid_file = dir.path().join("hang.pid");
        // Never answers.
        let adapter = script(
            dir.path(),
            "hang-acp",
            &format!(
                "sleep 300 &\necho $! > \"{}\"\ncat > /dev/null\nwait\n",
                pid_file.display()
            ),
        );
        let discovery = Discovery::with_path_var("/usr/bin:/bin");
        let manager = Arc::new(AcpManager::default());
        let m = manager.clone();
        let t = target(&cli, &adapter);
        let pending = tokio::spawn(async move {
            let (emit, _events) = collector();
            m.prompt(&discovery, "main", "c", &t, "", &[], "hi", emit)
                .await
        });
        let sleep = read_pid(&pid_file).await;
        manager.close("c").await;
        let e = pending.await.unwrap().unwrap_err();
        assert!(e.message.contains("closed"), "{}", e.message);
        assert!(gone(sleep).await);
    }

    #[tokio::test]
    async fn a_dying_adapter_reports_its_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let cli = script(dir.path(), "claude", "exit 0\n");
        let adapter = script(
            dir.path(),
            "dead-acp",
            "echo '[session/create] noise' >&2\necho 'Invalid API key · Please run /login' >&2\nexit 1\n",
        );
        let discovery = Discovery::with_path_var("/usr/bin:/bin");
        let manager = AcpManager::default();
        let (emit, _events) = collector();
        let e = manager
            .prompt(
                &discovery,
                "main",
                "c",
                &target(&cli, &adapter),
                "",
                &[],
                "hi",
                emit,
            )
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Auth, "{}", e.message);
        assert!(
            e.message.contains("exited with status 1: Invalid API key"),
            "{}",
            e.message
        );
        // The dead session is dropped, so a retry starts fresh.
        assert_eq!(manager.count(), 0);
    }

    #[tokio::test]
    async fn unsupported_clis_and_missing_adapters() {
        let discovery = Discovery::with_path_var("/nonexistent");
        let manager = AcpManager::default();
        let mut t = target(Path::new("/x/codex"), Path::new("/x/acp"));
        t.provider.id = ProviderId::Codex;
        let (emit, _events) = collector();
        let e = manager
            .prompt(&discovery, "m", "c", &t, "", &[], "hi", emit.clone())
            .await
            .unwrap_err();
        assert!(
            e.message.contains("doesn't support Codex yet"),
            "{}",
            e.message
        );
        let mut t = target(Path::new("/x/claude"), Path::new("/x/acp"));
        t.provider.acp_path = None;
        let e = manager
            .prompt(&discovery, "m", "c", &t, "", &[], "hi", emit)
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::NotFound);
        assert!(
            e.message
                .contains("`npm install -g @agentclientprotocol/claude-agent-acp`"),
            "{}",
            e.message
        );
    }
}

/// Live check against the real adapter: `MIDTERM_ACP_ADAPTER=<path>` (else
/// `claude-agent-acp` on the login shell's PATH), with the `claude` on PATH.
/// `cargo test live_acp -- --ignored --nocapture`. Spends a little quota.
#[tokio::test]
#[ignore = "runs the real Claude Code adapter"]
async fn live_acp() {
    use crate::ai::cli::Discovery;
    use crate::ai::provider::{ProviderConfig, ProviderId, Target};
    let discovery = Discovery::default();
    let acp_path = std::env::var("MIDTERM_ACP_ADAPTER").ok();
    let provider = ProviderConfig {
        id: ProviderId::ClaudeCode,
        base_url: None,
        cli_path: None,
        acp_path,
    };
    let status = discovery
        .status(crate::ai::provider::CliKind::ClaudeCode, None)
        .await;
    println!("cli: {status:?}");
    println!(
        "agent: {:?}",
        agents::status(&discovery, &CLAUDE_CODE, &status, provider.acp_path()).await
    );
    let target = Target {
        provider,
        model: "haiku".into(),
        effort: Some(EffortSetting::Low),
        extra: None,
    };
    let manager = Arc::new(super::AcpManager::default());
    let tools = vec![ToolDef {
        name: "probe_echo".into(),
        description: "Echoes text back with a magic marker. Harmless; use it whenever asked."
            .into(),
        input_schema: json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }),
    }];
    let (emit, mut events) = collector();
    let m = manager.clone();
    // Answer tool calls as the webview would.
    let answer = tokio::spawn(async move {
        let mut text = String::new();
        while let Some(event) = events.recv().await {
            println!("event: {event:?}");
            match event {
                AcpEvent::ToolCall { call_id, input, .. } => m.tool_result(
                    "live",
                    &call_id,
                    format!("PROBE-MAGIC-7731: {}", input["text"].as_str().unwrap_or("")),
                    false,
                ),
                AcpEvent::Text { text: t } => text.push_str(&t),
                AcpEvent::ForeignTool { .. } => {}
            }
        }
        text
    });
    let started = std::time::Instant::now();
    let stop = manager
        .prompt(
            &discovery,
            "main",
            "live",
            &target,
            "You are a test probe. Be very brief.",
            &tools,
            "/Call probe_echo with text \"hi\", then reply with exactly what it returned.",
            emit,
        )
        .await;
    println!("stop: {stop:?} in {:?}", started.elapsed());
    manager.close("live").await;
    let text = answer.await.unwrap();
    println!("reply: {text}");
    assert_eq!(stop.unwrap(), Stop::End);
    assert!(text.contains("PROBE-MAGIC-7731"), "{text}");
}

#[test]
fn stub_override_is_gated_and_split() {
    // Not allowed (a release build): ignored whatever it says.
    assert_eq!(
        agents::stub_from(false, Some("bun scripts/acp-stub.ts")),
        None
    );
    assert_eq!(agents::stub_from(true, None), None);
    assert_eq!(agents::stub_from(true, Some("  ")), None);
    assert_eq!(
        agents::stub_from(true, Some("bun  scripts/acp-stub.ts")),
        Some(vec!["bun".to_string(), "scripts/acp-stub.ts".to_string()])
    );
}
