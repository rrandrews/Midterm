//! Imported pane plugins: folders with a `manifest.json` and an ES module,
//! installed in `<app data dir>/plugins/<id>/` and loaded by the webview.
//!
//! * [`manifest`] – parsing and validating `manifest.json`.
//! * [`install`] – listing, importing (folder or `.zip`) and removing.
//! * [`protocol`] – the `plugin://` URI scheme serving installed files.
//! * [`commands`] – the `plugins_*` Tauri commands.
//!
//! Everything but `commands` and [`protocol::handle`] is independent of
//! Tauri and unit-tested.

pub mod commands;
pub mod install;
pub mod manifest;
pub mod protocol;

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

/// `<app data dir>/plugins`; not created here.
pub fn plugins_root<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("plugins"))
}
