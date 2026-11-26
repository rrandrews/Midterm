//! Persistent multiplexed SSH remote helper client.
//!
//! Spawns ONE `ssh` child process per active remote connection, multiplexed
//! over its OpenSSH `ControlPath` socket (`-S <sock> -o ControlMaster=no
//! -o BatchMode=yes -T -e none`). That keeps session usage to a single
//! OpenSSH channel (well within `MaxSessions 10`) while allowing concurrent
//! RPCs, streaming text search, raw binary file reads, chunked cross-host
//! transfers, and live directory watching.
//!
//! On hosts with Python 3 (primary path), the embedded `helper.py` runs in
//! memory (piped on stdin, nothing written to remote disk). On minimal hosts
//! without Python 3, `fallback.sh` provides core POSIX operations.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex as AsyncMutex, oneshot};

use crate::fs::complete::CompletionEntry;
use crate::fs::file::{FileVersion, TextFile, WriteExpect, WriteResult};
use crate::fs::find::{FoundEntries, FoundFiles};
use crate::fs::git::{GitCode, GitStatus};
use crate::fs::list::{EntryKind, FsEntry};
use crate::fs::search::{TextSearchEvent, TextSearchOptions};

const HELPER_PY: &str = include_str!("helper.py");
const FALLBACK_SH: &str = include_str!("fallback.sh");

const PY_LOADER: &str = "\
import sys
b=sys.stdin.buffer
n=int(b.readline())
d=bytearray()
while len(d)<n:
 c=b.read(n-len(d))
 if not c: break
 d.extend(c)
exec(compile(bytes(d),'midterm-helper','exec'))
";

const PY_READY: &str = "MIDTERM_HELPER_PY_READY";
const SH_READY: &str = "MIDTERM_HELPER_SH_READY";
const SH_EOF_TRAILER: &[u8] = b"\nMT_EOF_OK";

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const LONG_TIMEOUT: Duration = Duration::from_secs(120);

const MAX_HANDSHAKE_LINE: usize = 16 * 1024;
const MAX_JSON_LINE: usize = 64 * 1024 * 1024;
const MAX_BINARY_FRAME: usize = 72 * 1024 * 1024;
const MAX_SHELL_LINE: usize = 96 * 1024 * 1024;

static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

/// Metadata returned by the helper's initial `hello` handshake.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloInfo {
    pub home: Option<String>,
    pub os: Option<String>,
    #[allow(dead_code)]
    pub arch: Option<String>,
    #[allow(dead_code)]
    pub watch_mode: Option<String>,
}

/// Metadata from `lstat_meta` (used for cross-host copy).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LstatMeta {
    pub kind: String,
    pub mode: u32,
    #[allow(dead_code)]
    pub size: u64,
    pub dev: u64,
    pub ino: u64,
}

/// Device/inode identity of a remote directory entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
pub struct EntryIdentity {
    pub dev: u64,
    pub ino: u64,
}

/// Open remote write handle for chunked cross-host uploads.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct WriteHandle {
    pub handle: u64,
    pub dev: u64,
    pub ino: u64,
}

#[derive(Debug)]
enum RpcOutcome {
    Json(Result<Value, String>),
    Bytes(Result<Vec<u8>, String>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelperKind {
    Python,
    ShellFallback,
}

pub type WatchCallback = Arc<dyn Fn(Vec<String>) + Send + Sync>;
pub type SearchCallback = Arc<dyn Fn(TextSearchEvent) + Send + Sync>;

struct Dispatcher {
    pending: HashMap<u64, oneshot::Sender<RpcOutcome>>,
    searches: HashMap<u32, SearchCallback>,
    watches: HashMap<u32, WatchCallback>,
}

impl Dispatcher {
    fn new() -> Self {
        Self {
            pending: HashMap::new(),
            searches: HashMap::new(),
            watches: HashMap::new(),
        }
    }
}

/// One live remote helper process connected over an OpenSSH control socket.
pub struct RemoteClient {
    pub client_id: u64,
    pub kind: HelperKind,
    stdin: AsyncMutex<ChildStdin>,
    next_id: AtomicU64,
    dispatcher: Arc<Mutex<Dispatcher>>,
    alive: Arc<AtomicBool>,
    child: Arc<AsyncMutex<Option<Child>>>,
    pub hello: HelloInfo,
}

fn lock_disp(m: &Mutex<Dispatcher>) -> MutexGuard<'_, Dispatcher> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Builds a remote command wrapped in an explicit `sh -c '...'` invocation whose
/// single-quoted body contains ZERO single quotes, ZERO backslashes, and ZERO
/// `!` characters so it parses identically under `sh`, `bash`, `zsh`, `fish`,
/// `csh`, and `tcsh` remote login shells.
fn bootstrap_command(force_shell_fallback: bool) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    let loader_b64 = b64.encode(PY_LOADER);
    let sh_b64 = b64.encode(FALLBACK_SH);
    if force_shell_fallback {
        format!(
            "sh -c 'echo {SH_READY}; \
             p={sh_b64}; \
             s=$( (printf %s \"$p\" | base64 -d || printf %s \"$p\" | base64 -D || printf %s \"$p\" | openssl base64 -d -A) 2>/dev/null ); \
             exec sh -c \"$s\"'"
        )
    } else {
        format!(
            "sh -c 'if command -v python3 >/dev/null 2>&1; then \
                echo {PY_READY}; \
                exec python3 -u -c \"import sys,base64;exec(base64.b64decode(sys.argv[1]))\" {loader_b64}; \
             else \
                echo {SH_READY}; \
                p={sh_b64}; \
                s=$( (printf %s \"$p\" | base64 -d || printf %s \"$p\" | base64 -D || printf %s \"$p\" | openssl base64 -d -A) 2>/dev/null ); \
                exec sh -c \"$s\"; \
             fi'"
        )
    }
}

/// Reads a single `\n`-terminated line into `buf`, failing with `InvalidData`
/// without allocating further as soon as the line would exceed `max_len` bytes.
/// Returns `Ok(false)` on clean EOF before any bytes were read, `Ok(true)` when
/// a line was read.
async fn read_line_bounded<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max_len: usize,
) -> io::Result<bool> {
    buf.clear();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(!buf.is_empty());
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            let take = pos + 1;
            if buf.len().saturating_add(take) > max_len {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "SSH helper frame exceeds maximum line length",
                ));
            }
            buf.extend_from_slice(&available[..take]);
            reader.consume(take);
            return Ok(true);
        }
        let len = available.len();
        if buf.len().saturating_add(len) > max_len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "SSH helper frame exceeds maximum line length",
            ));
        }
        buf.extend_from_slice(available);
        reader.consume(len);
    }
}

