//! One ACP session (MID-83): connect over a transport, `initialize`,
//! `session/new` with Midterm's MCP server attached, set the config options,
//! then serve prompts, cancels and the close from the manager until the
//! session ends. Generic over the transport, so tests drive it with an
//! in-process fake agent; [`run_process`] runs it over an adapter's stdio.
//!
//! Incoming session traffic is read as JSON rather than through the typed
//! schema, so an update shape this SDK version does not know is skipped
//! instead of failing the turn.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::mcp_server::McpServer;
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::v1::schema::{
    CancelNotification, ClientCapabilities, CloseSessionRequest, ContentBlock, Implementation,
    InitializeRequest, InitializeResponse, NewSessionRequest, SessionConfigOption,
    SessionConfigValueId, SetSessionConfigOptionRequest, SystemPrompt, SystemPromptMode,
};
use agent_client_protocol::v1::{ActiveSession, ConnectionTo, SessionMessage, SessionSetup};
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectTo, Dispatch, NullRun};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::agents::{self, AgentSpec, SERVER_NAME};
use super::tools::{Emit, Shared, Tools};
use super::{AcpEvent, ForeignStatus, Stop};
use crate::ai::agent::ToolDef;
use crate::ai::cli;
use crate::ai::effort::EffortSetting;
use crate::ai::error::{AiError, ErrorKind, truncate};
use crate::ai::process::{LongChild, Output};

/// What a session is created with (the first prompt's arguments).
pub struct Setup {
    pub spec: &'static AgentSpec,
    pub cwd: PathBuf,
    pub system: String,
    pub tools: Vec<ToolDef>,
    pub model: String,
    pub effort: Option<EffortSetting>,
}

pub type Reply = oneshot::Sender<Result<Stop, AiError>>;

/// A message from the manager to a session task.
pub enum Command {
    Prompt {
        turn: u64,
        text: String,
        emit: Emit,
        reply: Reply,
    },
    /// The prompt's caller went away (`ai_cancel`).
    Cancel {
        turn: u64,
    },
    Close,
}

#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// From spawn to the config options set.
    pub startup: Duration,
    /// How long a prompt may go without a sign of life from the agent
    /// (scaled with effort; paused while a tool call waits for its result).
    pub idle: Duration,
    /// How long a cancelled prompt may take to settle before the session is
    /// killed.
    pub cancel_grace: Duration,
    /// How long `session/close`, and then the process's own exit, may take.
    pub close_grace: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            startup: Duration::from_secs(30),
            idle: Duration::from_secs(180),
            cancel_grace: Duration::from_secs(5),
            close_grace: Duration::from_secs(2),
        }
    }
}

/// How a session ended.
#[derive(Debug)]
pub enum Ended {
    /// Closed on request.
    Closed,
    /// Failed or was given up on; the error goes to waiting prompts.
    Failed(AiError),
    /// The connection ended (the process died or closed its stdout).
    Lost,
}

/// Maps an ACP stop reason.
pub fn stop(reason: &str) -> Stop {
    match reason {
        "max_tokens" => Stop::Length,
        "refusal" => Stop::Refused,
        "max_turn_requests" => Stop::MaxRequests,
        "cancelled" => Stop::Cancelled,
        _ => Stop::End,
    }
}

