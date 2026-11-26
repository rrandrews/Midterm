//! SSH remote backend: manages registered SSH connections, multiplexed remote
//! helper daemons, remote file/git/search/watch/completion operations, and
//! cross-host transfers.

pub mod client;
pub mod commands;
pub mod location;
pub mod registry;
pub mod transfer;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;

use crate::fs::complete::CompletionEntry;
use crate::fs::file::{FileVersion, TextFile, WriteExpect, WriteResult};
use crate::fs::find::{FoundEntries, FoundFiles};
use crate::fs::git::GitStatus;
use crate::fs::list::FsEntry;
use crate::fs::search::{TextSearchEvent, TextSearchOptions};

use self::client::{RemoteClient, SearchCallback, WatchCallback};
use self::location::Location;
use self::registry::{
    RegisterSshConnection, SshConnectionInfo, SshStatus, ensure_socket_dir, fallback_ssh_args,
    validate_control_path, validate_registration, validate_restore, validate_safe_ssh_args,
    verify_live_socket_trust,
};

struct ConnectionEntry {
    info: SshConnectionInfo,
    control_path: PathBuf,
    owned_socket: bool,
    /// Incremented whenever the control socket changes or reconnect recreates
    /// the master, preventing stale helper installs or stale disconnect events
    /// from clobbering a newer connection generation.
    generation: u64,
    active_terminals: u32,
    client: Option<Arc<RemoteClient>>,
    /// Serializes connecting and reconnecting the helper/control master for
    /// this remote so concurrent callers share one handshake.
    connect_lock: Arc<AsyncMutex<()>>,
}

struct RemoteWatch {
    owner: String,
    /// Desired remote dirs per remote_id (empty when stopped).
    desired: HashMap<String, Vec<String>>,
    /// Last state acknowledged by each remote's helper: `remote_id -> (client_id, dirs)`.
    synced: HashMap<String, (u64, Vec<String>)>,
    stopped: bool,
    reconciling: bool,
    /// Sink receiving prefixed `ssh://<remote_id><path>` directories.
    sink: WatchCallback,
}

struct RemoteSearch {
    owner: String,
    remote_id: String,
    cancelled: Arc<AtomicBool>,
    started: bool,
}

/// Outcome of probing an OpenSSH ControlMaster socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketState {
    /// Verified Unix domain socket with a live ControlMaster responding to `-O check`.
    Alive,
    /// Verified Unix domain socket whose `-O check` completed promptly with failure (dead master).
    Stale,
    /// Path does not exist.
    Missing,
    /// Path exists as a symlink or non-socket file — MUST NOT be unlinked or used.
    NotSocket,
    /// Probe timed out or failed to execute — master may still be alive; MUST NOT unlink.
    ProbeTimedOut,
}

/// Synchronous snapshot of the validated parameters needed by `pty_spawn` to
/// launch a direct-SSH terminal pane into a known remote without blocking on
/// async locks.
#[derive(Debug, Clone)]
pub struct SshSpawnTarget {
    pub control_path: PathBuf,
    pub owned_socket: bool,
    pub ssh_args: Vec<String>,
}

/// Managed SSH state owned by Tauri (`app.manage(SshManager::default())`).
pub struct SshManager {
    inner: Arc<Inner>,
}

struct Inner {
    socket_dir: Mutex<Option<PathBuf>>,
    app: Mutex<Option<AppHandle>>,
    connections: AsyncMutex<HashMap<String, ConnectionEntry>>,
    spawn_targets: Mutex<HashMap<String, SshSpawnTarget>>,
    watches: Mutex<HashMap<u32, RemoteWatch>>,
    searches: Mutex<HashMap<u32, RemoteSearch>>,
}

impl Default for SshManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(Inner {
                socket_dir: Mutex::new(None),
                app: Mutex::new(None),
                connections: AsyncMutex::new(HashMap::new()),
                spawn_targets: Mutex::new(HashMap::new()),
                watches: Mutex::new(HashMap::new()),
                searches: Mutex::new(HashMap::new()),
            }),
        }
    }
}

impl Clone for SshManager {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Spawns an async task on the current Tokio runtime if available (tests,
/// async commands), falling back to Tauri's async runtime (sync commands on
/// the main thread).
fn spawn_bg<F>(fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(fut);
    } else {
        tauri::async_runtime::spawn(fut);
    }
}

impl SshManager {
    pub fn attach_app(&self, app: &AppHandle) {
        let mut slot = lock(&self.inner.app);
        if slot.is_none() {
            *slot = Some(app.clone());
        }
    }

    /// Returns (creating if needed) Midterm's short private (`0700`) ControlPath
    /// socket directory.
    pub fn socket_dir(&self) -> Result<PathBuf, String> {
        let mut slot = lock(&self.inner.socket_dir);
        if let Some(dir) = slot.as_ref() {
            return Ok(dir.clone());
        }
        let dir = ensure_socket_dir()?;
        *slot = Some(dir.clone());
        Ok(dir)
    }

