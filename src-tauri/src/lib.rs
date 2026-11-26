mod ai;
mod antigravity;
mod claude;
mod fs;
mod menu;
mod plugins;
mod pty;
mod quit_guard;
mod secrets;
mod ssh;
mod traffic_lights;

use std::sync::Arc;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

use fs::{SearchManager, TransferManager, WatchManager};
use pty::PtyManager;
use ssh::SshManager;

/// Quits the app; called by the webview once quitting has been confirmed.
#[tauri::command]
fn app_quit(app: AppHandle) {
    quit_guard::QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

/// The window's close button: on macOS this hides the app instead of closing
/// the window, as Mac apps do; its shells keep running, and clicking the
/// Dock icon (`RunEvent::Reopen`) or ⌘-Tab brings it back. Returns whether it
/// hid; elsewhere it returns false and the window closes as usual.
#[tauri::command]
fn app_hide_on_close(app: AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Err(error) = app.hide() {
            eprintln!("app_hide_on_close: {error}");
            return false;
        }
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}

/// Brings the app forward: unhides it (after `app_hide_on_close`) and
/// focuses its window. Called before a confirmation is shown, so a quit
/// from the Dock while hidden does not ask in an invisible window.
#[tauri::command]
fn app_show(app: AppHandle) {
    show_app(&app);
}

fn show_app(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    for window in app.webview_windows().values() {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
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
    let builder = tauri::Builder::default();
    #[cfg(all(debug_assertions, feature = "tauri-mcp"))]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .bind_address("127.0.0.1")
            .build(),
    );

    let app = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // Saves the window's size and position on exit and restores them
        // when the window is created.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(PtyManager::default())
        .manage(WatchManager::default())
        .manage(SearchManager::default())
        .manage(Arc::new(TransferManager::default()))
        .manage(SshManager::default())
        .manage(ai::AiManager::default())
        .manage(antigravity::AntigravityManager::default())
        .manage(claude::ClaudeManager::default())
        .menu(menu::build)
        .register_asynchronous_uri_scheme_protocol(plugins::protocol::SCHEME, plugins::protocol::handle)
        .setup(|app| {
            ai::keys::log_store();
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
                webview.state::<SearchManager>().cancel_owned_by(&label);
                webview.state::<Arc<TransferManager>>().cancel_owned_by(&label);
                webview.state::<SshManager>().cleanup_owned_by(&label);
                webview.state::<ai::AiManager>().acp.close_owned_by(&label);
                webview.state::<antigravity::AntigravityManager>().close_owned_by(&label);
                webview.state::<claude::ClaudeManager>().close_owned_by(&label);
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
            app_hide_on_close,
            app_show,
            local_hostname,
            menu::menu_set,
            pty::commands::pty_spawn,
            pty::commands::pty_write,
            pty::commands::pty_write_bytes,
            pty::commands::pty_resize,
            pty::commands::pty_ack,
            pty::commands::pty_kill,
            pty::commands::pty_foreground,
            secrets::secret_set,
            secrets::secret_delete,
            secrets::secret_status,
            secrets::secrets_warm,
            fs::commands::fs_list_dir,
            fs::commands::fs_stat,
            fs::commands::fs_open_default,
            fs::commands::fs_create,
            fs::commands::fs_rename,
            fs::commands::fs_trash,
            fs::commands::fs_delete_permanent,
            fs::commands::fs_find_files,
            fs::commands::fs_read_text,
            fs::commands::fs_read_bytes,
            fs::commands::fs_write_text,
            fs::commands::fs_file_version,
            fs::commands::git_status,
            fs::commands::fs_path_commands,
            fs::commands::fs_complete_list,
            fs::commands::fs_find_entries,
            fs::commands::fs_copy,
            fs::commands::fs_copy_start,
            fs::commands::fs_copy_cancel,
            fs::commands::fs_search_text,
            fs::commands::fs_search_cancel,
            fs::commands::fs_watch_start,
            fs::commands::fs_watch_set,
            fs::commands::fs_watch_stop,
            ssh::commands::ssh_register_connection,
            ssh::commands::ssh_connection_ended,
            ssh::commands::ssh_reconnect,
            ssh::commands::ssh_restore_connection,
            ssh::commands::ssh_list_connections,
            plugins::commands::plugins_dir,
            plugins::commands::plugins_list,
            plugins::commands::plugins_import,
            plugins::commands::plugins_remove,
            ai::commands::ai_suggest,
            ai::commands::ai_stream,
            ai::commands::ai_agent_turn,
            ai::commands::ai_acp_prompt,
            ai::commands::ai_acp_tool_result,
            ai::commands::ai_acp_close,
            ai::commands::ai_cancel,
            ai::commands::ai_models,
            ai::commands::ai_effort_options,
            ai::commands::ai_test,
            ai::commands::ai_key_set,
            ai::commands::ai_key_delete,
            ai::commands::ai_key_status,
            ai::commands::ai_cli_status,
            antigravity::antigravity_acp_open,
            antigravity::antigravity_acp_send,
            antigravity::antigravity_acp_close,
            claude::claude_bridge_open,
            claude::claude_bridge_send,
            claude::claude_bridge_close,
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
            app.state::<SearchManager>().cancel_owned_by(&label);
            app.state::<Arc<TransferManager>>().cancel_owned_by(&label);
            app.state::<SshManager>().cleanup_owned_by(&label);
            app.state::<ai::AiManager>().acp.close_owned_by(&label);
            app.state::<antigravity::AntigravityManager>().close_owned_by(&label);
            app.state::<claude::ClaudeManager>().close_owned_by(&label);
        }
        // The Dock icon was clicked: show the app again if it was hidden by
        // its close button (`app_hide_on_close`) or its window minimized.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_app(app),
        // Last chance to make sure no shell outlives the app.
        RunEvent::Exit => {
            app.state::<PtyManager>().kill_all();
            app.state::<WatchManager>().stop_all();
            app.state::<SearchManager>().cancel_all();
            // Let active transfers roll back remote staging entries before tearing down SSH sockets.
            app.state::<Arc<TransferManager>>()
                .cancel_all_and_wait(std::time::Duration::from_secs(2));
            app.state::<SshManager>().shutdown_all();
            app.state::<ai::AiManager>().acp.close_all();
            app.state::<antigravity::AntigravityManager>().close_all();
            app.state::<claude::ClaudeManager>().close_all();
        }
        _ => {}
    });
}
