//! The agent over ACP (MID-80): CLI profiles run as long-lived Agent Client
//! Protocol sessions. The CLI runs the tool loop; Midterm supplies the
//! system prompt, its tools (served as the MCP server `midterm` over the
//! same connection) and the confirmations (in the webview, inside each tool
//! call). See `docs/ai.md` (ACP sessions).
//!
//! One adapter process per conversation, in its own process group, with a
//! fresh empty temporary directory as the session's working directory. The
//! process is killed with its group on close, when its window closes or
//! reloads, on app exit, and when its task is dropped.

pub mod agents;
pub mod session;
pub mod tools;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

use self::agents::AgentSpec;
use self::session::{Command, Setup, State, Timing};
use self::tools::{Emit, Shared, ToolOutcome};
use super::agent::ToolDef;
use super::cli::Discovery;
use super::effort;
use super::error::AiError;
use super::process::{GroupHandle, LongChild, Spawn};
use super::provider::{Backend, ProviderId, Target};

/// A message on `ai_acp_prompt`'s channel.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AcpEvent {
    /// More reply text: append it.
    Text { text: String },
    /// The agent called one of Midterm's tools: run it and answer with
    /// `ai_acp_tool_result`. `name` is the tool's own name (no
    /// `mcp__midterm__` prefix).
    ToolCall {
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        input: serde_json::Value,
    },
    /// The agent withdrew a `toolCall` before its result: drop it (decline
    /// a pending confirmation, do not run the tool, send no result).
    ToolCallCancelled {
        #[serde(rename = "callId")]
        call_id: String,
    },
    /// This prompt starts a new session (sent first). For a conversation
    /// that had one, the earlier context is gone: its session was evicted,
    /// failed or ended with its window.
    SessionStarted,
    /// A tool call that is not Midterm's (shown muted; it should not happen).
    ForeignTool {
        id: String,
        title: String,
        status: ForeignStatus,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ForeignStatus {
    Running,
    Done,
    Failed,
    Denied,
}

/// Why a prompt ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stop {
    End,
    Length,
    Refused,
    MaxRequests,
    Cancelled,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpReply {
    pub stop: Stop,
}

/// The most sessions alive at once; opening another closes the oldest idle.
pub const MAX_SESSIONS: usize = 8;

/// How long `ai_acp_close` waits for a session to shut down.
const CLOSE_WAIT: Duration = Duration::from_secs(6);

struct Handle {
    owner: String,
    tx: mpsc::UnboundedSender<Command>,
    shared: Arc<Shared>,
    group: GroupHandle,
    last_used: Instant,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Handle {
    fn alive(&self) -> bool {
        !self.tx.is_closed()
    }
}

/// Every adapter process not yet reaped, with its working directory, by
/// spawn number. A session leaves `sessions` when it is closed, but stays
/// here until its task has shut the process down and removed the directory,
/// so app exit still finds it.
type Processes = Arc<Mutex<HashMap<u64, (GroupHandle, PathBuf)>>>;

/// The live sessions, keyed by conversation id and owned by a window label.
pub struct AcpManager {
    sessions: Mutex<HashMap<String, Handle>>,
    processes: Processes,
    next_turn: AtomicU64,
    next_process: AtomicU64,
    pub timing: Timing,
}

impl Default for AcpManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            processes: Arc::default(),
            next_turn: AtomicU64::new(1),
            next_process: AtomicU64::new(1),
            timing: Timing::default(),
        }
    }
}

/// Sends `Cancel` for its turn when dropped (the prompt's caller went away),
/// unless disarmed.
struct CancelGuard {
    tx: mpsc::UnboundedSender<Command>,
    turn: u64,
    armed: bool,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.tx.send(Command::Cancel { turn: self.turn });
        }
    }
}

/// What a new session needs besides the setup.
pub struct Launch {
    pub spawn: Spawn,
    pub dir: tempfile::TempDir,
}