    fn emit_change(&self, info: &SshConnectionInfo) {
        if let Some(app) = lock(&self.inner.app).as_ref() {
            let _ = app.emit("ssh-connection-changed", info);
        }
    }

    /// Registers a connection reported by a terminal's local `ssh` wrapper.
    pub async fn register(&self, reg: RegisterSshConnection) -> Result<SshConnectionInfo, String> {
        let sock_dir = self.socket_dir()?;
        let (control_path, safe_args) = validate_registration(&reg, &sock_dir)?;

        let info = {
            let mut map = self.inner.connections.lock().await;
            let entry = map.entry(reg.id.clone()).or_insert_with(|| ConnectionEntry {
                info: SshConnectionInfo {
                    id: reg.id.clone(),
                    label: reg.label.clone(),
                    host: reg.host.clone(),
                    user: reg.user.clone(),
                    port: reg.port,
                    remote_home: None,
                    remote_os: None,
                    remote_shell: None,
                    status: SshStatus::Connecting,
                    ssh_args: safe_args.clone(),
                },
                control_path: control_path.clone(),
                owned_socket: reg.owned_socket,
                generation: 1,
                active_terminals: 0,
                client: None,
                connect_lock: Arc::new(AsyncMutex::new(())),
            });
            entry.info.label = reg.label;
            entry.info.host = reg.host;
            entry.info.user = reg.user;
            entry.info.port = reg.port;
            if !safe_args.is_empty() {
                entry.info.ssh_args = safe_args;
            }
            if entry.control_path != control_path || entry.owned_socket != reg.owned_socket {
                entry.control_path = control_path;
                entry.owned_socket = reg.owned_socket;
                entry.generation = entry.generation.saturating_add(1);
                if let Some(old) = entry.client.take() {
                    spawn_bg(async move { old.close().await });
                }
            }
            entry.active_terminals = entry.active_terminals.saturating_add(1);
            if entry.client.as_ref().is_some_and(|c| c.is_alive()) {
                entry.info.status = SshStatus::Connected;
            } else {
                entry.info.status = SshStatus::Connecting;
            }
            // Do not synthesize fallback args when `ssh_args` is empty: empty
            // args indicate non-replayable CLI routing flags (-F, -o HostName,
            // etc.) where direct panes must stay multiplex-only over the live
            // master rather than reconnecting to a potentially different host.
            lock(&self.inner.spawn_targets).insert(
                reg.id.clone(),
                SshSpawnTarget {
                    control_path: entry.control_path.clone(),
                    owned_socket: entry.owned_socket,
                    ssh_args: entry.info.ssh_args.clone(),
                },
            );
            entry.info.clone()
        };

        self.emit_change(&info);
        Ok(info)
    }

    /// Restores persisted connection metadata (disconnected until reconnected or
    /// a terminal connects to the same remote id).
    #[allow(clippy::too_many_arguments)]
    pub async fn restore(
        &self,
        id: String,
        label: String,
        host: String,
        user: String,
        port: u16,
        remote_home: Option<String>,
        ssh_args: Vec<String>,
    ) -> Result<SshConnectionInfo, String> {
        let safe_args = validate_restore(&id, &host, &user, &ssh_args)?;
        let sock_dir = self.socket_dir()?;
        let default_sock = sock_dir.join(socket_filename_for(&id));

        {
            let map = self.inner.connections.lock().await;
            if let Some(existing) = map.get(&id) {
                return Ok(existing.info.clone());
            }
        }
        // Probe outside the connections mutex so a stalled socket cannot block
        // unrelated registry lookups or other restores.
        let alive = probe_control_socket(&default_sock).await == SocketState::Alive;

        let info = {
            let mut map = self.inner.connections.lock().await;
            if let Some(existing) = map.get(&id) {
                return Ok(existing.info.clone());
            }
            let info = SshConnectionInfo {
                id: id.clone(),
                label,
                host,
                user,
                port,
                remote_home,
                remote_os: None,
                remote_shell: None,
                status: if alive {
                    SshStatus::Connected
                } else {
                    SshStatus::Disconnected
                },
                ssh_args: safe_args,
            };
            lock(&self.inner.spawn_targets).insert(
                id.clone(),
                SshSpawnTarget {
                    control_path: default_sock.clone(),
                    owned_socket: true,
                    ssh_args: info.ssh_args.clone(),
                },
            );
            map.insert(
                id,
                ConnectionEntry {
                    info: info.clone(),
                    control_path: default_sock,
                    owned_socket: true,
                    generation: 1,
                    active_terminals: 0,
                    client: None,
                    connect_lock: Arc::new(AsyncMutex::new(())),
                },
            );
            info
        };
        Ok(info)
    }

