//! Tauri commands: thin adapters between the webview and [`install`].
//! Like the `fs_*` commands, they do their work on the blocking pool.
//!
//! [`install`]: super::install

use std::path::PathBuf;

use tauri::AppHandle;

use super::install::{self, ErrorKind, PluginError, PluginInfo};

/// The plugins directory, or an `io` error if the app data dir is unknown.
fn root(app: &AppHandle) -> Result<PathBuf, PluginError> {
    super::plugins_root(app)
        .map_err(|e| PluginError::new(ErrorKind::Io, format!("cannot locate the app data folder: {e}")))
}

/// Runs `job` on the blocking thread pool.
async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, PluginError> + Send + 'static,
) -> Result<T, PluginError> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| PluginError::new(ErrorKind::Io, format!("background task failed: {e}")))?
}

/// The plugins directory, created if missing.
#[tauri::command]
pub async fn plugins_dir(app: AppHandle) -> Result<String, PluginError> {
    let root = root(&app)?;
    blocking(move || {
        std::fs::create_dir_all(&root).map_err(|e| PluginError::io("cannot create the plugins folder", e))?;
        Ok(root.to_string_lossy().into_owned())
    })
    .await
}

/// Every installed plugin, including broken ones (with their error).
#[tauri::command]
pub async fn plugins_list(app: AppHandle) -> Result<Vec<PluginInfo>, PluginError> {
    let root = root(&app)?;
    blocking(move || install::list(&root)).await
}

/// Installs the plugin folder or `.zip` at `path`; see [`install::import`].
#[tauri::command]
pub async fn plugins_import(app: AppHandle, path: String, replace: bool) -> Result<PluginInfo, PluginError> {
    let root = root(&app)?;
    blocking(move || install::import(&root, &PathBuf::from(path), replace)).await
}

/// Removes the installed plugin `id`.
#[tauri::command]
pub async fn plugins_remove(app: AppHandle, id: String) -> Result<(), PluginError> {
    let root = root(&app)?;
    blocking(move || install::remove(&root, &id)).await
}