impl RemoteClient {
    /// Connects a new remote helper process over the live OpenSSH control
    /// socket `control_path`. Calls `on_disconnect` when the helper exits.
    pub async fn connect(
        control_path: &Path,
        on_disconnect: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Arc<Self>, String> {
        Self::connect_inner(control_path, on_disconnect, false).await
    }

    #[cfg(test)]
    pub async fn connect_shell_fallback(
        control_path: &Path,
        on_disconnect: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Arc<Self>, String> {
        Self::connect_inner(control_path, on_disconnect, true).await
    }

    async fn connect_inner(
        control_path: &Path,
        on_disconnect: Arc<dyn Fn() + Send + Sync>,
        force_shell_fallback: bool,
    ) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new("ssh");
        cmd.arg("-F")
            .arg("/dev/null")
            .arg("-S")
            .arg(control_path)
            .arg("-o")
            .arg("ControlMaster=no")
            .arg("-o")
            .arg("ProxyCommand=false")
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-T")
            .arg("-e")
            .arg("none")
            .arg("--")
            .arg("placeholder")
            .arg(bootstrap_command(force_shell_fallback))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to launch ssh helper: {e}"))?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "ssh helper has no stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "ssh helper has no stdout".to_string())?;
        let stderr = child.stderr.take();

        // Drain stderr concurrently so the child never blocks on a full stderr pipe.
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        if let Some(mut err_pipe) = stderr {
            let buf = Arc::clone(&stderr_buf);
            tokio::spawn(async move {
                let mut data = Vec::new();
                let _ = (&mut err_pipe).take(16 * 1024).read_to_end(&mut data).await;
                let text = String::from_utf8_lossy(&data).trim().to_string();
                *buf.lock().unwrap_or_else(PoisonError::into_inner) = text;
                // Keep discarding any remaining stderr so the remote never blocks.
                let mut sink = [0u8; 4096];
                while let Ok(n) = err_pipe.read(&mut sink).await {
                    if n == 0 {
                        break;
                    }
                }
            });
        }

        let mut reader = BufReader::new(stdout);
        let handshake_deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        let kind = tokio::time::timeout_at(handshake_deadline, async {
            let mut line_buf = Vec::new();
            for _ in 0..64 {
                let got = read_line_bounded(&mut reader, &mut line_buf, MAX_HANDSHAKE_LINE)
                    .await
                    .map_err(|e| format!("reading ssh helper handshake: {e}"))?;
                if !got {
                    let err = stderr_buf
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .clone();
                    return Err(if err.is_empty() {
                        "SSH remote helper exited before handshake".into()
                    } else {
                        format!("SSH connection failed: {err}")
                    });
                }
                let trimmed = String::from_utf8_lossy(&line_buf);
                let trimmed = trimmed.trim();
                if trimmed == PY_READY {
                    return Ok(HelperKind::Python);
                }
                if trimmed == SH_READY {
                    return Ok(HelperKind::ShellFallback);
                }
            }
            Err("unexpected output before SSH helper handshake".into())
        })
        .await
        .map_err(|_| "timed out starting SSH remote helper".to_string())??;

        if kind == HelperKind::Python {
            let header = format!("{}\n", HELPER_PY.len());
            tokio::time::timeout_at(handshake_deadline, async {
                stdin
                    .write_all(header.as_bytes())
                    .await
                    .map_err(|e| format!("sending helper header: {e}"))?;
                stdin
                    .write_all(HELPER_PY.as_bytes())
                    .await
                    .map_err(|e| format!("sending helper body: {e}"))?;
                stdin
                    .flush()
                    .await
                    .map_err(|e| format!("flushing helper body: {e}"))
            })
            .await
            .map_err(|_| "timed out sending SSH remote helper".to_string())??;
        }

        let dispatcher = Arc::new(Mutex::new(Dispatcher::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let child_slot = Arc::new(AsyncMutex::new(Some(child)));

        let disp_task = Arc::clone(&dispatcher);
        let alive_task = Arc::clone(&alive);
        let err_task = Arc::clone(&stderr_buf);
        let child_task = Arc::clone(&child_slot);
        tokio::spawn(async move {
            let loop_err = match kind {
                HelperKind::Python => read_loop_python(reader, &disp_task).await,
                HelperKind::ShellFallback => read_loop_shell(reader, &disp_task).await,
            };
            alive_task.store(false, Ordering::SeqCst);
            // Ensure the child process is terminated and reaped on protocol error or EOF.
            if let Some(mut c) = child_task.lock().await.take() {
                let _ = c.kill().await;
                let _ = c.wait().await;
            }
            let reason = if let Err(proto_err) = loop_err {
                proto_err
            } else {
                let err = err_task.lock().unwrap_or_else(PoisonError::into_inner);
                if err.is_empty() {
                    "SSH connection closed".to_string()
                } else {
                    format!("SSH connection closed: {err}")
                }
            };
            let (pending, searches) = {
                let mut d = lock_disp(&disp_task);
                let p: Vec<_> = d.pending.drain().collect();
                let s: Vec<_> = d.searches.drain().collect();
                d.watches.clear();
                (p, s)
            };
            for (_, tx) in pending {
                let _ = tx.send(RpcOutcome::Json(Err(reason.clone())));
            }
            for (_, cb) in searches {
                cb(TextSearchEvent::Error {
                    message: reason.clone(),
                });
            }
            on_disconnect();
        });

        let client = Arc::new(Self {
            client_id: NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed),
            kind,
            stdin: AsyncMutex::new(stdin),
            next_id: AtomicU64::new(1),
            dispatcher,
            alive,
            child: child_slot,
            hello: HelloInfo {
                home: None,
                os: None,
                arch: None,
                watch_mode: None,
            },
        });

        let hello = match client.fetch_hello().await {
            Ok(h) => h,
            Err(e) => {
                client.close().await;
                return Err(e);
            }
        };
        let mut client = Arc::try_unwrap(client).map_err(|_| "internal client init error")?;
        client.hello = hello;
        Ok(Arc::new(client))
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub async fn close(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let child = self.child.lock().await.take();
        if let Some(mut c) = child {
            let _ = c.kill().await;
            let _ = c.wait().await;
        }
    }

    /// Marks the transport dead and kills the child in the background (used
    /// when a timed-out or partial write may have corrupted framing).
    fn abort_transport(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let child = Arc::clone(&self.child);
        tokio::spawn(async move {
            if let Some(mut c) = child.lock().await.take() {
                let _ = c.kill().await;
                let _ = c.wait().await;
            }
        });
    }

    async fn write_frame_with_deadline(
        &self,
        bytes: &[u8],
        deadline: tokio::time::Instant,
        op: &str,
    ) -> Result<(), String> {
        let mut stdin = match tokio::time::timeout_at(deadline, self.stdin.lock()).await {
            Ok(guard) => guard,
            Err(_) => return Err(format!("SSH operation '{op}' timed out waiting for transport")),
        };
        if !self.is_alive() {
            return Err("SSH connection is disconnected".into());
        }
        let write_future = async {
            stdin.write_all(bytes).await?;
            stdin.flush().await
        };
        match tokio::time::timeout_at(deadline, write_future).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => {
                self.abort_transport();
                Err(format!("SSH write failed: {e}"))
            }
            Err(_) => {
                // Partial write may have left an incomplete frame on the wire; discard transport.
                self.abort_transport();
                Err(format!("SSH operation '{op}' timed out while sending request"))
            }
        }
    }

    async fn fetch_hello(&self) -> Result<HelloInfo, String> {
        match self.kind {
            HelperKind::Python => {
                let val = self.py_call("hello", json!({}), DEFAULT_TIMEOUT).await?;
                serde_json::from_value(val).map_err(|e| format!("invalid hello response: {e}"))
            }
            HelperKind::ShellFallback => {
                let text = self.sh_call_text("hello", &[], DEFAULT_TIMEOUT).await?;
                let mut parts = text.split('\t');
                Ok(HelloInfo {
                    home: parts.next().filter(|s| !s.is_empty()).map(str::to_owned),
                    os: parts.next().filter(|s| !s.is_empty()).map(str::to_owned),
                    arch: parts.next().filter(|s| !s.is_empty()).map(str::to_owned),
                    watch_mode: Some("none".into()),
                })
            }
        }
    }

    async fn py_call_raw(&self, op: &str, mut params: Value, timeout: Duration) -> Result<RpcOutcome, String> {
        if !self.is_alive() {
            return Err("SSH connection is disconnected".into());
        }
        let deadline = tokio::time::Instant::now() + timeout;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let obj = params.as_object_mut().ok_or("params must be object")?;
        obj.insert("id".into(), json!(id));
        obj.insert("op".into(), json!(op));
        let mut line = serde_json::to_string(&params).map_err(|e| e.to_string())?;
        line.push('\n');

        let (tx, rx) = oneshot::channel();
        lock_disp(&self.dispatcher).pending.insert(id, tx);

        if let Err(e) = self.write_frame_with_deadline(line.as_bytes(), deadline, op).await {
            lock_disp(&self.dispatcher).pending.remove(&id);
            return Err(e);
        }

        match tokio::time::timeout_at(deadline, rx).await {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(_)) => Err("SSH helper closed before replying".into()),
            Err(_) => {
                lock_disp(&self.dispatcher).pending.remove(&id);
                Err(format!("SSH operation '{op}' timed out"))
            }
        }
    }

