//! Tauri commands: thin adapters between the webview and the local file system
//! / git helpers of this module, plus remote SSH routing via [`SshManager`].
//! `src/ipc/fs.ts` is the only caller (`src/ipc/complete.ts` for the two
//! completion commands).
//!
//! Any path starting with `ssh://<remote_id>/...` routes to [`SshManager`];
//! plain paths stay on the local file system.
//!
//! The file system and git commands are `async` and do their work on Tauri's
//! blocking pool (for local paths) or asynchronously over the multiplexed SSH
//! helper (for remote paths).
//!
//! The watch commands are synchronous instead, like `pty_spawn`: run on the
//! main thread, they are ordered with each other and with the window cleanup
//! in `lib.rs`. They never block.

use std::collections::HashMap;
use std::sync::Arc;

use tauri::ipc::{Channel, Response};
use tauri::{State, Window};

use std::sync::atomic::Ordering;

use crate::ssh::SshManager;
use crate::ssh::location::Location;
use crate::ssh::transfer::{copy_cross_host, copy_cross_host_with_progress};

use super::complete::{self, CompletionEntry};
use super::copy::{self, CopyError, CopyProgress, TransferEvent, TransferManager};
use super::file::{self, FileVersion, TextFile, WriteExpect, WriteResult};
use super::find::{self, FoundEntries, FoundFiles};
use super::git::{self, GitStatus};
use super::list::{self, FsEntry};
use super::ops;
use super::search::{self, SearchManager, TextSearchEvent, TextSearchOptions};
use super::watch::{WatchEvent, WatchManager};

/// Runs `job` on the blocking thread pool.
async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}

/// The entries of the directory `path`; see [`list::list_dir`].
#[tauri::command]
pub async fn fs_list_dir(
    ssh: State<'_, SshManager>,
    path: String,
    show_hidden: bool,
) -> Result<Vec<FsEntry>, String> {
    match Location::parse(&path)? {
        Location::Local(p) => blocking(move || list::list_dir(&p, show_hidden)).await,
        Location::Remote { remote_id, path } => ssh.list_dir(&remote_id, &path, show_hidden).await,
    }
}

/// `path`'s entry, or `null` if nothing is there. `ignored` is always false.
#[tauri::command]
pub async fn fs_stat(ssh: State<'_, SshManager>, path: String) -> Result<Option<FsEntry>, String> {
    match Location::parse(&path)? {
        Location::Local(p) => blocking(move || list::stat(&p)).await,
        Location::Remote { remote_id, path } => ssh.stat(&remote_id, &path).await,
    }
}