/// An error the agent answered with.
pub fn acp_error(spec: &AgentSpec, e: &agent_client_protocol::Error) -> AiError {
    let mut message = e.message.clone();
    if let Some(data) = &e.data {
        let detail = match data {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        if !detail.is_empty() && detail != message {
            message = format!("{message}: {detail}");
        }
    }
    let message = truncate(&message, 400);
    if e.code == agent_client_protocol::ErrorCode::AUTH_REQUIRED {
        return AiError::new(
            ErrorKind::Auth,
            format!("{message}. {}", spec.sign_in_hint()),
        );
    }
    AiError::other(format!("the agent failed: {message}"))
}

/// The answer to `session/request_permission`: `allow_once` for Midterm's
/// own tools (Midterm confirms inside the tool), a reject option for
/// anything else, never an "always" option; `cancelled` when there is no
/// fitting option or the turn was cancelled. Returns the response and
/// whether it allowed the call.
pub fn permission(spec: &AgentSpec, params: &Value, cancelled: bool) -> (Value, bool) {
    let cancel = json!({ "outcome": { "outcome": "cancelled" } });
    if cancelled {
        return (cancel, false);
    }
    let tool_call = params.get("toolCall").unwrap_or(&Value::Null);
    let ours = spec.is_ours(tool_call);
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let with_kind = |kinds: &[&str]| {
        kinds.iter().find_map(|kind| {
            options
                .iter()
                .find(|o| o.get("kind").and_then(Value::as_str) == Some(kind))
                .and_then(|o| o.get("optionId").cloned())
        })
    };
    let chosen = if ours {
        with_kind(&["allow_once"])
    } else {
        with_kind(&["reject_once", "reject_always"])
    };
    match chosen {
        Some(id) => (
            json!({ "outcome": { "outcome": "selected", "optionId": id } }),
            ours,
        ),
        None => (cancel, false),
    }
}

/// Turns session updates into events, tracking tool calls that are not
/// Midterm's ("foreign": the lockdown leaked).
#[derive(Default)]
pub struct Updates {
    foreign: HashMap<String, (String, ForeignStatus)>,
}

fn foreign_status(status: Option<&str>) -> Option<ForeignStatus> {
    Some(match status? {
        "pending" | "in_progress" => ForeignStatus::Running,
        "completed" => ForeignStatus::Done,
        "failed" => ForeignStatus::Failed,
        _ => return None,
    })
}

impl Updates {
    /// The events for one `session/update`'s `update`.
    pub fn map(&mut self, spec: &AgentSpec, update: &Value) -> Vec<AcpEvent> {
        let kind = update.get("sessionUpdate").and_then(Value::as_str);
        let str_of = |key: &str| update.get(key).and_then(Value::as_str);
        match kind {
            Some("agent_message_chunk") => {
                let content = update.get("content").unwrap_or(&Value::Null);
                match (
                    content.get("type").and_then(Value::as_str),
                    content.get("text").and_then(Value::as_str),
                ) {
                    (Some("text"), Some(text)) if !text.is_empty() => vec![AcpEvent::Text {
                        text: text.to_string(),
                    }],
                    _ => Vec::new(),
                }
            }
            Some("tool_call") => {
                let Some(id) = str_of("toolCallId") else {
                    return Vec::new();
                };
                if spec.is_ours(update) {
                    return Vec::new();
                }
                let title = str_of("title")
                    .or(str_of("name"))
                    .unwrap_or("tool")
                    .to_string();
                let status = foreign_status(str_of("status")).unwrap_or(ForeignStatus::Running);
                self.foreign.insert(id.to_string(), (title.clone(), status));
                vec![AcpEvent::ForeignTool {
                    id: id.to_string(),
                    title,
                    status,
                }]
            }
            Some("tool_call_update") => {
                let Some(id) = str_of("toolCallId") else {
                    return Vec::new();
                };
                let Some((title, status)) = self.foreign.get_mut(id) else {
                    return Vec::new();
                };
                let mut changed = false;
                if let Some(t) = str_of("title")
                    && t != title
                {
                    *title = t.to_string();
                    changed = true;
                }
                // A denied call stays denied (its failure is the denial).
                if let Some(s) = foreign_status(str_of("status"))
                    && s != *status
                    && *status != ForeignStatus::Denied
                {
                    *status = s;
                    changed = true;
                }
                if !changed {
                    return Vec::new();
                }
                vec![AcpEvent::ForeignTool {
                    id: id.to_string(),
                    title: title.clone(),
                    status: *status,
                }]
            }
            _ => Vec::new(),
        }
    }

    /// The event for a foreign call whose permission was rejected.
    pub fn denied(&mut self, tool_call: &Value) -> Option<AcpEvent> {
        let id = tool_call.get("toolCallId").and_then(Value::as_str)?;
        let title = tool_call
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| self.foreign.get(id).map(|(t, _)| t.clone()))
            .unwrap_or_else(|| "tool".into());
        self.foreign
            .insert(id.to_string(), (title.clone(), ForeignStatus::Denied));
        Some(AcpEvent::ForeignTool {
            id: id.to_string(),
            title,
            status: ForeignStatus::Denied,
        })
    }
}

