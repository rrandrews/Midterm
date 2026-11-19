mod fs;
mod menu;
mod plugins;
mod pty;
mod quit_guard;
mod traffic_lights;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

use fs::WatchManager;
use pty::PtyManager;

/// Quits the app; called by the webview once quitting has been confirmed.
#[tauri::command]
fn app_quit(app: AppHandle) {
    quit_guard::QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

/// This machine's host name, as shells report it in OSC 7 (`gethostname`).
#[tauri::command]
fn local_hostname() -> Option<String> {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is valid for its length; gethostname NUL-terminates
        // on success when the name fits.
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
        if rc != 0 {
            return None;
        }
        let end = buf.iter().position(|&b| b == 0)?;
        String::from_utf8(buf[..end].to_vec()).ok()
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").ok()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // Saves the window's size and position on exit and restores them
        // when the window is created.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(PtyManager::default())
        .manage(WatchManager::default())
        .menu(menu::build)
        .register_asynchronous_uri_scheme_protocol(plugins::protocol::SCHEME, plugins::protocol::handle)
        .setup(|app| {
            quit_guard::install(app.handle());
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
        // rather than leave them stalled until the window closes. Its file
        // watchers are just as orphaned. This is a no-op for a window's
        // first load.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                let label = webview.window().label().to_string();
                webview.state::<PtyManager>().kill_owned_by(&label);
                webview.state::<WatchManager>().stop_owned_by(&label);
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == menu::QUIT_ID {
                // The webview decides (it may ask first) and calls `app_quit`.
                if app.emit("quit-requested", ()).is_err() {
                    app.exit(0);
                }
            } else if let Some(command) = id.strip_prefix(menu::COMMAND_PREFIX) {
                let _ = app.emit("menu-command", command);
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_quit,
            local_hostname,
            menu::menu_set,
            pty::commands::pty_spawn,
            pty::commands::pty_write,
            pty::commands::pty_write_bytes,
            pty::commands::pty_resize,
            pty::commands::pty_ack,
            pty::commands::pty_kill,
            pty::commands::pty_foreground,
            fs::commands::fs_list_dir,
            fs::commands::fs_stat,
            fs::commands::fs_create,
            fs::commands::fs_rename,
            fs::commands::fs_trash,
            fs::commands::fs_find_files,
            fs::commands::fs_read_text,
            fs::commands::fs_read_bytes,
            fs::commands::fs_write_text,
            fs::commands::fs_file_version,
            fs::commands::git_status,
            fs::commands::fs_watch_start,
            fs::commands::fs_watch_set,
            fs::commands::fs_watch_stop,
            plugins::commands::plugins_dir,
            plugins::commands::plugins_list,
            plugins::commands::plugins_import,
            plugins::commands::plugins_remove,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        // A closed window takes its terminals and watchers with it.
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Destroyed,
            ..
        } => {
            app.state::<PtyManager>().kill_owned_by(&label);
            app.state::<WatchManager>().stop_owned_by(&label);
        }
        // Last chance to make sure no shell outlives the app.
        RunEvent::Exit => {
            app.state::<PtyManager>().kill_all();
            app.state::<WatchManager>().stop_all();
        }
        _ => {}
    });
}