impl AcpManager {
    /// One prompt in `conversation`'s session, creating the session (with
    /// `system` and `tools`) on its first prompt. Events go to `emit`.
    #[allow(clippy::too_many_arguments)]
    pub async fn prompt(
        &self,
        discovery: &Discovery,
        owner: &str,
        conversation: &str,
        target: &Target,
        system: &str,
        tools: &[ToolDef],
        text: &str,
        emit: Emit,
    ) -> Result<Stop, AiError> {
        let Backend::Cli(kind) = target.provider.id.backend() else {
            return Err(AiError::other(
                "ACP sessions are for CLI models; API models use ai_agent_turn",
            ));
        };
        let spec = agents::spec(kind).ok_or_else(|| agents::unsupported(kind))?;
        let tx = match self.live(conversation) {
            Some(tx) => tx,
            None => {
                let launch = launch(discovery, spec, target).await?;
                let setup = Setup {
                    spec,
                    cwd: launch
                        .spawn
                        .cwd
                        .clone()
                        .unwrap_or_else(|| launch.dir.path().to_path_buf()),
                    system: system.to_string(),
                    tools: tools.to_vec(),
                    model: target.model.trim().to_string(),
                    effort: target.effort,
                };
                let tx = self.start(owner, conversation, setup, launch, target)?;
                emit(AcpEvent::SessionStarted);
                tx
            }
        };
        self.send_prompt(tx, text, emit).await
    }

    async fn send_prompt(
        &self,
        tx: mpsc::UnboundedSender<Command>,
        text: &str,
        emit: Emit,
    ) -> Result<Stop, AiError> {
        let turn = self.next_turn.fetch_add(1, Ordering::SeqCst);
        let (reply, rx) = oneshot::channel();
        let ended = || AiError::other("the agent session ended");
        tx.send(Command::Prompt {
            turn,
            text: text.to_string(),
            emit,
            reply,
        })
        .map_err(|_| ended())?;
        let mut guard = CancelGuard {
            tx,
            turn,
            armed: true,
        };
        let result = rx.await.map_err(|_| ended());
        guard.armed = false;
        result?
    }

    /// The live session's command sender, marking it used. A dead one is
    /// dropped, so the next prompt starts fresh.
    fn live(&self, conversation: &str) -> Option<mpsc::UnboundedSender<Command>> {
        let mut sessions = self.sessions.lock().unwrap();
        match sessions.get_mut(conversation) {
            Some(handle) if handle.alive() => {
                handle.last_used = Instant::now();
                Some(handle.tx.clone())
            }
            Some(_) => {
                sessions.remove(conversation);
                None
            }
            None => None,
        }
    }