/// The running prompt.
struct Current {
    turn: u64,
    reply: Option<Reply>,
    cancelled: bool,
    cancel_deadline: Option<tokio::time::Instant>,
    idle: Duration,
}

/// The session's state across the connection's lifetime.
pub struct State {
    pub spec: &'static AgentSpec,
    pub shared: Arc<Shared>,
    pub timing: Timing,
    current: Option<Current>,
    queue: VecDeque<Command>,
    updates: Updates,
    /// The system prompt to put in front of the first prompt, when the agent
    /// could not take it on `session/new`.
    pending_system: Option<String>,
}

impl State {
    pub fn new(spec: &'static AgentSpec, shared: Arc<Shared>, timing: Timing) -> Self {
        Self {
            spec,
            shared,
            timing,
            current: None,
            queue: VecDeque::new(),
            updates: Updates::default(),
            pending_system: None,
        }
    }

    /// Answers the running prompt and any queued ones with `error`.
    pub fn fail_all(&mut self, error: &AiError, rx: &mut mpsc::UnboundedReceiver<Command>) {
        self.shared.end_turn();
        if let Some(reply) = self.current.take().and_then(|c| c.reply) {
            let _ = reply.send(Err(error.clone()));
        }
        rx.close();
        let queued: Vec<Command> = self.queue.drain(..).collect();
        let mut rest = Vec::new();
        while let Ok(cmd) = rx.try_recv() {
            rest.push(cmd);
        }
        for cmd in queued.into_iter().chain(rest) {
            if let Command::Prompt { reply, .. } = cmd {
                let _ = reply.send(Err(error.clone()));
            }
        }
    }
}

/// Runs the session over `transport` until it ends. Prompts still waiting
/// afterwards are left in `state` and `rx` for the caller to fail.
pub async fn run(
    transport: impl ConnectTo<Client> + 'static,
    setup: Setup,
    state: &mut State,
    rx: &mut mpsc::UnboundedReceiver<Command>,
) -> Ended {
    let result = Client
        .v1()
        .name("midterm")
        .connect_with(transport, async |cx: ConnectionTo<Agent>| {
            Ok(drive(&cx, setup, state, rx).await)
        })
        .await;
    match result {
        Ok(ended) => ended,
        Err(e) => {
            eprintln!("ai acp: connection ended: {e}");
            Ended::Lost
        }
    }
}

/// Startup's outcome: the session and what it supports.
struct Started {
    session: ActiveSession<'static, Agent>,
    can_close: bool,
}

/// Resolves when the agent's side of the connection is gone.
async fn gone(cx: &ConnectionTo<Agent>) {
    tokio::select! {
        _ = cx.incoming_closed() => {}
        _ = cx.terminated() => {}
    }
}