/// Opens an existing local file or directory with its default application
/// (Finder for a directory). Through the opener plugin's Rust API, so the
/// webview needs no `opener:allow-open-path` scope covering every path.
#[tauri::command]
pub async fn fs_open_default(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let Location::Local(target) = Location::parse(&path)? else {
        return Err("cannot open a remote SSH file in a local application".into());
    };
    if !target.is_absolute() {
        return Err(format!("not an absolute path: {path}"));
    }
    // Only regular files and directories (following links): not a FIFO,
    // socket or device, which the launcher has no business opening.
    let openable = blocking(move || Ok(target.is_file() || target.is_dir())).await?;
    if !openable {
        return Err(format!("not a file or directory: {path}"));
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Creates an empty file, or a directory if `dir`. Fails if `path` exists.
#[tauri::command]
pub async fn fs_create(
    ssh: State<'_, SshManager>,
    path: String,
    dir: bool,
) -> Result<(), String> {
    match Location::parse(&path)? {
        Location::Local(p) => blocking(move || ops::create(&p, dir)).await,
        Location::Remote { remote_id, path } => ssh.create(&remote_id, &path, dir).await,
    }
}

/// Renames or moves `from` to `to`. Fails if `to` exists or if `from` and `to`
/// are on different hosts.
#[tauri::command]
pub async fn fs_rename(
    ssh: State<'_, SshManager>,
    from: String,
    to: String,
) -> Result<(), String> {
    match (Location::parse(&from)?, Location::parse(&to)?) {
        (Location::Local(a), Location::Local(b)) => blocking(move || ops::rename(&a, &b)).await,
        (
            Location::Remote { remote_id: r1, path: a },
            Location::Remote { remote_id: r2, path: b },
        ) if r1 == r2 => ssh.rename(&r1, &a, &b).await,
        _ => Err("cannot move entries across different hosts; use Copy instead".into()),
    }
}

/// Moves local `paths` to the system trash. Remote SSH paths are rejected
/// because remote hosts do not have a local Trash; callers must ask for
/// permanent deletion and invoke [`fs_delete_permanent`].
#[tauri::command]
pub async fn fs_trash(paths: Vec<String>) -> Result<(), String> {
    let mut local = Vec::with_capacity(paths.len());
    for raw in paths {
        match Location::parse(&raw)? {
            Location::Local(p) => local.push(p.to_string_lossy().into_owned()),
            Location::Remote { .. } => {
                return Err(
                    "remote SSH paths cannot be moved to Trash; use permanent delete instead"
                        .into(),
                );
            }
        }
    }
    blocking(move || ops::trash(&local)).await
}

/// Permanently deletes remote SSH `paths` (only after the caller has obtained
/// explicit permanent-delete confirmation naming the remote host). Refuses
/// local paths and remote filesystem roots.
#[tauri::command]
pub async fn fs_delete_permanent(
    ssh: State<'_, SshManager>,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut by_remote: HashMap<String, Vec<String>> = HashMap::new();
    for raw in paths {
        match Location::parse(&raw)? {
            Location::Local(_) => {
                return Err("fs_delete_permanent only supports remote SSH paths".into());
            }
            Location::Remote { remote_id, path } => {
                if path == "/" {
                    return Err("refusing to delete remote filesystem root".into());
                }
                by_remote.entry(remote_id).or_default().push(path);
            }
        }
    }
    for (remote_id, remote_paths) in by_remote {
        ssh.delete(&remote_id, &remote_paths).await?;
    }
    Ok(())
}

/// Files under `root` (relative paths), up to `limit`; see [`find::find_files`].
#[tauri::command]
pub async fn fs_find_files(
    ssh: State<'_, SshManager>,
    root: String,
    limit: usize,
) -> Result<FoundFiles, String> {
    match Location::parse(&root)? {
        Location::Local(p) => blocking(move || find::find_files(&p, limit)).await,
        Location::Remote { remote_id, path } => ssh.find_files(&remote_id, &path, limit).await,
    }
}

/// Files and directories under `root`, up to `limit`; see [`find::find_entries`].
#[tauri::command]
pub async fn fs_find_entries(
    ssh: State<'_, SshManager>,
    root: String,
    limit: usize,
    show_hidden: bool,
) -> Result<FoundEntries, String> {
    match Location::parse(&root)? {
        Location::Local(p) => blocking(move || find::find_entries(&p, limit, show_hidden)).await,
        Location::Remote { remote_id, path } => {
            ssh.find_entries(&remote_id, &path, limit, show_hidden).await
        }
    }
}

/// Copies `from` into the directory `to_dir` under a name that is free;
/// returns the copy's path. Supports local, same-remote (zero network
/// transfer), and cross-host (`Local ↔ Remote` or `Remote A → Remote B`).
#[tauri::command]
pub async fn fs_copy(
    ssh: State<'_, SshManager>,
    from: String,
    to_dir: String,
) -> Result<String, String> {
    let from_loc = Location::parse(&from)?;
    let to_loc = Location::parse(&to_dir)?;
    match (&from_loc, &to_loc) {
        (Location::Local(a), Location::Local(b)) => {
            let (a, b) = (a.clone(), b.clone());
            blocking(move || copy::copy_into(&a, &b)).await
        }
        (
            Location::Remote { remote_id: r1, path: a },
            Location::Remote { remote_id: r2, path: b },
        ) if r1 == r2 => ssh.copy_into(r1, a, b).await,
        _ => copy_cross_host(&ssh, &from_loc, &to_loc).await,
    }
}

/// Starts a copy with streaming progress and cancellation support. Returns the
/// transfer id immediately; progress, completion (`done`) or `error` arrive on
/// `on_event`.
#[tauri::command]
pub fn fs_copy_start(
    window: Window,
    transfers: State<'_, Arc<TransferManager>>,
    ssh: State<'_, SshManager>,
    from: String,
    to_dir: String,
    on_event: Channel<TransferEvent>,
) -> Result<u32, String> {
    let from_loc = Location::parse(&from)?;
    let to_loc = Location::parse(&to_dir)?;
    let (id, cancel) = transfers.register(window.label())?;
    let transfers = transfers.inner().clone();
    let ssh = ssh.inner().clone();

    tauri::async_runtime::spawn(async move {
        let result: Result<String, CopyError> = match (&from_loc, &to_loc) {
            (Location::Local(a), Location::Local(b)) => {
                let (a, b) = (a.clone(), b.clone());
                let cancel_flag = cancel.clone();
                let ch = on_event.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    copy::copy_into_with_progress(&a, &b, &cancel_flag, &mut |progress| {
                        if ch.send(TransferEvent::Progress(progress)).is_err() {
                            cancel_flag.store(true, Ordering::Relaxed);
                        }
                    })
                })
                .await
                .map_err(|e| CopyError::Failed(format!("background task failed: {e}")))
                .and_then(|res| res)
            }
            (
                Location::Remote { remote_id: r1, path: a },
                Location::Remote { remote_id: r2, path: b },
            ) if r1 == r2 => {
                let name = a.rsplit('/').next().unwrap_or(a).to_string();
                let _ = on_event.send(TransferEvent::Progress(CopyProgress {
                    bytes_transferred: 0,
                    total_bytes: None,
                    files_completed: 0,
                    total_files: None,
                    current_file: Some(name),
                }));
                if cancel.load(Ordering::Relaxed) {
                    Err(CopyError::Cancelled)
                } else {
                    ssh.copy_into(r1, a, b).await.map_err(CopyError::Failed)
                }
            }
            _ => {
                let ch = on_event.clone();
                let cancel_flag = cancel.clone();
                copy_cross_host_with_progress(&ssh, &from_loc, &to_loc, &cancel_flag, &mut |progress| {
                    if ch.send(TransferEvent::Progress(progress)).is_err() {
                        cancel_flag.store(true, Ordering::Relaxed);
                    }
                })
                .await
            }
        };

        transfers.finish(id);
        match result {
            Ok(path) => {
                let _ = on_event.send(TransferEvent::Done { path });
            }
            Err(CopyError::Cancelled) => {
                let _ = on_event.send(TransferEvent::Error {
                    message: "Transfer cancelled".into(),
                    cancelled: true,
                });
            }
            Err(CopyError::Failed(message)) => {
                let _ = on_event.send(TransferEvent::Error {
                    message,
                    cancelled: false,
                });
            }
        }
    });

    Ok(id)
}

