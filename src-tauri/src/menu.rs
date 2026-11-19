//! The native application menu.
//!
//! [`build`] is the menu the app starts with: Tauri's default minus "Close
//! Window" (in this app ⌘W closes the focused pane, see `src/shortcuts.ts`).
//! The Edit menu matters on macOS: without it ⌘C / ⌘V / ⌘A do not reach the
//! webview.
//!
//! Once the webview has loaded it replaces that with a menu generated from
//! its command registry (`menu_set`, see `src/commands/nativeMenu.ts`).
//! Choosing one of those items emits `menu-command` with the command id;
//! the webview runs it.

use serde::Deserialize;
use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Runtime};

/// Id of our own Quit item. The predefined one quits at once; ours asks the
/// webview first, which checks for running programs (`src/closing.ts`) and
/// then calls `app_quit`.
pub const QUIT_ID: &str = "midterm-quit";

/// Prefix of the ids of items that run a webview command.
pub const COMMAND_PREFIX: &str = "cmd:";

/// One entry of a generated submenu.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MenuEntry {
    /// Runs the webview command `id`.
    Command {
        id: String,
        title: String,
        /// Tauri accelerator syntax, e.g. `CmdOrCtrl+Shift+D`. One that
        /// does not parse is dropped (the item stays).
        accelerator: Option<String>,
    },
    Separator,
    /// A native item: `undo`, `redo`, `cut`, `copy`, `paste`, `selectAll`,
    /// `minimize`, `maximize`, `fullscreen`.
    Predefined { item: String },
}

/// A generated submenu. The one titled "Window" becomes the system's
/// Window menu (which lists the app's windows).
#[derive(Debug, Clone, Deserialize)]
pub struct MenuSpec {
    pub title: String,
    pub items: Vec<MenuEntry>,
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let package = app.package_info();
    let quit = MenuItem::with_id(
        app,
        QUIT_ID,
        format!("Quit {}", package.name),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
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
                &quit,
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
        let file = Submenu::with_items(app, "File", true, &[&quit])?;
        let help = Submenu::with_items(
            app,
            "Help",
            true,
            &[&PredefinedMenuItem::about(app, None, Some(about))?],
        )?;
        Menu::with_items(app, &[&file, &edit, &window, &help])
    }
}

fn predefined<R: Runtime>(app: &AppHandle<R>, item: &str) -> tauri::Result<Option<PredefinedMenuItem<R>>> {
    Ok(Some(match item {
        "undo" => PredefinedMenuItem::undo(app, None)?,
        "redo" => PredefinedMenuItem::redo(app, None)?,
        "cut" => PredefinedMenuItem::cut(app, None)?,
        "copy" => PredefinedMenuItem::copy(app, None)?,
        "paste" => PredefinedMenuItem::paste(app, None)?,
        "selectAll" => PredefinedMenuItem::select_all(app, None)?,
        "minimize" => PredefinedMenuItem::minimize(app, None)?,
        "maximize" => PredefinedMenuItem::maximize(app, None)?,
        "fullscreen" => PredefinedMenuItem::fullscreen(app, None)?,
        _ => return Ok(None),
    }))
}

fn entries<R: Runtime>(
    app: &AppHandle<R>,
    items: &[MenuEntry],
) -> tauri::Result<Vec<Box<dyn IsMenuItem<R>>>> {
    let mut built: Vec<Box<dyn IsMenuItem<R>>> = Vec::new();
    for entry in items {
        match entry {
            MenuEntry::Command { id, title, accelerator } => {
                let id = format!("{COMMAND_PREFIX}{id}");
                let item = match MenuItem::with_id(app, &id, title, true, accelerator.as_deref()) {
                    Ok(item) => item,
                    // An accelerator the platform cannot express.
                    Err(_) => MenuItem::with_id(app, &id, title, true, None::<&str>)?,
                };
                built.push(Box::new(item));
            }
            MenuEntry::Separator => built.push(Box::new(PredefinedMenuItem::separator(app)?)),
            MenuEntry::Predefined { item } => {
                if let Some(item) = predefined(app, item)? {
                    built.push(Box::new(item));
                }
            }
        }
    }
    Ok(built)
}