async fn drive(
    cx: &ConnectionTo<Agent>,
    setup: Setup,
    state: &mut State,
    rx: &mut mpsc::UnboundedReceiver<Command>,
) -> Ended {
    let timing = state.timing;
    let shared = state.shared.clone();
    let spec = state.spec;
    // Startup, while queueing what arrives meanwhile (a close ends it).
    let started = {
        let startup = tokio::time::timeout(timing.startup, start(cx, setup, &shared));
        tokio::pin!(startup);
        loop {
            tokio::select! {
                result = &mut startup => break result,
                cmd = rx.recv() => match cmd {
                    None | Some(Command::Close) => return Ended::Closed,
                    Some(cmd) => state.queue.push_back(cmd),
                },
                _ = gone(cx) => return Ended::Lost,
            }
        }
    };
    let (started, pending_system) = match started {
        Err(_) => {
            return Ended::Failed(AiError::new(
                ErrorKind::Timeout,
                format!(
                    "{} did not start within {} s",
                    spec.adapter,
                    timing.startup.as_secs()
                ),
            ));
        }
        Ok(Err(_)) if cx.termination().is_some() || cx.is_incoming_closed() => return Ended::Lost,
        Ok(Err(e)) => return Ended::Failed(e),
        Ok(Ok(started)) => started,
    };
    state.pending_system = pending_system;
    let Started {
        mut session,
        can_close,
    } = started;

    let mut ticker = tokio::time::interval(Duration::from_millis(250));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let next = match state.queue.pop_front() {
            Some(cmd) => Some(cmd),
            None => tokio::select! {
                cmd = rx.recv() => Some(cmd.unwrap_or(Command::Close)),
                message = session.read_update() => {
                    shared.touch();
                    match message {
                        Ok(message) => on_message(state, message),
                        Err(e) => {
                            eprintln!("ai acp: session channel failed: {e}");
                            return Ended::Lost;
                        }
                    }
                    None
                }
                _ = ticker.tick() => {
                    if let Some(ended) = watchdog(state) {
                        return ended;
                    }
                    None
                }
                _ = gone(cx) => return Ended::Lost,
            },
        };
        let Some(cmd) = next else { continue };
        match cmd {
            Command::Close => {
                if can_close {
                    let close = cx
                        .send_request(CloseSessionRequest::new(session.session_id().clone()))
                        .block_task();
                    if let Ok(Err(e)) = tokio::time::timeout(timing.close_grace, close).await {
                        eprintln!("ai acp: session/close failed: {e}");
                    }
                }
                return Ended::Closed;
            }
            Command::Prompt {
                turn,
                text,
                emit,
                reply,
            } => {
                if reply.is_closed() {
                    continue; // cancelled before it started
                }
                if state.current.is_some() {
                    let _ = reply.send(Err(AiError::other(
                        "the agent is still answering the previous message",
                    )));
                    continue;
                }
                let mut text = spec.prompt_text(&text);
                if let Some(system) = state.pending_system.take() {
                    text = cli::combined_prompt(&system, &text);
                }
                shared.start_turn(turn, emit);
                state.current = Some(Current {
                    turn,
                    reply: Some(reply),
                    cancelled: false,
                    cancel_deadline: None,
                    idle: timing.idle,
                });
                if let Err(e) = session.send_prompt_blocks(vec![ContentBlock::from(text)]) {
                    let error = acp_error(spec, &e);
                    finish(state, Err(error));
                }
            }
            Command::Cancel { turn } => {
                let Some(current) = state.current.as_mut() else {
                    continue;
                };
                if current.turn != turn || current.cancelled {
                    continue;
                }
                current.cancelled = true;
                current.cancel_deadline = Some(tokio::time::Instant::now() + timing.cancel_grace);
                shared.cancel_turn(turn);
                let _ = cx.send_notification(CancelNotification::new(session.session_id().clone()));
            }
        }
    }
}

/// Ends the running prompt with `result`.
fn finish(state: &mut State, result: Result<Stop, AiError>) {
    state.shared.end_turn();
    if let Some(mut current) = state.current.take()
        && let Some(reply) = current.reply.take()
    {
        let result = if current.cancelled {
            Ok(Stop::Cancelled)
        } else {
            result
        };
        let _ = reply.send(result);
    }
}