    async fn py_call(&self, op: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        match self.py_call_raw(op, params, timeout).await? {
            RpcOutcome::Json(res) => res,
            RpcOutcome::Bytes(_) => Err(format!("unexpected binary response for '{op}'")),
        }
    }

    async fn py_call_bytes(&self, op: &str, params: Value, timeout: Duration) -> Result<Vec<u8>, String> {
        match self.py_call_raw(op, params, timeout).await? {
            RpcOutcome::Bytes(res) => res,
            RpcOutcome::Json(Err(e)) => Err(e),
            RpcOutcome::Json(Ok(_)) => Err(format!("unexpected JSON response for '{op}'")),
        }
    }

    async fn sh_call_bytes(&self, op: &str, args: &[&[u8]], timeout: Duration) -> Result<Vec<u8>, String> {
        if !self.is_alive() {
            return Err("SSH connection is disconnected".into());
        }
        let deadline = tokio::time::Instant::now() + timeout;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut payload = format!("{id} {op} {}\n", args.len());
        let b64 = base64::engine::general_purpose::STANDARD;
        for arg in args {
            payload.push_str(&b64.encode(arg));
            payload.push('\n');
        }
        let (tx, rx) = oneshot::channel();
        lock_disp(&self.dispatcher).pending.insert(id, tx);

        if let Err(e) = self.write_frame_with_deadline(payload.as_bytes(), deadline, op).await {
            lock_disp(&self.dispatcher).pending.remove(&id);
            return Err(e);
        }

        match tokio::time::timeout_at(deadline, rx).await {
            Ok(Ok(RpcOutcome::Bytes(res))) => res,
            Ok(Ok(RpcOutcome::Json(Err(e)))) => Err(e),
            Ok(Ok(RpcOutcome::Json(Ok(_)))) => Err("unexpected response".into()),
            Ok(Err(_)) => Err("SSH helper closed before replying".into()),
            Err(_) => {
                lock_disp(&self.dispatcher).pending.remove(&id);
                Err(format!("SSH operation '{op}' timed out"))
            }
        }
    }

