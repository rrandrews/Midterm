//! Tauri commands for SSH connection lifecycle and diagnostics.

use tauri::{AppHandle, State};

use super::SshManager;
use super::registry::{RegisterSshConnection, SshConnectionInfo};

/// Registers a live SSH connection reported by a terminal's local `ssh`
/// wrapper (via token-verified OSC 6974) and ensures its remote helper can be
/// contacted lazily when needed.
#[tauri::command]
pub async fn ssh_register_connection(
    app: AppHandle,
    ssh: State<'_, SshManager>,
    connection: RegisterSshConnection,
) -> Result<SshConnectionInfo, String> {
    ssh.attach_app(&app);
    ssh.register(connection).await
}

/// Notes that a terminal exited its SSH session for `remote_id`. Keeps the
/// remote helper alive if other terminals, explorers, or editors still use it.
#[tauri::command]
pub async fn ssh_connection_ended(
    ssh: State<'_, SshManager>,
    remote_id: String,
) -> Result<(), String> {
    ssh.terminal_ended(&remote_id).await;
    Ok(())
}

/// Attempts to reconnect a disconnected SSH remote non-interactively
/// (`BatchMode=yes`, using saved SSH arguments and ControlMaster). Returns
/// the updated connection info, or an error if interactive authentication
/// (password/2FA) is required in a terminal.
#[tauri::command]
pub async fn ssh_reconnect(
    app: AppHandle,
    ssh: State<'_, SshManager>,
    remote_id: String,
) -> Result<SshConnectionInfo, String> {
    ssh.attach_app(&app);
    ssh.reconnect(&remote_id).await
}

/// Restores persisted connection metadata (from `ssh-connections.json`) so
/// restored explorer/editor panes can reconnect or show host info after an app
/// restart.
#[tauri::command]
pub async fn ssh_restore_connection(
    app: AppHandle,
    ssh: State<'_, SshManager>,
    id: String,
    label: String,
    host: String,
    user: String,
    port: u16,
    remote_home: Option<String>,
    ssh_args: Vec<String>,
) -> Result<SshConnectionInfo, String> {
    ssh.attach_app(&app);
    ssh.restore(id, label, host, user, port, remote_home, ssh_args)
        .await
}

/// Lists all currently registered SSH connections and their status.
#[tauri::command]
pub async fn ssh_list_connections(ssh: State<'_, SshManager>) -> Result<Vec<SshConnectionInfo>, String> {
    Ok(ssh.list().await)
}