/// Gives up on a prompt that went quiet or ignored its cancel.
fn watchdog(state: &mut State) -> Option<Ended> {
    let current = state.current.as_ref()?;
    if let Some(deadline) = current.cancel_deadline {
        if tokio::time::Instant::now() >= deadline {
            eprintln!("ai acp: a cancelled prompt did not settle; killing the session");
            return Some(Ended::Failed(AiError::cancelled()));
        }
        return None;
    }
    if !state.shared.awaiting() && state.shared.idle_for() > current.idle {
        return Some(Ended::Failed(AiError::new(
            ErrorKind::Timeout,
            format!("the agent sent nothing for {} s", current.idle.as_secs()),
        )));
    }
    None
}

fn on_message(state: &mut State, message: SessionMessage) {
    match message {
        SessionMessage::PromptResponse(result) => {
            if state.current.is_none() {
                return;
            }
            // The connection went away: the session's end reports it, with
            // what the adapter said.
            if let Err(e) = &result
                && (agent_client_protocol::is_incoming_transport_closed(e)
                    || agent_client_protocol::is_connection_terminated(e))
            {
                return;
            }
            let result = match result {
                Ok(response) => {
                    let reason = serde_json::to_value(response.stop_reason)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_default();
                    Ok(stop(&reason))
                }
                Err(e) => Err(acp_error(state.spec, &e)),
            };
            finish(state, result);
        }
        SessionMessage::Message(dispatch) => match dispatch {
            Dispatch::Notification(message) => {
                if message.method() != "session/update" {
                    return;
                }
                let Some(update) = message.params().get("update") else {
                    return;
                };
                for event in state.updates.map(state.spec, update) {
                    state.shared.emit(event);
                }
            }
            Dispatch::Request(message, responder) => {
                if message.method() != "session/request_permission" {
                    let _ = responder
                        .respond_with_error(agent_client_protocol::Error::method_not_found());
                    return;
                }
                let params = message.params();
                let cancelled = state.current.as_ref().is_none_or(|c| c.cancelled);
                let (answer, allowed) = permission(state.spec, params, cancelled);
                let tool_call = params.get("toolCall").unwrap_or(&Value::Null);
                if !allowed
                    && !state.spec.is_ours(tool_call)
                    && let Some(event) = state.updates.denied(tool_call)
                {
                    state.shared.emit(event);
                }
                let _ = responder.respond(answer);
            }
            Dispatch::Response(..) => {}
        },
        _ => {}
    }
}