    /// Synchronously returns validated direct-SSH spawn parameters for
    /// `remote_id` (used by synchronous `pty_spawn` on the main thread).
    /// When `ssh_args` is empty (non-replayable routing flags), the returned
    /// target triggers multiplex-only mode in `shell::ssh_command`.
    pub fn spawn_info_sync(&self, remote_id: &str) -> Result<SshSpawnTarget, String> {
        let sock_dir = self.socket_dir()?;
        let target = lock(&self.inner.spawn_targets)
            .get(remote_id)
            .cloned()
            .ok_or_else(|| format!("unknown SSH connection '{remote_id}'"))?;
        let path_str = target
            .control_path
            .to_str()
            .ok_or("control socket path is not valid UTF-8")?;
        validate_control_path(path_str, &sock_dir, target.owned_socket)?;
        let safe_args = validate_safe_ssh_args(&target.ssh_args)?;
        Ok(SshSpawnTarget {
            control_path: target.control_path,
            owned_socket: target.owned_socket,
            ssh_args: safe_args,
        })
    }

    pub async fn terminal_ended(&self, remote_id: &str) {
        let mut map = self.inner.connections.lock().await;
        if let Some(entry) = map.get_mut(remote_id) {
            entry.active_terminals = entry.active_terminals.saturating_sub(1);
        }
    }

    pub async fn list(&self) -> Vec<SshConnectionInfo> {
        self.inner
            .connections
            .lock()
            .await
            .values()
            .map(|e| e.info.clone())
            .collect()
    }

    /// Returns the stored control socket and validated safe SSH arguments for
    /// spawning a new direct-SSH terminal pane to `remote_id`.
    #[allow(dead_code)]
    pub async fn spawn_info(&self, remote_id: &str) -> Result<(PathBuf, Vec<String>), String> {
        let map = self.inner.connections.lock().await;
        let entry = map
            .get(remote_id)
            .ok_or_else(|| format!("unknown SSH connection '{remote_id}'"))?;
        let args = if entry.info.ssh_args.is_empty() {
            fallback_ssh_args(&entry.info.host, &entry.info.user, entry.info.port)?
        } else {
            validate_safe_ssh_args(&entry.info.ssh_args)?
        };
        Ok((entry.control_path.clone(), args))
    }

    /// Attempts a non-interactive (`BatchMode=yes`) reconnect for `remote_id`.
    /// Serialized per remote via `connect_lock`.
    pub async fn reconnect(&self, remote_id: &str) -> Result<SshConnectionInfo, String> {
        let connect_lock = {
            let map = self.inner.connections.lock().await;
            let entry = map
                .get(remote_id)
                .ok_or_else(|| format!("unknown SSH connection '{remote_id}'"))?;
            Arc::clone(&entry.connect_lock)
        };
        let _guard = connect_lock.lock().await;

        let sock_dir = self.socket_dir()?;
        let (control_path, owned_socket, safe_args) = {
            let map = self.inner.connections.lock().await;
            let entry = map
                .get(remote_id)
                .ok_or_else(|| format!("unknown SSH connection '{remote_id}'"))?;
            let args = validate_safe_ssh_args(&entry.info.ssh_args)?;
            (entry.control_path.clone(), entry.owned_socket, args)
        };

        let state = probe_control_socket(&control_path).await;
        match state {
            SocketState::Alive => {}
            SocketState::NotSocket => {
                return Err("control socket path is not a Unix domain socket".into());
            }
            SocketState::ProbeTimedOut => {
                return Err("SSH control socket probe timed out; try again shortly".into());
            }
            SocketState::Stale | SocketState::Missing => {
                if safe_args.is_empty() {
                    return Err(
                        "Cannot reconnect automatically because this session used custom SSH options; reconnect in your terminal."
                            .into(),
                    );
                }
                // Revalidate socket-directory trust BEFORE launching OpenSSH to
                // create or bind a master socket (both when stale AND when missing).
                let path_str = control_path
                    .to_str()
                    .ok_or("control socket path is not valid UTF-8")?;
                validate_control_path(path_str, &sock_dir, owned_socket)?;

                // Only unlink a verified stale, Midterm-owned socket inside our socket_dir.
                if state == SocketState::Stale {
                    if !owned_socket {
                        return Err(
                            "external SSH control socket is stale; reconnect in your terminal".into(),
                        );
                    }
                    verify_live_socket_trust(&control_path, &sock_dir, true)?;
                    let _ = std::fs::remove_file(&control_path);
                }

                let mut cmd = Command::new("ssh");
                cmd.arg("-o")
                    .arg("ControlMaster=auto")
                    .arg("-S")
                    .arg(&control_path)
                    .arg("-o")
                    .arg("ControlPersist=60s")
                    .arg("-o")
                    .arg("BatchMode=yes")
                    .arg("-o")
                    .arg("PermitLocalCommand=no")
                    .arg("-o")
                    .arg("ConnectTimeout=10")
                    .arg("-N")
                    .arg("-f")
                    .args(&safe_args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true);

                let output = tokio::time::timeout(Duration::from_secs(20), cmd.output())
                    .await
                    .map_err(|_| "SSH reconnect timed out".to_string())?
                    .map_err(|e| format!("failed to launch ssh: {e}"))?;

                if !output.status.success() {
                    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    return Err(if err.is_empty() {
                        "Could not reconnect non-interactively (authentication may be required in a terminal).".into()
                    } else {
                        err
                    });
                }
            }
        }

        let _ = self.connect_helper_locked(remote_id).await?;
        let map = self.inner.connections.lock().await;
        map.get(remote_id)
            .map(|e| e.info.clone())
            .ok_or_else(|| format!("unknown SSH connection '{remote_id}'"))
    }

