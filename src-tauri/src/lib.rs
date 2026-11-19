mod menu;
mod pty;
mod traffic_lights;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, WindowEvent};

use pty::PtyManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::default())
        .menu(menu::build)
        .setup(|app| {
            for window in app.webview_windows().values() {
                traffic_lights::apply(&window.as_ref().window());
            }
            Ok(())
        })
        // AppKit puts the traffic lights back in their default spot on these.
        .on_window_event(|window, event| {
            if matches!(
                event,
                WindowEvent::Resized(_)
                    | WindowEvent::Focused(_)
                    | WindowEvent::ScaleFactorChanged { .. }
                    | WindowEvent::ThemeChanged(_)
            ) {
                traffic_lights::apply(window);
            }
        })
        // A page that (re)loads has lost the channels its terminals were
        // streaming to, so their shells can never be reached again: end them
        // rather than leave them stalled until the window closes. This is a
        // no-op for a window's first load.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                webview
                    .state::<PtyManager>()
                    .kill_owned_by(webview.window().label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty::commands::pty_spawn,
            pty::commands::pty_write,
            pty::commands::pty_write_bytes,
            pty::commands::pty_resize,
            pty::commands::pty_ack,
            pty::commands::pty_kill,
            pty::commands::pty_foreground,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        // A closed window takes its terminals with it.
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Destroyed,
            ..
        } => app.state::<PtyManager>().kill_owned_by(&label),
        // Last chance to make sure no shell outlives the app.
        RunEvent::Exit => app.state::<PtyManager>().kill_all(),
        _ => {}
    });
}