    async fn sh_call_text(&self, op: &str, args: &[&[u8]], timeout: Duration) -> Result<String, String> {
        let bytes = self.sh_call_bytes(op, args, timeout).await?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    async fn sh_read_bounded(&self, path: &str, limit: u64) -> Result<ShReadResult, String> {
        let limit_s = limit.to_string();
        match self
            .sh_call_bytes("read_bytes", &[path.as_bytes(), limit_s.as_bytes()], LONG_TIMEOUT)
            .await
        {
            Ok(mut bytes) => {
                if !bytes.ends_with(SH_EOF_TRAILER) {
                    return Err(format!("truncated or failed read of {path}"));
                }
                bytes.truncate(bytes.len() - SH_EOF_TRAILER.len());
                if bytes.len() as u64 > limit {
                    return Ok(ShReadResult::TooLarge(bytes.len() as u64));
                }
                Ok(ShReadResult::Bytes(bytes))
            }
            Err(e) => {
                if let Some(sz_str) = e.strip_prefix("TOO_LARGE:")
                    && let Ok(sz) = sz_str.trim().parse::<u64>()
                {
                    return Ok(ShReadResult::TooLarge(sz));
                }
                Err(e)
            }
        }
    }

    // --- Typed FS/Git/Search/Watch/Complete RPCs ---

    pub async fn list_dir(&self, path: &str, show_hidden: bool) -> Result<Vec<FsEntry>, String> {
        match self.kind {
            HelperKind::Python => {
                let val = self
                    .py_call(
                        "list_dir",
                        json!({ "path": path, "showHidden": show_hidden }),
                        DEFAULT_TIMEOUT,
                    )
                    .await?;
                serde_json::from_value(val).map_err(|e| format!("invalid list_dir response: {e}"))
            }
            HelperKind::ShellFallback => {
                let b64 = base64::engine::general_purpose::STANDARD;
                let text = self
                    .sh_call_text("list_dir", &[path.as_bytes()], DEFAULT_TIMEOUT)
                    .await?;
                let mut entries = Vec::new();
                for line in text.lines() {
                    let mut parts = line.splitn(3, '\t');
                    let Some(kind_s) = parts.next() else { continue };
                    let Some(sym_s) = parts.next() else { continue };
                    let Some(name_b64) = parts.next() else { continue };
                    let Ok(name_bytes) = b64.decode(name_b64.trim()) else {
                        continue;
                    };
                    let Ok(name) = String::from_utf8(name_bytes) else {
                        continue;
                    };
                    let hidden = name.starts_with('.');
                    let ignored = name == ".git";
                    if !show_hidden && (hidden || ignored) {
                        continue;
                    }
                    let full = if path == "/" {
                        format!("/{name}")
                    } else {
                        format!("{}/{name}", path.trim_end_matches('/'))
                    };
                    entries.push(FsEntry {
                        name,
                        path: full,
                        kind: if kind_s == "dir" { EntryKind::Dir } else { EntryKind::File },
                        symlink: sym_s == "1",
                        hidden,
                        ignored,
                    });
                }
                entries.sort_by_cached_key(|e| (e.kind != EntryKind::Dir, e.name.to_lowercase(), e.name.clone()));
                Ok(entries)
            }
        }
    }

    pub async fn stat(&self, path: &str) -> Result<Option<FsEntry>, String> {
        match self.kind {
            HelperKind::Python => {
                let val = self.py_call("stat", json!({ "path": path }), DEFAULT_TIMEOUT).await?;
                serde_json::from_value(val).map_err(|e| format!("invalid stat response: {e}"))
            }
            HelperKind::ShellFallback => {
                let text = self.sh_call_text("stat", &[path.as_bytes()], DEFAULT_TIMEOUT).await?;
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    return Ok(None);
                }
                let mut parts = trimmed.split('\t');
                let kind_s = parts.next().unwrap_or("file");
                let sym_s = parts.next().unwrap_or("0");
                let name = path.trim_end_matches('/').rsplit('/').next().unwrap_or("/");
                let name = if name.is_empty() { "/" } else { name };
                Ok(Some(FsEntry {
                    name: name.to_string(),
                    path: path.to_string(),
                    kind: if kind_s == "dir" { EntryKind::Dir } else { EntryKind::File },
                    symlink: sym_s == "1",
                    hidden: name.starts_with('.'),
                    ignored: false,
                }))
            }
        }
    }

    pub async fn create(&self, path: &str, dir: bool) -> Result<(), String> {
        match self.kind {
            HelperKind::Python => {
                self.py_call("create", json!({ "path": path, "dir": dir }), DEFAULT_TIMEOUT)
                    .await?;
                Ok(())
            }
            HelperKind::ShellFallback => {
                let kind = if dir { b"dir".as_slice() } else { b"file".as_slice() };
                self.sh_call_text("create", &[path.as_bytes(), kind], DEFAULT_TIMEOUT)
                    .await?;
                Ok(())
            }
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        match self.kind {
            HelperKind::Python => {
                self.py_call("rename", json!({ "from": from, "to": to }), DEFAULT_TIMEOUT)
                    .await?;
                Ok(())
            }
            HelperKind::ShellFallback => {
                self.sh_call_text("rename", &[from.as_bytes(), to.as_bytes()], DEFAULT_TIMEOUT)
                    .await?;
                Ok(())
            }
        }
    }

    pub async fn delete(&self, paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        match self.kind {
            HelperKind::Python => {
                self.py_call("delete", json!({ "paths": paths }), LONG_TIMEOUT)
                    .await?;
                Ok(())
            }
            HelperKind::ShellFallback => {
                for p in paths {
                    self.sh_call_text("delete", &[p.as_bytes()], LONG_TIMEOUT)
                        .await?;
                }
                Ok(())
            }
        }
    }

    pub async fn copy_into(&self, from: &str, to_dir: &str) -> Result<String, String> {
        match self.kind {
            HelperKind::Python => {
                let val = self
                    .py_call("copy_into", json!({ "from": from, "toDir": to_dir }), LONG_TIMEOUT)
                    .await?;
                serde_json::from_value(val).map_err(|e| format!("invalid copy_into response: {e}"))
            }
            HelperKind::ShellFallback => Err("copying remote files requires python3 on the remote host".into()),
        }
    }

    pub async fn read_text(&self, path: &str, limit: u64) -> Result<TextFile, String> {
        match self.kind {
            HelperKind::Python => {
                let val = self
                    .py_call("read_text", json!({ "path": path, "limit": limit }), LONG_TIMEOUT)
                    .await?;
                serde_json::from_value(val).map_err(|e| format!("invalid read_text response: {e}"))
            }
            HelperKind::ShellFallback => {
                // Bound cksum to `limit` inside file_version so oversized files
                // return TooLarge immediately without reading the whole file.
                let limit_s = limit.to_string();
                let ver_text = self
                    .sh_call_text(
                        "file_version",
                        &[path.as_bytes(), limit_s.as_bytes()],
                        DEFAULT_TIMEOUT,
                    )
                    .await?;
                let ver = parse_sh_version(&ver_text)
                    .ok_or_else(|| format!("cannot read {path}: not a regular file"))?;
                if ver.size > limit {
                    return Ok(TextFile::TooLarge { version: ver });
                }
                let bytes = match self.sh_read_bounded(path, limit).await? {
                    ShReadResult::TooLarge(sz) => {
                        return Ok(TextFile::TooLarge {
                            version: FileVersion {
                                mtime: ver.mtime,
                                size: sz.max(ver.size),
                            },
                        });
                    }
                    ShReadResult::Bytes(b) => b,
                };
                if bytes.iter().take(8000).any(|&b| b == 0) {
                    return Ok(TextFile::Binary { version: ver });
                }
                match String::from_utf8(bytes) {
                    Ok(text) => Ok(TextFile::Text { text, version: ver }),
                    Err(_) => Ok(TextFile::Binary { version: ver }),
                }
            }
        }
    }

    pub async fn read_bytes(&self, path: &str, limit: u64) -> Result<Vec<u8>, String> {
        match self.kind {
            HelperKind::Python => {
                self.py_call_bytes("read_bytes", json!({ "path": path, "limit": limit }), LONG_TIMEOUT)
                    .await
            }
            HelperKind::ShellFallback => match self.sh_read_bounded(path, limit).await? {
                ShReadResult::Bytes(bytes) => Ok(bytes),
                ShReadResult::TooLarge(sz) => Err(format!("{path} is too large to show ({sz} bytes)")),
            },
        }
    }

    pub async fn write_text(
        &self,
        path: &str,
        text: &str,
        expect: &WriteExpect,
    ) -> Result<WriteResult, String> {
        match self.kind {
            HelperKind::Python => {
                let val = self
                    .py_call(
                        "write_text",
                        json!({ "path": path, "text": text, "expect": expect }),
                        LONG_TIMEOUT,
                    )
                    .await?;
                serde_json::from_value(val).map_err(|e| format!("invalid write_text response: {e}"))
            }
            HelperKind::ShellFallback => {
                let (ekind, emtime, esize) = match expect {
                    WriteExpect::Version { version } => (
                        "version",
                        version.mtime.as_str(),
                        version.size.to_string(),
                    ),
                    WriteExpect::Absent => ("absent", "", String::new()),
                    WriteExpect::Any => ("any", "", String::new()),
                };
                let resp = self
                    .sh_call_text(
                        "write_text",
                        &[
                            path.as_bytes(),
                            text.as_bytes(),
                            ekind.as_bytes(),
                            emtime.as_bytes(),
                            esize.as_bytes(),
                        ],
                        LONG_TIMEOUT,
                    )
                    .await?;
                let trimmed = resp.trim_end_matches(['\r', '\n']);
                if let Some(rest) = trimmed.strip_prefix("WRITTEN\t") {
                    let version = parse_sh_version(rest)
                        .ok_or_else(|| format!("invalid fallback write version: {rest}"))?;
                    Ok(WriteResult::Written { version })
                } else if let Some(rest) = trimmed.strip_prefix("CONFLICT\t") {
                    Ok(WriteResult::Conflict {
                        current: parse_sh_version(rest),
                    })
                } else {
                    Err(format!("unexpected fallback write response: {trimmed}"))
                }
            }
        }
    }

    pub async fn file_version(&self, path: &str) -> Result<Option<FileVersion>, String> {
        match self.kind {
            HelperKind::Python => {
                let val = self
                    .py_call("file_version", json!({ "path": path }), DEFAULT_TIMEOUT)
                    .await?;
                serde_json::from_value(val).map_err(|e| format!("invalid file_version response: {e}"))
            }
            HelperKind::ShellFallback => {
                let text = self
                    .sh_call_text("file_version", &[path.as_bytes()], DEFAULT_TIMEOUT)
                    .await?;
                Ok(parse_sh_version(&text))
            }
        }
    }

    pub async fn git_status(&self, path: &str) -> Result<Option<GitStatus>, String> {
        match self.kind {
            HelperKind::Python => {
                let val = self
                    .py_call("git_status", json!({ "path": path }), DEFAULT_TIMEOUT)
                    .await?;
                serde_json::from_value(val).map_err(|e| format!("invalid git_status response: {e}"))
            }
            HelperKind::ShellFallback => {
                let b64 = base64::engine::general_purpose::STANDARD;
                let text = self
                    .sh_call_text("git_status", &[path.as_bytes()], DEFAULT_TIMEOUT)
                    .await?;
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    return Ok(None);
                }
                let Some((top_b64, b64_status)) = trimmed.split_once('\t') else {
                    return Ok(None);
                };
                let root_bytes = b64
                    .decode(top_b64.trim())
                    .map_err(|e| format!("invalid git root output: {e}"))?;
                let root = String::from_utf8(root_bytes)
                    .map_err(|e| format!("invalid git root UTF-8: {e}"))?;
                let raw = b64
                    .decode(b64_status.trim())
                    .map_err(|e| format!("invalid git output: {e}"))?;
                Ok(Some(parse_porcelain_v1_z(&root, &raw)))
            }
        }
    }

