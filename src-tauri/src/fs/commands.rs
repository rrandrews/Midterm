//! Tauri commands: thin adapters between the webview and the file system
//! and git helpers of this module. `src/ipc/fs.ts` is the only caller.
//!
//! The file system and git commands are `async` and do their work on
//! Tauri's blocking pool: a large directory, a big repository or a slow
//! network mount must not stall the main thread, which also delivers the
//! terminals' keystrokes. Their relative order does not matter; the
//! frontend awaits each result.
//!
//! The watch commands are synchronous instead, like `pty_spawn`: run on the
//! main thread, they are ordered with each other and with the window
//! cleanup in `lib.rs`. They never block (see [`DirWatch`]).
//!
//! [`DirWatch`]: super::watch::DirWatch

use std::path::PathBuf;

use tauri::ipc::{Channel, Response};
use tauri::{State, Window};

use super::file::{self, FileVersion, TextFile, WriteExpect, WriteResult};
use super::git::{self, GitStatus};
use super::list::{self, FsEntry};
use super::ops;
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
pub async fn fs_list_dir(path: String, show_hidden: bool) -> Result<Vec<FsEntry>, String> {
    blocking(move || list::list_dir(&PathBuf::from(path), show_hidden)).await
}

/// `path`'s entry, or `null` if nothing is there. `ignored` is always false.
#[tauri::command]
pub async fn fs_stat(path: String) -> Result<Option<FsEntry>, String> {
    blocking(move || list::stat(&PathBuf::from(path))).await
}

/// Creates an empty file, or a directory if `dir`. Fails if `path` exists.
#[tauri::command]
pub async fn fs_create(path: String, dir: bool) -> Result<(), String> {
    blocking(move || ops::create(&PathBuf::from(path), dir)).await
}

/// Renames or moves `from` to `to`. Fails if `to` exists.
#[tauri::command]
pub async fn fs_rename(from: String, to: String) -> Result<(), String> {
    blocking(move || ops::rename(&PathBuf::from(from), &PathBuf::from(to))).await
}

/// Moves `paths` to the system trash.
#[tauri::command]
pub async fn fs_trash(paths: Vec<String>) -> Result<(), String> {
    blocking(move || ops::trash(&paths)).await
}

/// The file's text, or why it cannot be shown as text; see [`file::read_text`].
#[tauri::command]
pub async fn fs_read_text(path: String) -> Result<TextFile, String> {
    blocking(move || file::read_text(&PathBuf::from(path), file::TEXT_LIMIT)).await
}

/// The file's raw bytes (sent as an `ArrayBuffer`, not JSON).
#[tauri::command]
pub async fn fs_read_bytes(path: String) -> Result<Response, String> {
    blocking(move || file::read_bytes(&PathBuf::from(path), file::BYTES_LIMIT))
        .await
        .map(Response::new)
}

/// Writes `text` atomically, unless what is on disk does not match
/// `expect`; see [`file::write_text`].
#[tauri::command]
pub async fn fs_write_text(
    path: String,
    text: String,
    expect: WriteExpect,
) -> Result<WriteResult, String> {
    blocking(move || file::write_text(&PathBuf::from(path), &text, &expect)).await
}

/// The file's modification time and size, or `null` if no file is there.
#[tauri::command]
pub async fn fs_file_version(path: String) -> Result<Option<FileVersion>, String> {
    blocking(move || file::version(&PathBuf::from(path))).await
}

/// Status of the work tree containing `path`, or `null` outside one.
#[tauri::command]
pub async fn git_status(path: String) -> Result<Option<GitStatus>, String> {
    blocking(move || git::status(&PathBuf::from(path))).await
}

/// Starts a watcher with nothing watched yet and returns its id. Changes
/// arrive on `on_event` as `{ dirs }`.
#[tauri::command]
pub fn fs_watch_start(
    window: Window,
    manager: State<'_, WatchManager>,
    on_event: Channel<WatchEvent>,
) -> Result<u32, String> {
    let sink = Box::new(move |dirs| {
        // Nothing useful can be done if the webview is already gone.
        let _ = on_event.send(WatchEvent { dirs });
    });
    manager.start(window.label(), sink)
}

/// Replaces the watcher's set of directories. Errors on an unknown id.
#[tauri::command]
pub fn fs_watch_set(
    manager: State<'_, WatchManager>,
    id: u32,
    dirs: Vec<String>,
) -> Result<(), String> {
    manager.set(id, dirs)
}

/// Stops the watcher. Unknown ids are ignored.
#[tauri::command]
pub fn fs_watch_stop(manager: State<'_, WatchManager>, id: u32) -> Result<(), String> {
    manager.stop(id);
    Ok(())
}
