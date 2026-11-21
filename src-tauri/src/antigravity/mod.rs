//! The Antigravity ACP transport: one `agy acp` process per pane session (MID-104).
//!
//! This module does no ACP protocol logic. It locates `agy` on the login shell's
//! PATH (or an override from plugin settings), spawns `agy acp` in its own
//! process group, forwards each stdout JSON-RPC line to the webview's channel,
//! writes the webview's lines to stdin, and kills the whole process group when
//! the session closes, the window reloads or closes, or the app exits.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{State, Window};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::ai::process::{GroupHandle, LongChild, Spawn};
use crate::ai::{shell_path, AiError, AiManager, ErrorKind};

/// How long `agy acp` gets to exit on its own once stdin is closed.
const GRACE: Duration = Duration::from_millis(300);

/// Maximum size of a single JSON-RPC line from `agy acp` (64 MiB). Prevents a
/// runaway or misconfigured binary from exhausting host memory.
const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

/// Synthetic JSON-RPC notification method sent when the process exits by itself.
pub const EXIT_METHOD: &str = "$/midterm/exit";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpOpenInfo {
    pub agy: String,
    pub version: Option<String>,
}

struct Connection {
    owner: String,
    generation: u64,
    tx: mpsc::UnboundedSender<String>,
    group: GroupHandle,
    close: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct Registry {
    connections: HashMap<String, Connection>,
    /// Bumped on every `close_owned_by` so opens in flight for a reloaded/closed
    /// window are cancelled before they can register.
    window_gen: HashMap<String, u64>,
    /// Newest generation reserved per `conn_id` (cancelled if closed/replaced
    /// while locating `agy`).
    conn_gen: HashMap<String, u64>,
    /// Process groups currently shutting down, until reaped, so `close_all`
    /// still reaches them on app exit.
    closing: HashMap<u64, GroupHandle>,
}

#[derive(Default)]
pub struct AntigravityManager {
    state: Arc<Mutex<Registry>>,
    generation: AtomicU64,
}

impl AntigravityManager {
    fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Closes one connection owned by `owner` and cancels any open in flight
    /// for `conn_id`.
    pub fn close_connection(&self, owner: &str, conn_id: &str) {
        let generation = self.next_generation();
        let mut state = self.state.lock().unwrap();
        state.conn_gen.insert(conn_id.to_string(), generation);
        let owned = state
            .connections
            .get(conn_id)
            .is_some_and(|c| c.owner == owner);
        if owned && let Some(mut conn) = state.connections.remove(conn_id) {
            state.closing.insert(conn.generation, conn.group.clone());
            if let Some(close) = conn.close.take() {
                let _ = close.send(());
            }
        }
    }

    /// Ends every connection owned by a window (it reloaded or closed) and
    /// cancels any opens still in flight for that window.
    pub fn close_owned_by(&self, owner: &str) {
        let generation = self.next_generation();
        let mut state = self.state.lock().unwrap();
        state.window_gen.insert(owner.to_string(), generation);
        let ids: Vec<String> = state
            .connections
            .iter()
            .filter(|(_, conn)| conn.owner == owner)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(mut conn) = state.connections.remove(&id) {
                state.closing.insert(conn.generation, conn.group.clone());
                if let Some(close) = conn.close.take() {
                    let _ = close.send(());
                }
            }
        }
    }

    /// App exit: kills every process group now, those still shutting down
    /// included; async tasks may never run again.
    pub fn close_all(&self) {
        let mut state = self.state.lock().unwrap();
        for (_, conn) in state.connections.drain() {
            conn.group.kill();
        }
        for (_, group) in state.closing.drain() {
            group.kill();
        }
    }
}

/// Builds the CLI arguments for `agy acp`.
pub fn build_agy_acp_args(
    sandbox: bool,
    agent: Option<&str>,
    additional_dirs: &[String],
) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["acp".into()];
    if sandbox {
        args.push("--sandbox".into());
    }
    if let Some(agent) = agent.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--agent".into());
        args.push(agent.into());
    }
    for dir in additional_dirs {
        let dir = dir.trim();
        if !dir.is_empty() {
            args.push("--add-dir".into());
            args.push(dir.into());
        }
    }
    args
}

/// Environment passed to `agy acp`: login shell PATH and `NO_COLOR=1`.
pub fn acp_env(path_var: &str) -> Vec<(OsString, OsString)> {
    vec![
        ("PATH".into(), path_var.into()),
        ("NO_COLOR".into(), "1".into()),
    ]
}

/// Synthetic JSON-RPC notification emitted when `agy acp` exits on its own.
pub fn exit_line(code: Option<i32>, stderr: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": EXIT_METHOD,
        "params": { "code": code, "stderr": stderr }
    })
    .to_string()
}