    /// Spawns the session task for a launched process.
    fn start(
        &self,
        owner: &str,
        conversation: &str,
        setup: Setup,
        launch: Launch,
        target: &Target,
    ) -> Result<mpsc::UnboundedSender<Command>, AiError> {
        let spec = setup.spec;
        let (child, stdin, stdout) = LongChild::spawn(launch.spawn)?;
        let group = child.group();
        let shared = Arc::new(Shared::default());
        let mut timing = self.timing;
        timing.idle = effort::scaled(timing.idle, &resolved(spec, target));
        let state = State::new(spec, shared.clone(), timing);
        let (tx, rx) = mpsc::unbounded_channel();
        let dir = launch.dir.path().to_path_buf();
        let id = self.next_process.fetch_add(1, Ordering::SeqCst);
        self.processes
            .lock()
            .unwrap()
            .insert(id, (group.clone(), dir.clone()));
        let processes = self.processes.clone();
        let task = tokio::spawn(async move {
            session::run_process(child, stdin, stdout, setup, state, rx, launch.dir).await;
            processes.lock().unwrap().remove(&id);
        });
        let handle = Handle {
            owner: owner.to_string(),
            tx: tx.clone(),
            shared,
            group,
            last_used: Instant::now(),
            task: Some(task),
        };
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, h| h.alive());
        if let Some(existing) = sessions.get(conversation)
            && existing.alive()
        {
            // Another prompt for the conversation won the race; use its session.
            let _ = handle.tx.send(Command::Close);
            return Ok(existing.tx.clone());
        }
        while sessions.len() >= MAX_SESSIONS {
            let oldest = sessions
                .iter()
                .filter(|(_, h)| !h.shared.busy())
                .min_by_key(|(_, h)| h.last_used)
                .map(|(id, _)| id.clone());
            let Some(oldest) = oldest else {
                let _ = handle.tx.send(Command::Close);
                return Err(AiError::other(format!(
                    "{MAX_SESSIONS} agent sessions are already answering; try again when one finishes"
                )));
            };
            if let Some(old) = sessions.remove(&oldest) {
                let _ = old.tx.send(Command::Close);
            }
        }
        sessions.insert(conversation.to_string(), handle);
        Ok(tx)
    }

    /// Delivers a tool result. Unknown conversations and calls (finished or
    /// cancelled) are ignored.
    pub fn tool_result(&self, conversation: &str, call_id: &str, content: String, is_error: bool) {
        let shared = self
            .sessions
            .lock()
            .unwrap()
            .get(conversation)
            .map(|h| h.shared.clone());
        if let Some(shared) = shared {
            shared.deliver(call_id, ToolOutcome { content, is_error });
        }
    }

    /// Closes a conversation's session and waits (briefly) for its process
    /// to go. No session: nothing happens.
    pub async fn close(&self, conversation: &str) {
        let handle = self.sessions.lock().unwrap().remove(conversation);
        let Some(mut handle) = handle else { return };
        let _ = handle.tx.send(Command::Close);
        if let Some(task) = handle.task.take()
            && tokio::time::timeout(CLOSE_WAIT, task).await.is_err()
        {
            handle.group.kill();
        }
    }

    /// Closes the sessions a window owns (it closed or reloaded).
    pub fn close_owned_by(&self, owner: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        let ids: Vec<String> = sessions
            .iter()
            .filter(|(_, h)| h.owner == owner)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(handle) = sessions.remove(&id) {
                let _ = handle.tx.send(Command::Close);
            }
        }
    }

    /// App exit: kills every adapter's process group now, sessions still
    /// shutting down included, and removes the working directories (the
    /// tasks may never run again).
    pub fn close_all(&self) {
        let handles: Vec<Handle> = self
            .sessions
            .lock()
            .unwrap()
            .drain()
            .map(|(_, h)| h)
            .collect();
        for handle in handles {
            let _ = handle.tx.send(Command::Close);
        }
        let processes: Vec<(GroupHandle, PathBuf)> = self
            .processes
            .lock()
            .unwrap()
            .drain()
            .map(|(_, p)| p)
            .collect();
        for (group, dir) in processes {
            group.kill();
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[cfg(test)]
    fn count(&self) -> usize {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .filter(|h| h.alive())
            .count()
    }
}

/// The effort the session runs at (for the idle limit).
fn resolved(spec: &AgentSpec, target: &Target) -> effort::Resolved {
    let provider = match spec.kind {
        super::provider::CliKind::ClaudeCode => ProviderId::ClaudeCode,
        super::provider::CliKind::Codex => ProviderId::Codex,
        super::provider::CliKind::Antigravity => ProviderId::Antigravity,
    };
    effort::resolve(provider, target.model.trim(), None, target.effort)
}

/// Finds the adapter and the CLI, and prepares the process and its working
/// directory. Nothing is installed or fetched (no `npx`).
async fn launch(
    discovery: &Discovery,
    spec: &AgentSpec,
    target: &Target,
) -> Result<Launch, AiError> {
    let provider = &target.provider;
    // `MIDTERM_ACP_STUB` (debug and `dev:mcp` builds): another command in
    // place of the adapter, and no CLI.
    let (program, args, cli) = match agents::stub_command() {
        Some(mut command) => {
            let program = discovery.locate_named(&command.remove(0), None).await?;
            (
                program,
                command.into_iter().map(OsString::from).collect(),
                None,
            )
        }
        None => {
            let adapter = discovery
                .locate_named(spec.adapter, provider.acp_path())
                .await
                .map_err(|e| match provider.acp_path() {
                    Some(_) => e,
                    None => AiError::new(
                        e.kind,
                        format!(
                            "{} is not on the login shell's PATH. Install it with `{}`.",
                            spec.adapter,
                            spec.install_hint()
                        ),
                    ),
                })?;
            let cli = discovery.locate(spec.kind, provider.cli_path()).await?;
            (adapter, Vec::new(), Some(cli))
        }
    };
    let dir = tempfile::Builder::new()
        .prefix("midterm-agent-")
        .tempdir()
        .map_err(|e| AiError::other(format!("could not create a temporary directory: {e}")))?;
    // The canonical path: macOS's /var is a symlink, and the agent compares
    // paths it is given with the ones it sees.
    let cwd = dir
        .path()
        .canonicalize()
        .unwrap_or_else(|_| dir.path().to_path_buf());
    let mut env: Vec<(OsString, OsString)> = vec![
        ("PATH".into(), discovery.path_var().await.into()),
        ("NO_COLOR".into(), "1".into()),
    ];
    if let Some(cli) = &cli {
        env.extend(spec.env(cli));
    }
    Ok(Launch {
        spawn: Spawn {
            program,
            args,
            cwd: Some(cwd),
            env,
            env_remove: spec.env_remove(),
        },
        dir,
    })
}