/// Cancels a running file transfer owned by the calling window. Unknown ids
/// or ids belonging to another window are ignored.
#[tauri::command]
pub fn fs_copy_cancel(
    window: Window,
    transfers: State<'_, Arc<TransferManager>>,
    id: u32,
) -> Result<(), String> {
    transfers.cancel_for_window(window.label(), id);
    Ok(())
}

/// The file's text, or why it cannot be shown as text; see [`file::read_text`].
#[tauri::command]
pub async fn fs_read_text(ssh: State<'_, SshManager>, path: String) -> Result<TextFile, String> {
    match Location::parse(&path)? {
        Location::Local(p) => blocking(move || file::read_text(&p, file::TEXT_LIMIT)).await,
        Location::Remote { remote_id, path } => {
            ssh.read_text(&remote_id, &path, file::TEXT_LIMIT).await
        }
    }
}

/// The file's raw bytes (sent as an `ArrayBuffer`, not JSON).
#[tauri::command]
pub async fn fs_read_bytes(ssh: State<'_, SshManager>, path: String) -> Result<Response, String> {
    match Location::parse(&path)? {
        Location::Local(p) => blocking(move || file::read_bytes(&p, file::BYTES_LIMIT))
            .await
            .map(Response::new),
        Location::Remote { remote_id, path } => ssh
            .read_bytes(&remote_id, &path, file::BYTES_LIMIT)
            .await
            .map(Response::new),
    }
}

/// Writes `text` atomically, unless what is on disk does not match
/// `expect`; see [`file::write_text`].
#[tauri::command]
pub async fn fs_write_text(
    ssh: State<'_, SshManager>,
    path: String,
    text: String,
    expect: WriteExpect,
) -> Result<WriteResult, String> {
    match Location::parse(&path)? {
        Location::Local(p) => blocking(move || file::write_text(&p, &text, &expect)).await,
        Location::Remote { remote_id, path } => {
            ssh.write_text(&remote_id, &path, &text, &expect).await
        }
    }
}

/// The file's modification time and size, or `null` if no file is there.
#[tauri::command]
pub async fn fs_file_version(
    ssh: State<'_, SshManager>,
    path: String,
) -> Result<Option<FileVersion>, String> {
    match Location::parse(&path)? {
        Location::Local(p) => blocking(move || file::version(&p)).await,
        Location::Remote { remote_id, path } => ssh.file_version(&remote_id, &path).await,
    }
}

/// The executables on `path` (a `PATH` value; the app's/remote's own when
/// `None`), sorted and deduplicated; see [`complete::path_commands`].
#[tauri::command]
pub async fn fs_path_commands(
    ssh: State<'_, SshManager>,
    path: Option<String>,
    remote: Option<String>,
) -> Result<Vec<String>, String> {
    if let Some(remote_id) = remote {
        return ssh.path_commands(&remote_id, path.as_deref()).await;
    }
    blocking(move || {
        let path = path.unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
        Ok(complete::path_commands(&path))
    })
    .await
}