    /// Returns an already-connected live helper without spawning a new one.
    async fn existing_client(&self, remote_id: &str) -> Option<Arc<RemoteClient>> {
        let map = self.inner.connections.lock().await;
        map.get(remote_id)
            .and_then(|e| e.client.as_ref())
            .filter(|c| c.is_alive())
            .cloned()
    }

    /// Returns a live [`RemoteClient`] for `remote_id`, lazily spawning it over
    /// the connection's ControlMaster socket on first use (or after a drop if
    /// the control socket is alive again).
    pub async fn client(&self, remote_id: &str) -> Result<Arc<RemoteClient>, String> {
        let connect_lock = {
            let map = self.inner.connections.lock().await;
            let entry = map
                .get(remote_id)
                .ok_or_else(|| format!("SSH host '{remote_id}' is not connected"))?;
            if let Some(c) = &entry.client
                && c.is_alive()
            {
                return Ok(Arc::clone(c));
            }
            Arc::clone(&entry.connect_lock)
        };

        let _guard = connect_lock.lock().await;
        self.connect_helper_locked(remote_id).await
    }

    /// Connects and installs a helper while holding the connection's
    /// `connect_lock`, verifying socket trust and connection generation so a
    /// concurrent `register()` replacing `control_path` can never be clobbered.
    async fn connect_helper_locked(&self, remote_id: &str) -> Result<Arc<RemoteClient>, String> {
        let sock_dir = self.socket_dir()?;

        for _attempt in 0..3 {
            let (control_path, owned_socket, generation) = {
                let map = self.inner.connections.lock().await;
                let entry = map
                    .get(remote_id)
                    .ok_or_else(|| format!("SSH host '{remote_id}' is not connected"))?;
                if let Some(c) = &entry.client
                    && c.is_alive()
                {
                    return Ok(Arc::clone(c));
                }
                (entry.control_path.clone(), entry.owned_socket, entry.generation)
            };

            // Wait briefly for the control socket to appear if a terminal just
            // started `ssh` a few milliseconds ago.
            let mut state = probe_control_socket(&control_path).await;
            if state == SocketState::Missing {
                for _ in 0..20 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    state = probe_control_socket(&control_path).await;
                    if state != SocketState::Missing {
                        break;
                    }
                }
            }
            if state != SocketState::Alive {
                self.mark_disconnected(remote_id, generation).await;
                return Err(match state {
                    SocketState::NotSocket => {
                        format!("SSH control path for '{remote_id}' is not a valid socket")
                    }
                    _ => format!("SSH connection '{remote_id}' is not active"),
                });
            }

            // Re-verify ownership, permissions, and socket type immediately before connecting.
            verify_live_socket_trust(&control_path, &sock_dir, owned_socket)?;

            let mgr = self.clone();
            let rid = remote_id.to_string();
            let on_disconnect: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                let mgr = mgr.clone();
                let rid = rid.clone();
                spawn_bg(async move {
                    mgr.mark_disconnected(&rid, generation).await;
                });
            });

            let client = match RemoteClient::connect(&control_path, on_disconnect).await {
                Ok(c) => c,
                Err(e) => {
                    self.mark_disconnected(remote_id, generation).await;
                    return Err(e);
                }
            };

            enum InstallResult {
                Installed(SshConnectionInfo),
                Superseded,
                Removed,
            }

            let install = {
                let mut map = self.inner.connections.lock().await;
                match map.get_mut(remote_id) {
                    Some(entry) if entry.generation == generation => {
                        if let Some(home) = &client.hello.home {
                            entry.info.remote_home = Some(home.clone());
                        }
                        if let Some(os) = &client.hello.os {
                            entry.info.remote_os = Some(os.clone());
                        }
                        entry.info.status = SshStatus::Connected;
                        entry.client = Some(Arc::clone(&client));
                        InstallResult::Installed(entry.info.clone())
                    }
                    Some(_) => InstallResult::Superseded,
                    None => InstallResult::Removed,
                }
            };