    pub async fn git_exec(
        &self,
        cwd: &str,
        args: &[&str],
        stdin: Option<&[u8]>,
        read_only: bool,
        timeout: Duration,
    ) -> Result<(i32, Vec<u8>, String, bool), String> {
        match self.kind {
            HelperKind::Python => {
                let b64 = base64::engine::general_purpose::STANDARD;
                let stdin_b64 = stdin.map(|bytes| b64.encode(bytes));
                let timeout_secs = timeout.as_secs().clamp(1, 120);
                let rpc_timeout = Duration::from_secs(timeout_secs + 5);
                let val = self
                    .py_call(
                        "git_exec",
                        json!({
                            "cwd": cwd,
                            "args": args,
                            "stdinB64": stdin_b64,
                            "readOnly": read_only,
                            "timeoutSecs": timeout_secs,
                        }),
                        rpc_timeout,
                    )
                    .await?;
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Resp {
                    code: i32,
                    stdout_b64: String,
                    stderr: String,
                    truncated: bool,
                }
                let resp: Resp = serde_json::from_value(val)
                    .map_err(|e| format!("invalid git_exec response: {e}"))?;
                let stdout = b64
                    .decode(resp.stdout_b64.as_bytes())
                    .map_err(|e| format!("invalid git_exec stdout: {e}"))?;
                Ok((resp.code, stdout, resp.stderr, resp.truncated))
            }
            HelperKind::ShellFallback => Err(
                "Source Control over SSH requires python3 on the remote host".into(),
            ),
        }
    }

    pub async fn git_read_untracked(
        &self,
        root: &str,
        git_dir: &str,
        rel_path: &str,
        max_bytes: usize,
    ) -> Result<Vec<u8>, String> {
        match self.kind {
            HelperKind::Python => {
                self.py_call_bytes(
                    "git_read_untracked",
                    json!({
                        "root": root,
                        "gitDir": git_dir,
                        "relPath": rel_path,
                        "maxBytes": max_bytes,
                    }),
                    DEFAULT_TIMEOUT,
                )
                .await
            }
            HelperKind::ShellFallback => Err(
                "Source Control over SSH requires python3 on the remote host".into(),
            ),
        }
    }

    pub async fn git_remove_untracked(
        &self,
        root: &str,
        git_dir: &str,
        rel_paths: &[String],
    ) -> Result<(), String> {
        match self.kind {
            HelperKind::Python => {
                self.py_call(
                    "git_remove_untracked",
                    json!({
                        "root": root,
                        "gitDir": git_dir,
                        "relPaths": rel_paths,
                    }),
                    DEFAULT_TIMEOUT,
                )
                .await?;
                Ok(())
            }
            HelperKind::ShellFallback => Err(
                "Source Control over SSH requires python3 on the remote host".into(),
            ),
        }
    }

    pub async fn find_files(&self, root: &str, limit: usize) -> Result<FoundFiles, String> {
        match self.kind {
            HelperKind::Python => {
                let val = self
                    .py_call("find_files", json!({ "root": root, "limit": limit }), LONG_TIMEOUT)
                    .await?;
                serde_json::from_value(val).map_err(|e| format!("invalid find_files response: {e}"))
            }
            HelperKind::ShellFallback => Ok(FoundFiles {
                paths: Vec::new(),
                truncated: false,
            }),
        }
    }

