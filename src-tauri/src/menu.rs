//! The native application menu.
//!
//! This is Tauri's default menu minus "Close Window": its ⌘W accelerator is
//! handled by the OS before the webview sees the key, and in this app ⌘W
//! closes the focused pane (see `src/shortcuts.ts`). The Edit menu matters on
//! macOS: without it ⌘C / ⌘V / ⌘A do not reach the webview.

use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Runtime};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let package = app.package_info();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // The well-known id is what makes Tauri register this submenu with AppKit
    // as the Window menu, which then lists the app's windows (the way back to
    // a minimized one).
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            package.name.clone(),
            true,
            &[
                &PredefinedMenuItem::about(app, None, Some(about))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        let view = Submenu::with_items(
            app,
            "View",
            true,
            &[&PredefinedMenuItem::fullscreen(app, None)?],
        )?;
        Menu::with_items(app, &[&app_menu, &edit, &view, &window])
    }

    #[cfg(not(target_os = "macos"))]
    {
        let file =
            Submenu::with_items(app, "File", true, &[&PredefinedMenuItem::quit(app, None)?])?;
        let help = Submenu::with_items(
            app,
            "Help",
            true,
            &[&PredefinedMenuItem::about(app, None, Some(about))?],
        )?;
        Menu::with_items(app, &[&file, &edit, &window, &help])
    }
}