            match install {
                InstallResult::Installed(info) => {
                    self.emit_change(&info);
                    // Whenever a new helper generation comes online (whether via
                    // explicit reconnect or lazy replacement), restore desired watches.
                    self.reconcile_watches_for(remote_id);
                    return Ok(client);
                }
                InstallResult::Superseded => {
                    spawn_bg(async move { client.close().await });
                    continue;
                }
                InstallResult::Removed => {
                    spawn_bg(async move { client.close().await });
                    return Err(format!("SSH host '{remote_id}' was removed"));
                }
            }
        }

        Err(format!("SSH connection '{remote_id}' changed repeatedly during connect"))
    }

    async fn mark_disconnected(&self, remote_id: &str, expected_gen: u64) {
        let updated = {
            let mut map = self.inner.connections.lock().await;
            if let Some(entry) = map.get_mut(remote_id) {
                if entry.generation != expected_gen {
                    return;
                }
                if entry.client.as_ref().is_some_and(|c| c.is_alive()) {
                    return;
                }
                entry.client = None;
                if entry.info.status != SshStatus::Disconnected {
                    entry.info.status = SshStatus::Disconnected;
                    Some(entry.info.clone())
                } else {
                    None
                }
            } else {
                None
            }
        };
        if let Some(info) = updated {
            self.emit_change(&info);
        }
    }

    // --- Remote FS Operations (returning paths prefixed with `ssh://<remote_id>`) ---

    pub async fn list_dir(
        &self,
        remote_id: &str,
        path: &str,
        show_hidden: bool,
    ) -> Result<Vec<FsEntry>, String> {
        let mut entries = self.client(remote_id).await?.list_dir(path, show_hidden).await?;
        for entry in &mut entries {
            entry.path = Location::format_remote(remote_id, &entry.path);
        }
        Ok(entries)
    }

    pub async fn stat(&self, remote_id: &str, path: &str) -> Result<Option<FsEntry>, String> {
        let mut entry = self.client(remote_id).await?.stat(path).await?;
        if let Some(e) = &mut entry {
            e.path = Location::format_remote(remote_id, &e.path);
        }
        Ok(entry)
    }

    pub async fn create(&self, remote_id: &str, path: &str, dir: bool) -> Result<(), String> {
        self.client(remote_id).await?.create(path, dir).await
    }

    pub async fn rename(&self, remote_id: &str, from: &str, to: &str) -> Result<(), String> {
        self.client(remote_id).await?.rename(from, to).await
    }

    pub async fn delete(&self, remote_id: &str, paths: &[String]) -> Result<(), String> {
        for p in paths {
            if p.is_empty() || p.trim_end_matches('/').is_empty() {
                return Err("refusing to delete remote filesystem root".into());
            }
        }
        self.client(remote_id).await?.delete(paths).await
    }

    pub async fn copy_into(
        &self,
        remote_id: &str,
        from: &str,
        to_dir: &str,
    ) -> Result<String, String> {
        let created = self.client(remote_id).await?.copy_into(from, to_dir).await?;
        Ok(Location::format_remote(remote_id, &created))
    }

    pub async fn read_text(
        &self,
        remote_id: &str,
        path: &str,
        limit: u64,
    ) -> Result<TextFile, String> {
        self.client(remote_id).await?.read_text(path, limit).await
    }

    pub async fn read_bytes(
        &self,
        remote_id: &str,
        path: &str,
        limit: u64,
    ) -> Result<Vec<u8>, String> {
        self.client(remote_id).await?.read_bytes(path, limit).await
    }

    pub async fn write_text(
        &self,
        remote_id: &str,
        path: &str,
        text: &str,
        expect: &WriteExpect,
    ) -> Result<WriteResult, String> {
        self.client(remote_id)
            .await?
            .write_text(path, text, expect)
            .await
    }

    pub async fn file_version(
        &self,
        remote_id: &str,
        path: &str,
    ) -> Result<Option<FileVersion>, String> {
        self.client(remote_id).await?.file_version(path).await
    }

    pub async fn git_status(
        &self,
        remote_id: &str,
        path: &str,
    ) -> Result<Option<GitStatus>, String> {
        let mut status = self.client(remote_id).await?.git_status(path).await?;
        if let Some(s) = &mut status {
            s.root = Location::format_remote(remote_id, &s.root);
        }
        Ok(status)
    }

    pub async fn find_files(
        &self,
        remote_id: &str,
        root: &str,
        limit: usize,
    ) -> Result<FoundFiles, String> {
        self.client(remote_id).await?.find_files(root, limit).await
    }

    pub async fn find_entries(
        &self,
        remote_id: &str,
        root: &str,
        limit: usize,
        show_hidden: bool,
    ) -> Result<FoundEntries, String> {
        self.client(remote_id)
            .await?
            .find_entries(root, limit, show_hidden)
            .await
    }

    pub async fn path_commands(
        &self,
        remote_id: &str,
        path: Option<&str>,
    ) -> Result<Vec<String>, String> {
        self.client(remote_id).await?.path_commands(path).await
    }

    pub async fn complete_list(
        &self,
        remote_id: &str,
        dir: &str,
    ) -> Result<Vec<CompletionEntry>, String> {
        self.client(remote_id).await?.complete_list(dir).await
    }

    // --- Remote streaming text search (retaining cancellation across startup) ---

    pub fn start_search(
        &self,
        search_id: u32,
        owner: &str,
        remote_id: String,
        root: String,
        options: TextSearchOptions,
        emit: SearchCallback,
    ) {
        let cancelled = Arc::new(AtomicBool::new(false));
        lock(&self.inner.searches).insert(
            search_id,
            RemoteSearch {
                owner: owner.to_string(),
                remote_id: remote_id.clone(),
                cancelled: Arc::clone(&cancelled),
                started: false,
            },
        );
        let mgr = self.clone();
        spawn_bg(async move {
            let cleanup_mgr = mgr.clone();
            let wrapped: SearchCallback = Arc::new(move |ev| {
                let terminal = matches!(
                    ev,
                    TextSearchEvent::Done { .. } | TextSearchEvent::Error { .. }
                );
                emit(ev);
                if terminal {
                    lock(&cleanup_mgr.inner.searches).remove(&search_id);
                }
            });

            if cancelled.load(Ordering::SeqCst) {
                wrapped(TextSearchEvent::Done {
                    truncated: false,
                    cancelled: true,
                    files_searched: 0,
                });
                return;
            }

            let client = match mgr.client(&remote_id).await {
                Ok(c) => c,
                Err(message) => {
                    if cancelled.load(Ordering::SeqCst) {
                        wrapped(TextSearchEvent::Done {
                            truncated: false,
                            cancelled: true,
                            files_searched: 0,
                        });
                    } else {
                        wrapped(TextSearchEvent::Error { message });
                    }
                    return;
                }
            };

            if cancelled.load(Ordering::SeqCst) {
                wrapped(TextSearchEvent::Done {
                    truncated: false,
                    cancelled: true,
                    files_searched: 0,
                });
                return;
            }

            if let Err(message) = client
                .search_start(search_id, &root, &options, Arc::clone(&wrapped))
                .await
            {
                wrapped(TextSearchEvent::Error { message });
                return;
            }

            // Mark started and check if cancellation arrived while search_start was in flight.
            let cancelled_mid_start = {
                let mut map = lock(&mgr.inner.searches);
                if let Some(entry) = map.get_mut(&search_id) {
                    entry.started = true;
                    entry.cancelled.load(Ordering::SeqCst)
                } else {
                    cancelled.load(Ordering::SeqCst)
                }
            };
            if cancelled_mid_start {
                lock(&mgr.inner.searches).remove(&search_id);
                client.search_cancel(search_id).await;
            }
        });
    }

    pub fn cancel_search(&self, search_id: u32) {
        let to_cancel_now: Option<String> = {
            let mut map = lock(&self.inner.searches);
            if let Some(entry) = map.get_mut(&search_id) {
                entry.cancelled.store(true, Ordering::SeqCst);
                if entry.started {
                    let rid = entry.remote_id.clone();
                    map.remove(&search_id);
                    Some(rid)
                } else {
                    // Startup task still owns the entry and will skip starting or cancel after ack.
                    None
                }
            } else {
                None
            }
        };
        if let Some(remote_id) = to_cancel_now {
            let mgr = self.clone();
            spawn_bg(async move {
                if let Some(client) = mgr.existing_client(&remote_id).await {
                    client.search_cancel(search_id).await;
                }
            });
        }
    }

    // --- Remote directory watching (serialized per watch ID, auto-restored per helper) ---

    pub fn register_watch(&self, watch_id: u32, owner: &str, sink: WatchCallback) {
        lock(&self.inner.watches).insert(
            watch_id,
            RemoteWatch {
                owner: owner.to_string(),
                desired: HashMap::new(),
                synced: HashMap::new(),
                stopped: false,
                reconciling: false,
                sink,
            },
        );
    }

    pub fn set_watch_dirs(&self, watch_id: u32, by_remote: HashMap<String, Vec<String>>) {
        let should_spawn = {
            let mut watches = lock(&self.inner.watches);
            let Some(entry) = watches.get_mut(&watch_id) else {
                return;
            };
            if entry.stopped {
                return;
            }
            entry.desired = by_remote
                .into_iter()
                .filter(|(_, dirs)| !dirs.is_empty())
                .collect();
            if entry.desired.is_empty() && entry.synced.is_empty() {
                false
            } else if !entry.reconciling {
                entry.reconciling = true;
                true
            } else {
                false
            }
        };
        if should_spawn {
            self.spawn_watch_reconciler(watch_id);
        }
    }

    pub fn stop_watch(&self, watch_id: u32) {
        let should_spawn = {
            let mut watches = lock(&self.inner.watches);
            let Some(entry) = watches.get_mut(&watch_id) else {
                return;
            };
            entry.stopped = true;
            entry.desired.clear();
            if entry.synced.is_empty() && !entry.reconciling {
                watches.remove(&watch_id);
                false
            } else if !entry.reconciling {
                entry.reconciling = true;
                true
            } else {
                false
            }
        };
        if should_spawn {
            self.spawn_watch_reconciler(watch_id);
        }
    }

    /// Triggers reconciliation for every active watcher interested in `remote_id`
    /// (called whenever a new helper generation becomes active).
    fn reconcile_watches_for(&self, remote_id: &str) {
        let to_spawn: Vec<u32> = {
            let mut watches = lock(&self.inner.watches);
            let mut ids = Vec::new();
            for (&wid, entry) in watches.iter_mut() {
                if !entry.stopped && entry.desired.contains_key(remote_id) && !entry.reconciling {
                    entry.reconciling = true;
                    ids.push(wid);
                }
            }
            ids
        };
        for wid in to_spawn {
            self.spawn_watch_reconciler(wid);
        }
    }

    /// Runs a single serialized reconciliation loop for `watch_id`, applying
    /// `watch_stop` and `watch_set` in order through helper acknowledgement
    /// until remote state converges with the latest desired/stopped state.
    fn spawn_watch_reconciler(&self, watch_id: u32) {
        let mgr = self.clone();
        spawn_bg(async move {
            use std::collections::HashSet;
            enum WatchAction {
                Stop(String),
                Set(String, Vec<String>, WatchCallback),
            }

            // Remotes that failed in the current pass: skip them so other
            // healthy hosts in the same watcher are still reconciled, and reset
            // if newer desired state arrives before we go idle.
            let mut failed_in_pass: HashSet<String> = HashSet::new();

            loop {
                let (desired, synced, stopped, sink) = {
                    let watches = lock(&mgr.inner.watches);
                    let Some(entry) = watches.get(&watch_id) else {
                        return;
                    };
                    (
                        entry.desired.clone(),
                        entry.synced.clone(),
                        entry.stopped,
                        Arc::clone(&entry.sink),
                    )
                };

                let mut next_action: Option<WatchAction> = None;

                // 1. Stop any remote that was synced before but is no longer desired.
                for rid in synced.keys() {
                    if stopped || !desired.contains_key(rid) {
                        next_action = Some(WatchAction::Stop(rid.clone()));
                        break;
                    }
                }

                // 2. Otherwise, find any desired remote not yet failed this pass whose
                //    helper client_id or dir list differs from synced.
                if next_action.is_none() && !stopped {
                    for (rid, dirs) in &desired {
                        if failed_in_pass.contains(rid) {
                            continue;
                        }
                        let live_id = mgr.existing_client(rid).await.map(|c| c.client_id);
                        let matches = match (live_id, synced.get(rid)) {
                            (Some(cid), Some((synced_cid, synced_dirs))) => {
                                *synced_cid == cid && synced_dirs == dirs
                            }
                            _ => false,
                        };
                        if !matches {
                            next_action = Some(WatchAction::Set(
                                rid.clone(),
                                dirs.clone(),
                                Arc::clone(&sink),
                            ));
                            break;
                        }
                    }
                }

                let Some(action) = next_action else {
                    // Re-check under lock so any desired/stopped update that
                    // arrived while we were processing never gets dropped.
                    let mut watches = lock(&mgr.inner.watches);
                    let Some(entry) = watches.get_mut(&watch_id) else {
                        return;
                    };
                    if entry.desired != desired || entry.stopped != stopped {
                        failed_in_pass.clear();
                        continue;
                    }
                    entry.reconciling = false;
                    if entry.stopped && entry.synced.is_empty() {
                        watches.remove(&watch_id);
                    }
                    return;
                };

                match action {
                    WatchAction::Stop(rid) => {
                        if let Some(client) = mgr.existing_client(&rid).await {
                            client.watch_stop(watch_id).await;
                        }
                        failed_in_pass.remove(&rid);
                        let mut watches = lock(&mgr.inner.watches);
                        if let Some(entry) = watches.get_mut(&watch_id) {
                            entry.synced.remove(&rid);
                        }
                    }
                    WatchAction::Set(rid, dirs, sink) => match mgr.client(&rid).await {
                        Ok(client) => {
                            let cid = client.client_id;
                            let rid_cb = rid.clone();
                            let prefixed: WatchCallback = Arc::new(move |changed| {
                                let mapped = changed
                                    .into_iter()
                                    .map(|d| Location::format_remote(&rid_cb, &d))
                                    .collect();
                                sink(mapped);
                            });
                            if client.watch_set(watch_id, dirs.clone(), prefixed).await.is_ok() {
                                let mut watches = lock(&mgr.inner.watches);
                                if let Some(entry) = watches.get_mut(&watch_id) {
                                    entry.synced.insert(rid, (cid, dirs));
                                }
                            } else {
                                failed_in_pass.insert(rid.clone());
                                let mut watches = lock(&mgr.inner.watches);
                                if let Some(entry) = watches.get_mut(&watch_id) {
                                    entry.synced.remove(&rid);
                                }
                            }
                        }
                        Err(_) => {
                            // Remote currently offline: skip it for the rest of this
                            // pass so healthy hosts still get reconciled; the next
                            // helper activation on `rid` will re-trigger reconciliation.
                            failed_in_pass.insert(rid.clone());
                            let mut watches = lock(&mgr.inner.watches);
                            if let Some(entry) = watches.get_mut(&watch_id) {
                                entry.synced.remove(&rid);
                            }
                        }
                    },
                }
            }
        });
    }

    // --- Window / App lifecycle cleanup ---

    pub fn cleanup_owned_by(&self, owner: &str) {
        let search_ids: Vec<u32> = {
            let s = lock(&self.inner.searches);
            s.iter()
                .filter(|(_, e)| e.owner == owner)
                .map(|(&id, _)| id)
                .collect()
        };
        for id in search_ids {
            self.cancel_search(id);
        }

        let watch_ids: Vec<u32> = {
            let w = lock(&self.inner.watches);
            w.iter()
                .filter(|(_, e)| e.owner == owner)
                .map(|(&id, _)| id)
                .collect()
        };
        for wid in watch_ids {
            self.stop_watch(wid);
        }
    }

    /// Shuts down every remote helper process and closes Midterm-owned
    /// OpenSSH ControlMaster sockets cleanly on app exit.
    pub fn shutdown_all(&self) {
        let mgr = self.clone();
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            let Ok(rt) = rt else { return };
            rt.block_on(async move {
                let entries: Vec<(Option<Arc<RemoteClient>>, PathBuf, bool)> = {
                    lock(&mgr.inner.spawn_targets).clear();
                    let mut map = mgr.inner.connections.lock().await;
                    map.drain()
                        .map(|(_, e)| (e.client, e.control_path, e.owned_socket))
                        .collect()
                };
                for (client, sock, owned) in entries {
                    if let Some(c) = client {
                        c.close().await;
                    }
                    if owned && is_unix_socket(&sock) {
                        let mut cmd = Command::new("ssh");
                        cmd.arg("-F")
                            .arg("/dev/null")
                            .arg("-S")
                            .arg(&sock)
                            .arg("-O")
                            .arg("exit")
                            .arg("placeholder")
                            .stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .kill_on_drop(true);
                        let _ = tokio::time::timeout(Duration::from_secs(2), cmd.status()).await;
                    }
                }
            });
        })
        .join();
    }
}