    pub async fn find_entries(
        &self,
        root: &str,
        limit: usize,
        show_hidden: bool,
    ) -> Result<FoundEntries, String> {
        match self.kind {
            HelperKind::Python => {
                let val = self
                    .py_call(
                        "find_entries",
                        json!({ "root": root, "limit": limit, "showHidden": show_hidden }),
                        LONG_TIMEOUT,
                    )
                    .await?;
                serde_json::from_value(val).map_err(|e| format!("invalid find_entries response: {e}"))
            }
            HelperKind::ShellFallback => Err("name search requires python3 on the remote host".into()),
        }
    }

    pub async fn search_start(
        &self,
        search_id: u32,
        root: &str,
        options: &TextSearchOptions,
        callback: SearchCallback,
    ) -> Result<(), String> {
        if self.kind != HelperKind::Python {
            return Err("text search requires python3 on the remote host".into());
        }
        lock_disp(&self.dispatcher).searches.insert(search_id, callback);
        let res = self
            .py_call(
                "search_start",
                json!({ "searchId": search_id, "root": root, "options": options }),
                DEFAULT_TIMEOUT,
            )
            .await;
        if res.is_err() {
            lock_disp(&self.dispatcher).searches.remove(&search_id);
        }
        res.map(|_| ())
    }

    pub async fn search_cancel(&self, search_id: u32) {
        if self.kind != HelperKind::Python || !self.is_alive() {
            return;
        }
        let _ = self
            .py_call("search_cancel", json!({ "searchId": search_id }), Duration::from_secs(5))
            .await;
    }

    pub async fn watch_set(
        &self,
        watch_id: u32,
        dirs: Vec<String>,
        callback: WatchCallback,
    ) -> Result<(), String> {
        if self.kind != HelperKind::Python {
            return Ok(());
        }
        if dirs.is_empty() {
            self.watch_stop(watch_id).await;
            return Ok(());
        }
        lock_disp(&self.dispatcher).watches.insert(watch_id, callback);
        let res = self
            .py_call(
                "watch_set",
                json!({ "watchId": watch_id, "dirs": dirs }),
                DEFAULT_TIMEOUT,
            )
            .await;
        if res.is_err() {
            lock_disp(&self.dispatcher).watches.remove(&watch_id);
        }
        res.map(|_| ())
    }

    pub async fn watch_stop(&self, watch_id: u32) {
        lock_disp(&self.dispatcher).watches.remove(&watch_id);
        if self.kind != HelperKind::Python || !self.is_alive() {
            return;
        }
        let _ = self
            .py_call("watch_stop", json!({ "watchId": watch_id }), Duration::from_secs(5))
            .await;
    }

    pub async fn path_commands(&self, path: Option<&str>) -> Result<Vec<String>, String> {
        match self.kind {
            HelperKind::Python => {
                let val = self
                    .py_call("path_commands", json!({ "path": path }), DEFAULT_TIMEOUT)
                    .await?;
                serde_json::from_value(val).map_err(|e| format!("invalid path_commands response: {e}"))
            }
            HelperKind::ShellFallback => {
                let b64 = base64::engine::general_purpose::STANDARD;
                let text = self
                    .sh_call_text("path_commands", &[path.unwrap_or("").as_bytes()], DEFAULT_TIMEOUT)
                    .await?;
                let mut cmds = Vec::new();
                for line in text.lines() {
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(bytes) = b64.decode(line.trim())
                        && let Ok(name) = String::from_utf8(bytes)
                        && !name.is_empty()
                    {
                        cmds.push(name);
                    }
                }
                cmds.sort();
                cmds.dedup();
                Ok(cmds)
            }
        }
    }

    pub async fn complete_list(&self, dir: &str) -> Result<Vec<CompletionEntry>, String> {
        match self.kind {
            HelperKind::Python => {
                let val = self
                    .py_call("complete_list", json!({ "dir": dir }), DEFAULT_TIMEOUT)
                    .await?;
                serde_json::from_value(val).map_err(|e| format!("invalid complete_list response: {e}"))
            }
            HelperKind::ShellFallback => {
                let b64 = base64::engine::general_purpose::STANDARD;
                let text = self
                    .sh_call_text("complete_list", &[dir.as_bytes()], DEFAULT_TIMEOUT)
                    .await?;
                let mut entries = Vec::new();
                for line in text.lines() {
                    let mut parts = line.splitn(3, '\t');
                    let Some(d) = parts.next() else { continue };
                    let Some(x) = parts.next() else { continue };
                    let Some(name_b64) = parts.next() else { continue };
                    let Ok(bytes) = b64.decode(name_b64.trim()) else { continue };
                    let Ok(name) = String::from_utf8(bytes) else { continue };
                    entries.push(CompletionEntry {
                        name,
                        dir: d == "1",
                        executable: x == "1",
                    });
                }
                entries.sort_by(|a, b| a.name.cmp(&b.name));
                Ok(entries)
            }
        }
    }

    // --- Low-level streaming primitives for cross-host copy (transfer.rs) ---

    pub async fn lstat_meta(&self, path: &str) -> Result<Option<LstatMeta>, String> {
        if self.kind != HelperKind::Python {
            return Err("cross-host copy requires python3 on the remote host".into());
        }
        let val = self
            .py_call("lstat_meta", json!({ "path": path }), DEFAULT_TIMEOUT)
            .await?;
        serde_json::from_value(val).map_err(|e| format!("invalid lstat_meta response: {e}"))
    }

    pub async fn list_copy_children(&self, dir: &str) -> Result<Vec<String>, String> {
        if self.kind != HelperKind::Python {
            return Err("cross-host copy requires python3 on the remote host".into());
        }
        let val = self
            .py_call("list_copy_children", json!({ "dir": dir }), DEFAULT_TIMEOUT)
            .await?;
        serde_json::from_value(val).map_err(|e| format!("invalid list_copy_children response: {e}"))
    }

    pub async fn readlink(&self, path: &str) -> Result<String, String> {
        if self.kind != HelperKind::Python {
            return Err("readlink requires python3 on the remote host".into());
        }
        let val = self
            .py_call("readlink", json!({ "path": path }), DEFAULT_TIMEOUT)
            .await?;
        serde_json::from_value(val).map_err(|e| format!("invalid readlink response: {e}"))
    }

    pub async fn transfer_open_read(&self, path: &str) -> Result<u64, String> {
        if self.kind != HelperKind::Python {
            return Err("cross-host copy requires python3 on the remote host".into());
        }
        let val = self
            .py_call("transfer_open_read", json!({ "path": path }), DEFAULT_TIMEOUT)
            .await?;
        serde_json::from_value(val).map_err(|e| format!("invalid transfer_open_read response: {e}"))
    }

