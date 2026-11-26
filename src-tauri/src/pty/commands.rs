//! Tauri commands: thin adapters between the webview and [`PtyManager`].
//!
//! All commands are synchronous on purpose. Tauri runs synchronous commands
//! in arrival order on the main thread, which
//!
//! * keeps keystrokes ordered, and
//! * serialises `pty_spawn` with the window and exit events handled in
//!   `lib.rs`, so a session can never be started "behind the back" of the
//!   cleanup for a window that is being destroyed.
//!
//! None of them block: spawning costs a `fork`/`exec`, everything else is a
//! queue push, an `ioctl` or a signal.

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{State, Window};

use super::manager::PtyManager;
use super::session::{Foreground, PtyEvent, Sinks};
use super::shell::{CustomShell, EnvVar, PythonEnv, SpawnEnv, shell_command_with_ssh, ssh_command};
use crate::secrets::{self, SecretVar};
use crate::ssh::SshManager;
use crate::ssh::location::Location;

/// Starts the user's login shell (or `shell` with `shell_args`, from the
/// settings) in a new PTY and returns the session id. When `cwd` is an
/// `ssh://<remote_id>/<posix_path>` URI, opens a multiplexed direct-SSH login
/// shell starting in that remote directory instead.
///
/// `on_data` receives the shell's output as raw bytes: every message is an
/// `InvokeResponseBody::Raw`, which Tauri delivers to JavaScript as an
/// `ArrayBuffer` (a `Channel<Vec<u8>>` would be serialised as a JSON array of
/// numbers instead). `on_event` receives [`PtyEvent`]s as JSON.
///
/// `env` and `secrets` are added to the shell's environment (secrets last,
/// read from the key store, which must have been warmed with
/// `secrets_warm`: this command runs on the main thread and does not wait
/// for a credential prompt); `python` is activated by the shell at its
/// first prompt. See `shell::SpawnEnv`.
///
/// Output may start arriving before this command's result does.
// Each argument is a field of the webview's call; a struct would only rename them.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn pty_spawn(
    window: Window,
    manager: State<'_, PtyManager>,
    ssh: State<'_, SshManager>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    shell_args: Option<Vec<String>>,
    ssh_integration: Option<bool>,
    ssh_token: Option<String>,
    env: Option<Vec<EnvVar>>,
    secrets: Option<Vec<SecretVar>>,
    python: Option<PythonEnv>,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    let sinks = Sinks {
        on_data: Box::new(move |bytes| on_data.send(InvokeResponseBody::Raw(bytes)).is_ok()),
        on_event: Box::new(move |event| {
            // Nothing useful can be done if the webview is already gone.
            let _ = on_event.send(event);
        }),
    };

    let use_ssh_integration = ssh_integration.unwrap_or(true);
    // Any `ssh://` cwd MUST parse as a valid remote location (never silently
    // fall back to spawning a local shell in $HOME on malformed remote URIs).
    let cmd = if let Some(raw_cwd) = cwd.as_deref().filter(|s| s.starts_with("ssh://")) {
        match Location::parse(raw_cwd)? {
            Location::Remote { remote_id, path } => {
                let target = ssh.spawn_info_sync(&remote_id)?;
                ssh_command(&target, &path, use_ssh_integration)?
            }
            Location::Local(_) => unreachable!(),
        }
    } else {
        let mut vars = env.unwrap_or_default();
        vars.extend(
            secrets::resolve_from_store(&secrets.unwrap_or_default())
                .into_iter()
                .map(|(name, value)| EnvVar { name, value }),
        );
        let spawn = SpawnEnv { vars, python };
        let sock_dir = if use_ssh_integration {
            ssh.socket_dir().ok()
        } else {
            None
        };
        shell_command_with_ssh(
            cwd.as_deref(),
            shell
                .map(|program| CustomShell {
                    program,
                    args: shell_args.unwrap_or_default(),
                })
                .as_ref(),
            use_ssh_integration,
            sock_dir.as_deref(),
            ssh_token.as_deref(),
            &spawn,
        )
    };

    manager.spawn(window.label(), cmd, cols, rows, sinks)
}

/// Sends UTF-8 input (keystrokes, pastes) to the session's terminal.
#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, id: u32, data: String) -> Result<(), String> {
    manager.write(id, data.into_bytes())
}

/// Sends raw bytes to the session's terminal. For input that is not valid
/// UTF-8, such as legacy mouse reports, which [`pty_write`] would mangle.
#[tauri::command]
pub fn pty_write_bytes(
    manager: State<'_, PtyManager>,
    id: u32,
    data: Vec<u8>,
) -> Result<(), String> {
    manager.write(id, data)
}

/// Resizes the session's terminal.
#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(id, cols, rows)
}

/// Flow control: the frontend has finished processing `bytes` bytes of
/// output received on `on_data`.
#[tauri::command]
pub fn pty_ack(manager: State<'_, PtyManager>, id: u32, bytes: usize) -> Result<(), String> {
    manager.ack(id, bytes);
    Ok(())
}

/// The process in the foreground of the session's terminal, as
/// `{ pid, name, isShell }`. `null` for an unknown or exited session, or
/// when it cannot be determined.
#[tauri::command]
pub fn pty_foreground(
    manager: State<'_, PtyManager>,
    id: u32,
) -> Result<Option<Foreground>, String> {
    Ok(manager.foreground(id))
}

/// Kills the session's process and forgets the session. Idempotent.
#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: u32) -> Result<(), String> {
    manager.kill(id);
    Ok(())
}