fn is_unix_socket(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        std::fs::symlink_metadata(path)
            .is_ok_and(|m| !m.file_type().is_symlink() && m.file_type().is_socket())
    }
    #[cfg(not(unix))]
    {
        path.exists()
    }
}

/// Probes an OpenSSH ControlMaster socket, distinguishing a live master, a
/// verified stale socket, a missing path, a non-socket/symlink, and a timeout.
pub async fn probe_control_socket(control_path: &Path) -> SocketState {
    match std::fs::symlink_metadata(control_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return SocketState::Missing,
        Err(_) => return SocketState::NotSocket,
        Ok(meta) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::FileTypeExt;
                if meta.file_type().is_symlink() || !meta.file_type().is_socket() {
                    return SocketState::NotSocket;
                }
            }
            #[cfg(not(unix))]
            let _ = meta;
        }
    }

    let mut cmd = Command::new("ssh");
    cmd.arg("-F")
        .arg("/dev/null")
        .arg("-S")
        .arg(control_path)
        .arg("-O")
        .arg("check")
        .arg("placeholder")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    match tokio::time::timeout(Duration::from_secs(3), cmd.status()).await {
        Ok(Ok(st)) if st.success() => SocketState::Alive,
        Ok(Ok(_)) => SocketState::Stale,
        Ok(Err(_)) | Err(_) => SocketState::ProbeTimedOut,
    }
}

/// Derives a short deterministic socket filename (<= 16 chars) from a remote id.
/// Matches `run.sh`'s `s-<12-hex>` convention when `remote_id` ends with a
/// 12-hex hash suffix so sockets stay consistent across app restarts.
pub fn socket_filename_for(remote_id: &str) -> String {
    if let Some((_, suffix)) = remote_id.rsplit_once('-')
        && suffix.len() == 12
        && suffix.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return format!("s-{suffix}");
    }
    // Fallback FNV-1a 64-bit hex hash for synthetic IDs in tests.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in remote_id.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}