    pub async fn transfer_read(&self, handle: u64, max_bytes: usize) -> Result<Vec<u8>, String> {
        if self.kind != HelperKind::Python {
            return Err("cross-host copy requires python3 on the remote host".into());
        }
        self.py_call_bytes(
            "transfer_read",
            json!({ "handle": handle, "maxBytes": max_bytes }),
            LONG_TIMEOUT,
        )
        .await
    }

    pub async fn transfer_open_write(&self, path: &str) -> Result<WriteHandle, String> {
        if self.kind != HelperKind::Python {
            return Err("cross-host copy requires python3 on the remote host".into());
        }
        let val = self
            .py_call("transfer_open_write", json!({ "path": path }), DEFAULT_TIMEOUT)
            .await?;
        serde_json::from_value(val).map_err(|e| format!("invalid transfer_open_write response: {e}"))
    }

    pub async fn transfer_write(&self, handle: u64, chunk: &[u8]) -> Result<(), String> {
        if self.kind != HelperKind::Python {
            return Err("cross-host copy requires python3 on the remote host".into());
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(chunk);
        self.py_call("transfer_write", json!({ "handle": handle, "data": b64 }), LONG_TIMEOUT)
            .await?;
        Ok(())
    }

    pub async fn transfer_finish_write(&self, handle: u64, mode: u32) -> Result<(), String> {
        if self.kind != HelperKind::Python {
            return Err("cross-host copy requires python3 on the remote host".into());
        }
        self.py_call(
            "transfer_finish_write",
            json!({ "handle": handle, "mode": mode & 0o777 }),
            DEFAULT_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    pub async fn transfer_close(&self, handle: u64) {
        if self.kind != HelperKind::Python || !self.is_alive() {
            return;
        }
        let _ = self
            .py_call("transfer_close", json!({ "handle": handle }), Duration::from_secs(5))
            .await;
    }

    pub async fn mkdir_private(&self, path: &str) -> Result<EntryIdentity, String> {
        if self.kind != HelperKind::Python {
            return Err("cross-host copy requires python3 on the remote host".into());
        }
        let val = self
            .py_call("mkdir_private", json!({ "path": path }), DEFAULT_TIMEOUT)
            .await?;
        serde_json::from_value(val).map_err(|e| format!("invalid mkdir_private response: {e}"))
    }

    pub async fn rename_no_replace(&self, from: &str, to: &str) -> Result<(), String> {
        if self.kind != HelperKind::Python {
            return Err("cross-host copy requires python3 on the remote host".into());
        }
        self.py_call("rename_no_replace", json!({ "from": from, "to": to }), DEFAULT_TIMEOUT)
            .await?;
        Ok(())
    }

    pub async fn symlink_new(&self, target: &str, dest: &str) -> Result<EntryIdentity, String> {
        if self.kind != HelperKind::Python {
            return Err("cross-host copy requires python3 on the remote host".into());
        }
        let val = self
            .py_call("symlink_new", json!({ "target": target, "dest": dest }), DEFAULT_TIMEOUT)
            .await?;
        serde_json::from_value(val).map_err(|e| format!("invalid symlink_new response: {e}"))
    }

    pub async fn chmod(&self, path: &str, mode: u32) -> Result<(), String> {
        if self.kind != HelperKind::Python {
            return Ok(());
        }
        self.py_call("chmod", json!({ "path": path, "mode": mode & 0o777 }), DEFAULT_TIMEOUT)
            .await?;
        Ok(())
    }

    pub async fn remove_single(&self, path: &str, dir: bool, identity: Option<EntryIdentity>) {
        if self.kind != HelperKind::Python || !self.is_alive() {
            return;
        }
        let _ = self
            .py_call(
                "remove_single",
                json!({
                    "path": path,
                    "dir": dir,
                    "dev": identity.map(|i| i.dev),
                    "ino": identity.map(|i| i.ino),
                }),
                Duration::from_secs(5),
            )
            .await;
    }
}

enum ShReadResult {
    Bytes(Vec<u8>),
    TooLarge(u64),
}

async fn read_loop_python<R: tokio::io::AsyncRead + Unpin>(
    mut reader: BufReader<R>,
    dispatcher: &Arc<Mutex<Dispatcher>>,
) -> Result<(), String> {
    let mut header = Vec::new();
    loop {
        let got = match read_line_bounded(&mut reader, &mut header, MAX_JSON_LINE).await {
            Ok(g) => g,
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                return Err(format!("SSH protocol error: {e}"));
            }
            Err(_) => return Ok(()),
        };
        if !got {
            return Ok(());
        }
        let line_s = String::from_utf8_lossy(&header);
        let line = line_s.trim_end_matches(['\r', '\n']);
        if let Some(json_str) = line.strip_prefix("J ") {
            let Ok(val) = serde_json::from_str::<Value>(json_str) else {
                return Err("SSH protocol error: malformed JSON frame".into());
            };
            if let Some(event) = val.get("event").and_then(Value::as_str) {
                match event {
                    "search" => {
                        let Some(search_id) = val.get("searchId").and_then(Value::as_u64) else {
                            continue;
                        };
                        let Some(payload) = val.get("payload") else {
                            continue;
                        };
                        let Ok(ev) = serde_json::from_value::<TextSearchEvent>(payload.clone()) else {
                            continue;
                        };
                        let terminal = matches!(
                            ev,
                            TextSearchEvent::Done { .. } | TextSearchEvent::Error { .. }
                        );
                        let cb = {
                            let mut d = lock_disp(dispatcher);
                            if terminal {
                                d.searches.remove(&(search_id as u32))
                            } else {
                                d.searches.get(&(search_id as u32)).cloned()
                            }
                        };
                        if let Some(cb) = cb {
                            cb(ev);
                        }
                    }
                    "watch" => {
                        let Some(watch_id) = val.get("watchId").and_then(Value::as_u64) else {
                            continue;
                        };
                        let Some(dirs_val) = val.get("dirs") else {
                            continue;
                        };
                        let Ok(dirs) = serde_json::from_value::<Vec<String>>(dirs_val.clone()) else {
                            continue;
                        };
                        if dirs.is_empty() {
                            continue;
                        }
                        let cb = lock_disp(dispatcher).watches.get(&(watch_id as u32)).cloned();
                        if let Some(cb) = cb {
                            cb(dirs);
                        }
                    }
                    _ => {}
                }
            } else if let Some(id) = val.get("id").and_then(Value::as_u64) {
                let outcome = if let Some(err) = val.get("err").and_then(Value::as_str) {
                    RpcOutcome::Json(Err(err.to_string()))
                } else {
                    RpcOutcome::Json(Ok(val.get("ok").cloned().unwrap_or(Value::Null)))
                };
                if let Some(tx) = lock_disp(dispatcher).pending.remove(&id) {
                    let _ = tx.send(outcome);
                }
            }
        } else if let Some(rest) = line.strip_prefix("B ") {
            let mut parts = rest.split_whitespace();
            let (Some(id_s), Some(len_s)) = (parts.next(), parts.next()) else {
                return Err("SSH protocol error: malformed binary header".into());
            };
            let (Ok(id), Ok(len)) = (id_s.parse::<u64>(), len_s.parse::<usize>()) else {
                return Err("SSH protocol error: invalid binary header values".into());
            };
            if len > MAX_BINARY_FRAME {
                return Err("SSH protocol error: binary frame exceeds maximum size".into());
            }
            let mut buf = vec![0u8; len];
            if reader.read_exact(&mut buf).await.is_err() {
                return Err("SSH protocol error: truncated binary frame".into());
            }
            if let Some(tx) = lock_disp(dispatcher).pending.remove(&id) {
                let _ = tx.send(RpcOutcome::Bytes(Ok(buf)));
            }
        } else {
            return Err("SSH protocol error: unexpected frame prefix".into());
        }
    }
}

async fn read_loop_shell<R: tokio::io::AsyncRead + Unpin>(
    mut reader: BufReader<R>,
    dispatcher: &Arc<Mutex<Dispatcher>>,
) -> Result<(), String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut line_buf = Vec::new();
    loop {
        let got = match read_line_bounded(&mut reader, &mut line_buf, MAX_SHELL_LINE).await {
            Ok(g) => g,
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                return Err(format!("SSH shell protocol error: {e}"));
            }
            Err(_) => return Ok(()),
        };
        if !got {
            return Ok(());
        }
        let line_s = String::from_utf8_lossy(&line_buf);
        let trimmed = line_s.trim_end_matches(['\r', '\n']);
        let mut parts = trimmed.splitn(3, ' ');
        let (Some(tag), Some(id_s), payload) = (parts.next(), parts.next(), parts.next().unwrap_or("")) else {
            return Err("SSH shell protocol error: malformed response line".into());
        };
        let Ok(id) = id_s.parse::<u64>() else {
            return Err("SSH shell protocol error: invalid request id".into());
        };
        let decoded = match b64.decode(payload) {
            Ok(d) => d,
            Err(e) => {
                return Err(format!("SSH shell protocol error: invalid base64 payload ({e})"));
            }
        };
        let outcome = match tag {
            "OK" => RpcOutcome::Bytes(Ok(decoded)),
            "ERR" => RpcOutcome::Json(Err(String::from_utf8_lossy(&decoded).into_owned())),
            _ => return Err(format!("SSH shell protocol error: unknown tag '{tag}'")),
        };
        if let Some(tx) = lock_disp(dispatcher).pending.remove(&id) {
            let _ = tx.send(outcome);
        }
    }
}