/// `initialize`, `session/new` and the config options. Returns the session
/// and the system prompt still to be sent (when `session/new` could not
/// take it).
async fn start(
    cx: &ConnectionTo<Agent>,
    setup: Setup,
    shared: &Arc<Shared>,
) -> Result<(Started, Option<String>), AiError> {
    let spec = setup.spec;
    let failed = |e: agent_client_protocol::Error| acp_error(spec, &e);
    let init: InitializeResponse = cx
        .send_request(
            InitializeRequest::new(ProtocolVersion::V1)
                .client_capabilities(ClientCapabilities::new())
                .client_info(Implementation::new("midterm", env!("CARGO_PKG_VERSION"))),
        )
        .block_task()
        .await
        .map_err(failed)?;
    let caps = &init.agent_capabilities;
    if !caps.mcp_capabilities.acp {
        return Err(AiError::other(format!(
            "{} does not support MCP-over-ACP, which the agent needs. Update it with `{}`.",
            spec.adapter,
            spec.install_hint()
        )));
    }
    let system = cli::system_or_default(&setup.system).to_string();
    let (mode, pending_system) = match &caps.session_capabilities.system_prompt {
        Some(sp) if sp.mode.as_ref().is_some_and(|m| m.override_.is_some()) => {
            (Some(SystemPromptMode::Override), None)
        }
        Some(_) => (Some(SystemPromptMode::Append), None),
        None => (None, Some(system.clone())),
    };
    let can_close = caps.session_capabilities.close.is_some();

    let mut request =
        NewSessionRequest::new(setup.cwd.clone()).meta(spec.session_meta(&setup.tools));
    if let Some(mode) = mode {
        request =
            request.system_prompt(SystemPrompt::new(vec![ContentBlock::from(system)]).mode(mode));
    }
    let tools = Tools {
        defs: Arc::new(setup.tools),
        shared: shared.clone(),
    };
    let server = McpServer::new_service(SERVER_NAME, tools, NullRun);
    let SessionSetup {
        session, response, ..
    } = cx
        .build_session_from(request)
        .with_mcp_server(server)
        .map_err(failed)?
        .block_task()
        .start_session()
        .await
        .map_err(failed)?;
    let session_id = session.session_id().clone();

    let mut options: Vec<SessionConfigOption> = response.config_options.unwrap_or_default();
    let set = async |options: &mut Vec<SessionConfigOption>, (id, value): agents::Pick| {
        let response = cx
            .send_request(SetSessionConfigOptionRequest::new(
                session_id.clone(),
                id.clone(),
                SessionConfigValueId::new(value.clone()),
            ))
            .block_task()
            .await
            .map_err(|e| {
                let e = acp_error(spec, &e);
                AiError::new(
                    e.kind,
                    format!("could not set {id} to {value}: {}", e.message),
                )
            })?;
        if !response.config_options.is_empty() {
            *options = response.config_options;
        }
        Ok::<(), AiError>(())
    };
    if let Some(mode) = spec.mode()
        && let Some(pick) = agents::pick_mode(&options, mode)
    {
        set(&mut options, pick).await?;
    }
    if let Some(pick) = agents::pick_model(&options, &setup.model)? {
        set(&mut options, pick).await?;
    }
    if let Some(pick) = agents::pick_effort(&options, spec.kind, &setup.model, setup.effort) {
        set(&mut options, pick).await?;
    }
    Ok((Started { session, can_close }, pending_system))
}

/// Lines of adapter logging left out of a death message.
fn is_log_line(line: &str) -> bool {
    let line = line.trim_start();
    line.starts_with("[session/") || line.starts_with("[authStatus]")
}

/// The error for an adapter that died: the end of its stderr.
pub fn death_error(spec: &AgentSpec, code: Option<i32>, stderr: &str) -> AiError {
    let said: String = stderr
        .lines()
        .filter(|l| !is_log_line(l))
        .collect::<Vec<_>>()
        .join("\n");
    let output = Output {
        success: false,
        code,
        stdout: String::new(),
        stderr: said,
    };
    let mut error = cli::failure_error_named(spec.adapter, &output);
    if error.kind == ErrorKind::Auth {
        error.message = format!("{} {}", error.message, spec.sign_in_hint());
    }
    error
}

/// Runs a session over a spawned adapter's stdio, then shuts the process
/// down (its whole group) and answers whatever is still waiting.
pub async fn run_process(
    child: LongChild,
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    setup: Setup,
    mut state: State,
    mut rx: mpsc::UnboundedReceiver<Command>,
    dir: tempfile::TempDir,
) {
    let spec = state.spec;
    let grace = state.timing.close_grace;
    let transport = ByteStreams::new(stdin.compat_write(), stdout.compat());
    // Dropping the transport at the end closes the adapter's stdin.
    let ended = run(transport, setup, &mut state, &mut rx).await;
    let wait = match ended {
        Ended::Closed | Ended::Lost => grace,
        Ended::Failed(_) => Duration::ZERO,
    };
    let (code, stderr) = child.shutdown(wait).await;
    let error = match ended {
        Ended::Closed => AiError::other("the agent session was closed"),
        // A request that failed because the adapter exited (it was not
        // killed: it has an exit code) is that exit.
        Ended::Failed(_) if code.is_some() => death_error(spec, code, &stderr),
        Ended::Failed(e) => e,
        Ended::Lost => death_error(spec, code, &stderr),
    };
    state.fail_all(&error, &mut rx);
    drop(dir);
}