/// Every entry of `dir` with its kind and executable bit, for completion.
#[tauri::command]
pub async fn fs_complete_list(
    ssh: State<'_, SshManager>,
    dir: String,
) -> Result<Vec<CompletionEntry>, String> {
    match Location::parse(&dir)? {
        Location::Local(p) => blocking(move || complete::list_entries(&p)).await,
        Location::Remote { remote_id, path } => ssh.complete_list(&remote_id, &path).await,
    }
}

/// Status of the work tree containing `path`, or `null` outside one.
#[tauri::command]
pub async fn git_status(
    ssh: State<'_, SshManager>,
    path: String,
) -> Result<Option<GitStatus>, String> {
    match Location::parse(&path)? {
        Location::Local(p) => blocking(move || git::status(&p)).await,
        Location::Remote { remote_id, path } => ssh.git_status(&remote_id, &path).await,
    }
}

/// Starts a watcher with nothing watched yet and returns its id. Changes
/// arrive on `on_event` as `{ dirs }` (local and/or `ssh://<id>/...`).
#[tauri::command]
pub fn fs_watch_start(
    window: Window,
    manager: State<'_, WatchManager>,
    ssh: State<'_, SshManager>,
    on_event: Channel<WatchEvent>,
) -> Result<u32, String> {
    let local_channel = on_event.clone();
    let sink = Box::new(move |dirs| {
        let _ = local_channel.send(WatchEvent { dirs });
    });
    let id = manager.start(window.label(), sink)?;
    let remote_sink = Arc::new(move |dirs| {
        let _ = on_event.send(WatchEvent { dirs });
    });
    ssh.register_watch(id, window.label(), remote_sink);
    Ok(id)
}

/// Replaces the watcher's set of directories (partitioning local and remote
/// directories automatically). Errors on an unknown id.
#[tauri::command]
pub fn fs_watch_set(
    manager: State<'_, WatchManager>,
    ssh: State<'_, SshManager>,
    id: u32,
    dirs: Vec<String>,
) -> Result<(), String> {
    let mut local_dirs = Vec::new();
    let mut by_remote: HashMap<String, Vec<String>> = HashMap::new();
    for raw in dirs {
        match Location::parse(&raw) {
            Ok(Location::Local(_)) => local_dirs.push(raw),
            Ok(Location::Remote { remote_id, path }) => {
                by_remote.entry(remote_id).or_default().push(path);
            }
            Err(_) => {}
        }
    }
    manager.set(id, local_dirs)?;
    ssh.set_watch_dirs(id, by_remote);
    Ok(())
}

/// Stops the watcher. Unknown ids are ignored.
#[tauri::command]
pub fn fs_watch_stop(
    manager: State<'_, WatchManager>,
    ssh: State<'_, SshManager>,
    id: u32,
) -> Result<(), String> {
    manager.stop(id);
    ssh.stop_watch(id);
    Ok(())
}

/// Starts a text search under `root` and returns its id at once. Results
/// arrive on `on_event`; the search ends by itself, when cancelled, or when
/// the webview goes away.
#[tauri::command]
pub fn fs_search_text(
    window: Window,
    manager: State<'_, SearchManager>,
    ssh: State<'_, SshManager>,
    root: String,
    options: TextSearchOptions,
    on_event: Channel<TextSearchEvent>,
) -> Result<u32, String> {
    match Location::parse(&root)? {
        Location::Local(root) => manager.start(window.label(), move |cancel| {
            search::search_text(&root, &options, &cancel, &mut |event| {
                // The webview is gone (page reloaded): nobody wants the rest.
                if on_event.send(event).is_err() {
                    cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            });
        }),
        Location::Remote { remote_id, path } => {
            let id = manager.reserve_id()?;
            let ssh_cancel = ssh.inner().clone();
            let emit = Arc::new(move |event| {
                if on_event.send(event).is_err() {
                    ssh_cancel.cancel_search(id);
                }
            });
            ssh.start_search(id, window.label(), remote_id, path, options, emit);
            Ok(id)
        }
    }
}

/// Cancels a text search (local or remote). Unknown ids are ignored.
#[tauri::command]
pub fn fs_search_cancel(
    manager: State<'_, SearchManager>,
    ssh: State<'_, SshManager>,
    id: u32,
) -> Result<(), String> {
    manager.cancel(id);
    ssh.cancel_search(id);
    Ok(())
}