fn parse_sh_version(text: &str) -> Option<FileVersion> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (token, size_s) = trimmed.split_once('\t')?;
    if token.is_empty() {
        return None;
    }
    let size: u64 = size_s.trim().parse().ok()?;
    Some(FileVersion {
        mtime: token.to_string(),
        size,
    })
}

fn parse_porcelain_v1_z(root: &str, raw: &[u8]) -> GitStatus {
    let tokens: Vec<&[u8]> = raw.split(|&b| b == 0).collect();
    let mut branch = None;
    let mut entries = BTreeMap::new();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        i += 1;
        if tok.is_empty() {
            continue;
        }
        if let Some(rest) = tok.strip_prefix(b"## ") {
            let header = String::from_utf8_lossy(rest);
            branch = if header.starts_with("HEAD (no branch)") || header == "HEAD" {
                None
            } else if let Some(b) = header
                .strip_prefix("No commits yet on ")
                .or_else(|| header.strip_prefix("Initial commit on "))
            {
                b.split("...").next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
            } else {
                header.split("...").next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
            };
            continue;
        }
        if tok.len() < 4 {
            continue;
        }
        let (x, y) = (tok[0] as char, tok[1] as char);
        let skip_next = matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C');
        let Ok(rel) = std::str::from_utf8(&tok[3..]) else {
            if skip_next {
                i += 1;
            }
            continue;
        };
        if skip_next {
            i += 1;
        }
        let code = match (x, y) {
            ('D', 'D') | ('A', 'U') | ('U', 'D') | ('U', 'A') | ('D', 'U') | ('A', 'A') | ('U', 'U') => {
                Some(GitCode::Conflicted)
            }
            ('D', _) | (_, 'D') => Some(GitCode::Deleted),
            ('R', _) => Some(GitCode::Renamed),
            ('A', _) => Some(GitCode::Added),
            ('M' | 'T', _) | (_, 'M' | 'T' | 'R') => Some(GitCode::Modified),
            ('?', '?') => Some(GitCode::Untracked),
            _ => None,
        };
        if let Some(code) = code {
            entries
                .entry(rel.to_string())
                .and_modify(|c: &mut GitCode| *c = (*c).min(code))
                .or_insert(code);
        }
    }
    GitStatus {
        root: root.trim_end_matches('/').to_string(),
        branch,
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_command_is_posix_sh_c_safe_across_all_login_shells() {
        for fallback in [false, true] {
            let cmd = bootstrap_command(fallback);
            assert!(cmd.starts_with("sh -c '") && cmd.ends_with('\''));
            let inner = &cmd["sh -c '".len()..cmd.len() - 1];
            assert!(!inner.contains('\''), "inner must not contain single quotes");
            assert!(!inner.contains('\\'), "inner must not contain backslashes");
            assert!(!inner.contains('!'), "inner must not contain exclamation marks");
        }
    }

    #[tokio::test]
    async fn read_line_bounded_rejects_oversized_frames() {
        let data = b"12345678901234567890\n".to_vec();
        let mut reader = BufReader::new(data.as_slice());
        let mut buf = Vec::new();
        let err = read_line_bounded(&mut reader, &mut buf, 10).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(buf.len() <= 10);

        let mut reader2 = BufReader::new(b"hello\nworld\n".as_slice());
        assert!(read_line_bounded(&mut reader2, &mut buf, 16).await.unwrap());
        assert_eq!(buf, b"hello\n");
        assert!(read_line_bounded(&mut reader2, &mut buf, 16).await.unwrap());
        assert_eq!(buf, b"world\n");
        assert!(!read_line_bounded(&mut reader2, &mut buf, 16).await.unwrap());
    }
}