/// Resolves the working directory for spawning `agy acp`: `cwd` if it exists as
/// a directory, else the user's home directory.
fn resolve_cwd(cwd: Option<&str>) -> Option<PathBuf> {
    if let Some(dir) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(dir);
        if path.is_dir() {
            return Some(path);
        }
    }
    shell_path::home_dir()
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn antigravity_acp_open(
    window: Window,
    on_event: Channel<String>,
    conn_id: String,
    cwd: Option<String>,
    agy_path: Option<String>,
    sandbox: Option<bool>,
    agent: Option<String>,
    additional_dirs: Option<Vec<String>>,
    ai: State<'_, AiManager>,
    manager: State<'_, AntigravityManager>,
) -> Result<AcpOpenInfo, AiError> {
    let label = window.label().to_string();
    // Replace any existing connection with the same id and reserve a generation
    // before awaiting discovery so a close or page reload supersedes this open.
    manager.close_connection(&label, &conn_id);
    let (generation, expected_window_gen) = {
        let state = manager.state.lock().unwrap();
        let conn_gen = state.conn_gen[&conn_id];
        let win = state.window_gen.get(&label).copied().unwrap_or(0);
        (conn_gen, win)
    };

    let discovery = ai.discovery();
    let agy_override = agy_path.as_deref().map(str::trim).filter(|p| !p.is_empty());
    let agy = discovery
        .locate_named("agy", agy_override)
        .await
        .map_err(|e| match agy_override {
            Some(_) => e,
            None => AiError::new(
                ErrorKind::NotFound,
                "`agy` was not found on the login shell's PATH. Install the Antigravity CLI, or set its path in Settings → Plugins → Antigravity.",
            ),
        })?;
    let version = discovery.version_line(agy.clone()).await;

    let args = build_agy_acp_args(
        sandbox.unwrap_or(false),
        agent.as_deref(),
        additional_dirs.as_deref().unwrap_or(&[]),
    );
    let (child, mut stdin, stdout) = LongChild::spawn(Spawn {
        program: agy.clone(),
        args,
        cwd: resolve_cwd(cwd.as_deref()),
        env: acp_env(discovery.path_var().await),
        env_remove: Vec::new(),
    })?;
    let group = child.group();

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
        let current_window_gen = state.window_gen.get(&label).copied().unwrap_or(0);
        if current_window_gen != expected_window_gen
            || state.conn_gen.get(&conn_id) != Some(&generation)
        {
            // Cancelled while starting: `child`'s Drop kills the process group.
            writer.abort();
            return Err(AiError::cancelled());
        }
        state.connections.insert(
            conn_id.clone(),
            Connection {
                owner: label,
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
        conn_id,
        generation,
    ));

    Ok(AcpOpenInfo {
        agy: agy.to_string_lossy().into_owned(),
        version,
    })
}

enum LineRead {
    Line,
    Eof,
    TooLong,
}

/// Reads up to `\n` into `buf`, stopping early if the line exceeds `limit` bytes.
async fn read_line_bounded<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<LineRead> {
    buf.clear();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(if buf.is_empty() {
                LineRead::Eof
            } else {
                LineRead::Line
            });
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            let take = pos + 1;
            if buf.len() + take > limit {
                reader.consume(take);
                return Ok(LineRead::TooLong);
            }
            buf.extend_from_slice(&available[..take]);
            reader.consume(take);
            return Ok(LineRead::Line);
        }
        let len = available.len();
        if buf.len() + len > limit {
            reader.consume(len);
            return Ok(LineRead::TooLong);
        }
        buf.extend_from_slice(available);
        reader.consume(len);
    }
}

/// Forwards NDJSON lines from `agy acp`'s stdout until closed or EOF, then
/// shuts the process group down and emits [`EXIT_METHOD`] if it ended on its own.
#[allow(clippy::too_many_arguments)]
async fn pump(
    child: LongChild,
    stdout: tokio::process::ChildStdout,
    writer: tokio::task::JoinHandle<()>,
    mut close: oneshot::Receiver<()>,
    on_event: Channel<String>,
    state: Arc<Mutex<Registry>>,
    conn_id: String,
    generation: u64,
) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    let mut overflow = false;
    let closed = loop {
        tokio::select! {
            _ = &mut close => break true,
            read = read_line_bounded(&mut reader, &mut buf, MAX_LINE_BYTES) => match read {
                Ok(LineRead::Eof) | Err(_) => break false,
                Ok(LineRead::TooLong) => {
                    overflow = true;
                    break false;
                }
                Ok(LineRead::Line) => {
                    let text = String::from_utf8_lossy(&buf);
                    let line = text.trim_end_matches(['\n', '\r']);
                    if !line.is_empty() && on_event.send(line.to_string()).is_err() {
                        break true;
                    }
                }
            },
        }
    };
    writer.abort();
    let _ = writer.await;
    let (code, stderr) = child.shutdown(GRACE).await;
    {
        let mut state = state.lock().unwrap();
        state.closing.remove(&generation);
        if state
            .connections
            .get(&conn_id)
            .is_some_and(|c| c.generation == generation)
        {
            state.connections.remove(&conn_id);
        }
    }
    if !closed {
        let message = if overflow {
            let limit_mb = MAX_LINE_BYTES / (1024 * 1024);
            if stderr.trim().is_empty() {
                format!("Antigravity emitted a single ACP message exceeding {limit_mb} MiB.")
            } else {
                format!("Antigravity emitted a single ACP message exceeding {limit_mb} MiB.\n{stderr}")
            }
        } else {
            stderr
        };
        let _ = on_event.send(exit_line(code, &message));
    }
}

#[tauri::command]
pub fn antigravity_acp_send(
    window: Window,
    conn_id: String,
    line: String,
    manager: State<'_, AntigravityManager>,
) -> Result<(), AiError> {
    let state = manager.state.lock().unwrap();
    let conn = state
        .connections
        .get(&conn_id)
        .filter(|c| c.owner == window.label())
        .ok_or_else(|| AiError::other("The Antigravity ACP session is not running."))?;
    conn.tx
        .send(line)
        .map_err(|_| AiError::other("The Antigravity ACP session is not running."))
}

#[tauri::command]
pub fn antigravity_acp_close(
    window: Window,
    conn_id: String,
    manager: State<'_, AntigravityManager>,
) {
    manager.close_connection(window.label(), &conn_id);
}

#[cfg(test)]
mod tests;