/// The menu bar for `specs`: on macOS the app menu first (About, the items
/// of a spec titled `app`, Services, Hide, Quit), then the other specs.
pub fn build_from<R: Runtime>(app: &AppHandle<R>, specs: &[MenuSpec]) -> tauri::Result<Menu<R>> {
    let package = app.package_info();
    let quit = MenuItem::with_id(app, QUIT_ID, format!("Quit {}", package.name), true, Some("CmdOrCtrl+Q"))?;
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };
    let menu = Menu::new(app)?;
    let app_items = specs.iter().find(|spec| spec.title == "app").map(|spec| entries(app, &spec.items)).transpose()?.unwrap_or_default();

    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::new(app, package.name.clone(), true)?;
        app_menu.append(&PredefinedMenuItem::about(app, None, Some(about.clone()))?)?;
        if !app_items.is_empty() {
            app_menu.append(&PredefinedMenuItem::separator(app)?)?;
            for item in &app_items {
                app_menu.append(item.as_ref())?;
            }
        }
        app_menu.append(&PredefinedMenuItem::separator(app)?)?;
        app_menu.append(&PredefinedMenuItem::services(app, None)?)?;
        app_menu.append(&PredefinedMenuItem::separator(app)?)?;
        app_menu.append(&PredefinedMenuItem::hide(app, None)?)?;
        app_menu.append(&PredefinedMenuItem::hide_others(app, None)?)?;
        app_menu.append(&PredefinedMenuItem::separator(app)?)?;
        app_menu.append(&quit)?;
        menu.append(&app_menu)?;
    }

    for spec in specs.iter().filter(|spec| spec.title != "app") {
        let submenu = if spec.title == "Window" {
            Submenu::with_id(app, WINDOW_SUBMENU_ID, &spec.title, true)?
        } else {
            Submenu::new(app, &spec.title, true)?
        };
        for item in entries(app, &spec.items)? {
            submenu.append(item.as_ref())?;
        }
        // Elsewhere the app menu's items live in the first menu (File).
        #[cfg(not(target_os = "macos"))]
        if menu.items()?.is_empty() {
            for item in &app_items {
                submenu.append(item.as_ref())?;
            }
            submenu.append(&PredefinedMenuItem::separator(app)?)?;
            submenu.append(&quit)?;
        }
        menu.append(&submenu)?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let help = Submenu::with_items(app, "Help", true, &[&PredefinedMenuItem::about(app, None, Some(about))?])?;
        menu.append(&help)?;
    }
    #[cfg(target_os = "macos")]
    let _ = about;
    Ok(menu)
}

/// Replaces the menu bar with one generated by the webview.
#[tauri::command]
pub fn menu_set(app: AppHandle, menus: Vec<MenuSpec>) -> Result<(), String> {
    let menu = build_from(&app, &menus).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_specs_from_the_webview() {
        let specs: Vec<MenuSpec> = serde_json::from_str(
            r#"[{"title":"Pane","items":[
                {"type":"command","id":"pane.splitRight","title":"Split right","accelerator":"CmdOrCtrl+D"},
                {"type":"separator"},
                {"type":"predefined","item":"copy"},
                {"type":"command","id":"x","title":"X","accelerator":null}
            ]}]"#,
        )
        .unwrap();
        assert_eq!(specs[0].title, "Pane");
        assert!(matches!(&specs[0].items[0], MenuEntry::Command { id, .. } if id == "pane.splitRight"));
        assert!(matches!(specs[0].items[1], MenuEntry::Separator));
        assert!(matches!(&specs[0].items[2], MenuEntry::Predefined { item } if item == "copy"));
    }
}
