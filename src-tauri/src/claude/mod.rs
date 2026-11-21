//! The Claude Code bridge: one Node process per window (the bundled
//! `claude-bridge.mjs`, see docs/claude-code.md) that runs the Agent SDK.
//! This module does no protocol logic. It starts the process, forwards each
//! stdout line to the webview's channel, writes the webview's lines to its
//! stdin, and kills its whole process group (the `claude` processes it
//! started) when the window reloads or closes, or the app exits.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State, Window};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::ai::process::{GroupHandle, LongChild, Spawn};
use crate::ai::{shell_path, AiError, AiManager, ErrorKind};

/// The oldest Node the bridge runs on (the bundle imports `isUtf8` from
/// `buffer`, added in 18.14.0).
const MIN_NODE: [u32; 3] = [18, 14, 0];

/// How long the bridge gets to exit by itself once its stdin is closed.
const GRACE: Duration = Duration::from_millis(300);

/// Variables that make Claude Code refuse to start "inside another session".
const ENV_REMOVE: &[&str] = &["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub node: String,
    pub claude: Option<String>,
}

struct Bridge {
    generation: u64,
    /// Lines for the writer task, which owns the child's stdin.
    tx: mpsc::UnboundedSender<String>,
    group: GroupHandle,
    /// Tells the reader task to shut the child down.
    close: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct Registry {
    bridges: HashMap<String, Bridge>,
    /// The newest generation reserved per window. An open that finds a
    /// newer one when it is ready to install was cancelled (the page
    /// reloaded or the window closed while it was locating `node`).
    latest: HashMap<String, u64>,
    /// Groups of bridges that are shutting down, until they are reaped, so
    /// app exit can still kill them.
    closing: HashMap<u64, GroupHandle>,
}

#[derive(Default)]
pub struct ClaudeManager {
    state: Arc<Mutex<Registry>>,
    generation: AtomicU64,
}

impl ClaudeManager {
    fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Ends a window's bridge (its page reloaded or it closed) and cancels
    /// an open still in progress.
    pub fn close_owned_by(&self, owner: &str) {
        let generation = self.next_generation();
        let mut state = self.state.lock().unwrap();
        state.latest.insert(owner.to_string(), generation);
        if let Some(mut bridge) = state.bridges.remove(owner) {
            state
                .closing
                .insert(bridge.generation, bridge.group.clone());
            if let Some(close) = bridge.close.take() {
                let _ = close.send(());
            }
        }
    }

    /// App exit: kills every bridge's process group now, those still shutting
    /// down included; the tasks may never run again.
    pub fn close_all(&self) {
        let mut state = self.state.lock().unwrap();
        for (_, bridge) in state.bridges.drain() {
            bridge.group.kill();
        }
        for (_, group) in state.closing.drain() {
            group.kill();
        }
    }
}

/// The version of `node --version` output (`v20.11.1`) is at least [`MIN_NODE`].
fn check_node_version(line: Option<&str>) -> Result<(), AiError> {
    let Some(line) = line else {
        return Err(AiError::other(
            "Claude Code needs Node.js 18.14 or later; could not run `node --version`",
        ));
    };
    match crate::ai::cli::parse_version(line) {
        Some(version) if version >= MIN_NODE => Ok(()),
        _ => Err(AiError::other(format!(
            "Claude Code needs Node.js 18.14 or later; found {}",
            line.trim()
        ))),
    }
}

/// The bridge's environment: the login shell's PATH and the `claude` to use.
fn bridge_env(path_var: &str, claude: &std::path::Path) -> Vec<(OsString, OsString)> {
    vec![
        ("PATH".into(), path_var.into()),
        ("MIDTERM_CLAUDE_PATH".into(), claude.into()),
    ]
}

/// The final line sent to the webview when the bridge ends by itself.
fn exit_line(code: Option<i32>, stderr: &str) -> String {
    serde_json::json!({ "event": "bridgeExit", "code": code, "stderr": stderr }).to_string()
}

/// Debug builds run the script from the source tree, so `bun run
/// build:bridge` takes effect without a cargo rebuild; release builds read
/// it from the app's resources.
fn bridge_script(window: &Window) -> Result<PathBuf, AiError> {
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/claude-bridge.mjs"
        )));
    }
    window
        .path()
        .resolve(
            "resources/claude-bridge.mjs",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| AiError::other(format!("could not find the Claude Code bridge: {e}")))
}

#[tauri::command]
pub async fn claude_bridge_open(
    window: Window,
    on_event: Channel<String>,
    claude_path: Option<String>,
    node_path: Option<String>,
    ai: State<'_, AiManager>,
    manager: State<'_, ClaudeManager>,
) -> Result<BridgeInfo, AiError> {
    let label = window.label().to_string();
    // Replaces the window's bridge, and reserves this open's generation
    // before the first await so a later close or open supersedes it.
    manager.close_owned_by(&label);
    let generation = manager.state.lock().unwrap().latest[&label];

    let discovery = ai.discovery();
    let node = discovery
        .locate_named("node", node_path.as_deref().filter(|p| !p.is_empty()))
        .await
        .map_err(|e| {
            AiError::new(
                ErrorKind::NotFound,
                format!(
                    "Claude Code needs Node.js 18.14 or later, but {}",
                    e.message
                ),
            )
        })?;
    check_node_version(discovery.version_line(node.clone()).await.as_deref())?;
    let claude = discovery
        .locate_named("claude", claude_path.as_deref().filter(|p| !p.is_empty()))
        .await
        .map_err(|e| match claude_path.as_deref().filter(|p| !p.is_empty()) {
            Some(_) => e,
            None => AiError::new(
                ErrorKind::NotFound,
                "`claude` was not found on the login shell's PATH. Install Claude Code, or set its path in Settings → Plugins → Claude Code.",
            ),
        })?;

    let script = bridge_script(&window)?;
    let (child, mut stdin, stdout) = LongChild::spawn(Spawn {
        program: node.clone(),
        args: vec![script.into_os_string()],
        cwd: shell_path::home_dir(),
        env: bridge_env(discovery.path_var().await, &claude),
        env_remove: ENV_REMOVE.to_vec(),
    })?;
    let group = child.group();

    // Commands never wait on a full pipe: a task owns stdin.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(mut line) = rx.recv().await {
            line.push('\n');
            if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                break;
            }
        }
    });

    let (close_tx, close_rx) = oneshot::channel();
    {
        let mut state = manager.state.lock().unwrap();
        if state.latest.get(&label) != Some(&generation) {
            // Cancelled while starting: the child dies with `child` (its
            // group is killed on drop).
            writer.abort();
            return Err(AiError::cancelled());
        }
        state.bridges.insert(
            label.clone(),
            Bridge {
                generation,
                tx,
                group,
                close: Some(close_tx),
            },
        );
    }
    tokio::spawn(pump(
        child,
        stdout,
        writer,
        close_rx,
        on_event,
        manager.state.clone(),
        label,
        generation,
    ));

    Ok(BridgeInfo {
        node: node.to_string_lossy().into_owned(),
        claude: Some(claude.to_string_lossy().into_owned()),
    })
}

/// Forwards stdout lines until the bridge ends or is closed, then shuts the
/// child down (and, if it ended by itself, reports how).
#[allow(clippy::too_many_arguments)]
async fn pump(
    child: LongChild,
    stdout: tokio::process::ChildStdout,
    writer: tokio::task::JoinHandle<()>,
    mut close: oneshot::Receiver<()>,
    on_event: Channel<String>,
    state: Arc<Mutex<Registry>>,
    label: String,
    generation: u64,
) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    // Lines can be several MB (tool results), so they are not capped.
    let closed = loop {
        buf.clear();
        tokio::select! {
            _ = &mut close => break true,
            read = reader.read_until(b'\n', &mut buf) => match read {
                Ok(0) | Err(_) => break false,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf);
                    let line = text.trim_end_matches(['\n', '\r']);
                    if !line.is_empty() && on_event.send(line.to_string()).is_err() {
                        // The webview is gone.
                        break true;
                    }
                }
            },
        }
    };
    // Dropping the writer closes stdin, which lets the bridge exit.
    writer.abort();
    let _ = writer.await;
    let (code, stderr) = child.shutdown(GRACE).await;
    {
        let mut state = state.lock().unwrap();
        state.closing.remove(&generation);
        if state
            .bridges
            .get(&label)
            .is_some_and(|b| b.generation == generation)
        {
            state.bridges.remove(&label);
        }
    }
    if !closed {
        let _ = on_event.send(exit_line(code, &stderr));
    }
}

#[tauri::command]
pub fn claude_bridge_send(
    window: Window,
    line: String,
    manager: State<'_, ClaudeManager>,
) -> Result<(), AiError> {
    let state = manager.state.lock().unwrap();
    let bridge = state
        .bridges
        .get(window.label())
        .ok_or_else(|| AiError::other("The Claude Code bridge is not running."))?;
    bridge
        .tx
        .send(line)
        .map_err(|_| AiError::other("The Claude Code bridge is not running."))
}

#[tauri::command]
pub fn claude_bridge_close(window: Window, manager: State<'_, ClaudeManager>) {
    manager.close_owned_by(window.label());
}

#[cfg(test)]
mod tests;
