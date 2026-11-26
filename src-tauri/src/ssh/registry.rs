//! Registry of SSH connections, their verified OpenSSH ControlMaster socket
//! directory, and connection metadata shared between the backend and frontend.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::location::validate_remote_id;

/// Connection status reported to the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SshStatus {
    Connecting,
    Connected,
    Disconnected,
}

/// Information about a registered SSH remote, as exposed to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionInfo {
    pub id: String,
    /// User-facing host label (typically the SSH destination alias, e.g. `prod`).
    pub label: String,
    /// Effective remote hostname from `ssh -G`.
    pub host: String,
    /// Effective remote username from `ssh -G`.
    pub user: String,
    pub port: u16,
    /// Remote home directory, once discovered by shell integration or helper.
    pub remote_home: Option<String>,
    /// Remote OS (`Linux`, `Darwin`, ...), once discovered.
    pub remote_os: Option<String>,
    /// Remote shell (`zsh`, `bash`, `fish`, ...), once discovered.
    pub remote_shell: Option<String>,
    pub status: SshStatus,
    /// Validated safe SSH connection arguments (allowlisted flags + `-- <dest>`)
    /// used for opening new multiplexed terminals or non-interactive reconnect.
    pub ssh_args: Vec<String>,
}

/// Registration payload sent by the frontend when a terminal's local `ssh`
/// wrapper emits a token-verified `OSC 6974;ssh=start` sequence.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterSshConnection {
    pub id: String,
    pub label: String,
    pub host: String,
    pub user: String,
    pub port: u16,
    pub control_path: String,
    /// Whether Midterm's own `ssh` wrapper created this socket (so Midterm may
    /// cleanly send `-O exit` on app exit). Pre-existing user sockets are left
    /// alone.
    #[serde(default)]
    pub owned_socket: bool,
    #[serde(default)]
    pub ssh_args: Vec<String>,
}

/// Creates and verifies a short, private (`0700`) directory for Midterm's
/// OpenSSH `ControlPath` sockets.
///
/// macOS enforces a 104-byte `sun_path` limit on Unix domain sockets and
/// OpenSSH appends a 17-byte temporary suffix when binding, so `$TMPDIR` on
/// macOS (`/var/folders/.../T/`, ~49 bytes) leaves too little room. `/tmp/mt-<uid>`
/// is ~12 bytes (`/private/tmp/mt-<uid>` is ~20 bytes), leaving plenty of room.
pub fn ensure_socket_dir() -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid has no preconditions and never fails.
        let uid = unsafe { libc::geteuid() };
        let base = PathBuf::from(format!("/tmp/mt-{uid}"));
        if verify_or_create_private_dir(&base, uid) {
            return Ok(base);
        }
        // Fallback: create a fresh unique private dir in /tmp if the preferred
        // path is occupied by a symlink or another user.
        for attempt in 0..32u32 {
            let candidate = PathBuf::from(format!("/tmp/mt-{uid}-{}-{attempt}", std::process::id()));
            if let Ok(()) = fs::create_dir(&candidate) {
                let _ = fs::set_permissions(&candidate, fs::Permissions::from_mode(0o700));
                if let Ok(meta) = fs::symlink_metadata(&candidate)
                    && !meta.file_type().is_symlink()
                    && meta.is_dir()
                    && meta.uid() == uid
                    && (meta.mode() & 0o777) == 0o700
                {
                    return Ok(candidate);
                }
            }
        }
        Err("could not create a private SSH control socket directory".into())
    }
    #[cfg(not(unix))]
    {
        let dir = std::env::temp_dir().join("midterm-ssh");
        fs::create_dir_all(&dir).map_err(|e| format!("cannot create ssh socket dir: {e}"))?;
        Ok(dir)
    }
}

#[cfg(unix)]
fn verify_or_create_private_dir(path: &Path, expected_uid: u32) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    match fs::create_dir(path) {
        Ok(()) => {
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return false,
    }
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() || !meta.is_dir() || meta.uid() != expected_uid {
        return false;
    }
    if meta.mode() & 0o777 != 0o700
        && fs::set_permissions(path, fs::Permissions::from_mode(0o700)).is_err()
    {
        return false;
    }
    true
}

/// Verifies that every ancestor directory of `dir` (up to `/`) cannot be
/// replaced or modified by an untrusted user:
/// - `dir` itself (not following symlinks) must be a directory owned by `uid`
///   and neither group-writable nor world-writable (`mode & 0o022 == 0`).
/// - Every ancestor above `dir` (resolving system symlinks like `/tmp -> /private/tmp`
///   only if the symlink itself resides in a trusted directory) must be owned by
///   `uid` or `root (0)`, and if group/world-writable must be owned by `root` with
///   the sticky bit (`0o1000`) set.
#[cfg(unix)]
fn verify_trusted_parent_dir(dir: &Path, uid: u32) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;

    let dir_meta = fs::symlink_metadata(dir)
        .map_err(|e| format!("cannot inspect control socket directory: {e}"))?;
    if dir_meta.file_type().is_symlink() || !dir_meta.is_dir() {
        return Err("control socket parent must be a real directory, not a symlink".into());
    }
    if dir_meta.uid() != uid || (dir_meta.mode() & 0o022 != 0) {
        return Err("control socket directory is not privately owned".into());
    }

    // Check every ancestor prefix of the lexical path AND of the canonical path
    // so neither an intermediate symlink nor a canonical parent can be hijacked.
    let canonical = fs::canonicalize(dir)
        .map_err(|e| format!("cannot canonicalize control socket directory: {e}"))?;
    let canon_meta = fs::symlink_metadata(&canonical)
        .map_err(|e| format!("cannot inspect canonical control socket directory: {e}"))?;
    if canon_meta.dev() != dir_meta.dev() || canon_meta.ino() != dir_meta.ino() {
        return Err("control socket directory changed during verification".into());
    }

    for candidate in [dir, canonical.as_path()] {
        let mut cur = candidate.parent();
        while let Some(anc) = cur {
            let meta = fs::symlink_metadata(anc)
                .map_err(|e| format!("cannot inspect ancestor {}: {e}", anc.display()))?;
            let owner = meta.uid();
            if owner != uid && owner != 0 {
                return Err(format!(
                    "control socket ancestor {} is owned by another user",
                    anc.display()
                ));
            }
            if !meta.file_type().is_symlink() {
                let mode = meta.mode();
                let writable_by_others = (mode & 0o022) != 0;
                let sticky_root = owner == 0 && (mode & 0o1000) != 0;
                if writable_by_others && !sticky_root {
                    return Err(format!(
                        "control socket ancestor {} is writable by other users",
                        anc.display()
                    ));
                }
            }
            cur = anc.parent();
        }
    }
    Ok(())
}

/// If `path` exists on disk, verifies (without following a final symlink) that
/// it is a Unix domain socket owned by `uid` and not writable by group/others.
#[cfg(unix)]
fn verify_existing_socket(path: &Path, uid: u32, must_exist: bool) -> Result<(), String> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err("control socket path may not be a symlink".into());
            }
            if !meta.file_type().is_socket() {
                return Err("control socket path is not a Unix domain socket".into());
            }
            if meta.uid() != uid {
                return Err("control socket is not owned by the current user".into());
            }
            if (meta.mode() & 0o022) != 0 {
                return Err("control socket is writable by other users".into());
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !must_exist => Ok(()),
        Err(e) => Err(format!("cannot inspect control socket: {e}")),
    }
}

/// Validates that a control socket path is safe to use:
/// - must be absolute, have a single normal filename, and contain no NUL or `..` components,
/// - if `owned_socket`, must live directly inside verified private `socket_dir`,
/// - otherwise (reusing a user's pre-existing ControlPath), its immediate parent
///   and every ancestor must be safe against replacement/writing by other users,
/// - and if the path already exists on disk, it must be a non-symlink Unix
///   domain socket owned by the current user.
pub fn validate_control_path(
    control_path: &str,
    socket_dir: &Path,
    owned_socket: bool,
) -> Result<PathBuf, String> {
    if control_path.is_empty() || control_path.contains('\0') {
        return Err("empty or invalid control path".into());
    }
    if control_path.ends_with('/') {
        return Err("control path must name a socket file, not a directory".into());
    }
    let path = PathBuf::from(control_path);
    if !path.is_absolute() {
        return Err("control path must be absolute".into());
    }
    for comp in path.components() {
        if matches!(comp, Component::ParentDir | Component::CurDir) {
            return Err("control path may not contain '.' or '..'".into());
        }
    }
    let Some(file_name) = path.file_name() else {
        return Err("control path has no filename".into());
    };
    if file_name.is_empty() {
        return Err("control path has empty filename".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "control path has no parent".to_string())?;

    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        if owned_socket {
            verify_trusted_parent_dir(socket_dir, uid)?;
            verify_trusted_parent_dir(parent, uid)?;
            let real_parent = fs::canonicalize(parent)
                .map_err(|e| format!("cannot canonicalize socket parent: {e}"))?;
            let real_dir = fs::canonicalize(socket_dir)
                .map_err(|e| format!("cannot canonicalize socket dir: {e}"))?;
            if real_parent != real_dir {
                return Err("owned control socket must live in Midterm's socket directory".into());
            }
        } else {
            verify_trusted_parent_dir(parent, uid)?;
        }
        verify_existing_socket(&path, uid, false)?;
    }

    #[cfg(not(unix))]
    if owned_socket {
        let real_parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
        let real_dir = fs::canonicalize(socket_dir).unwrap_or_else(|_| socket_dir.to_path_buf());
        if real_parent != real_dir {
            return Err("owned control socket must live in Midterm's socket directory".into());
        }
    }

    Ok(path)
}

/// Re-verifies that `control_path` currently exists on disk as a trusted,
/// non-symlink Unix domain socket owned by the current user in a trusted parent
/// directory (called immediately before connecting a helper over the socket).
pub fn verify_live_socket_trust(
    control_path: &Path,
    socket_dir: &Path,
    owned_socket: bool,
) -> Result<(), String> {
    let raw = control_path
        .to_str()
        .ok_or_else(|| "control socket path is not valid UTF-8".to_string())?;
    validate_control_path(raw, socket_dir, owned_socket)?;
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        verify_existing_socket(control_path, uid, true)?;
    }
    Ok(())
}

/// Validates a non-empty token that must not start with `-` or contain
/// whitespace or ASCII control characters (used for SSH host, user, destination).
fn validate_ssh_token(val: &str, label: &str) -> Result<(), String> {
    if val.is_empty() {
        return Err(format!("SSH {label} may not be empty"));
    }
    if val.starts_with('-') {
        return Err(format!("SSH {label} may not start with '-'"));
    }
    if val.bytes().any(|b| b <= 0x20 || b == 0x7f) {
        return Err(format!("SSH {label} contains invalid control or whitespace characters"));
    }
    Ok(())
}

/// Validates a `-J` (`ProxyJump`) specification: comma-separated `[user@]host[:port]` hops.
fn validate_jump_spec(val: &str) -> Result<(), String> {
    if val.is_empty() || val.starts_with('-') {
        return Err("invalid SSH jump host specification".into());
    }
    for hop in val.split(',') {
        if hop.is_empty() || hop.starts_with('-') {
            return Err("invalid SSH jump hop".into());
        }
        if !hop
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'@' | b':' | b'[' | b']'))
        {
            return Err("SSH jump hop contains disallowed characters".into());
        }
    }
    Ok(())
}

/// Validates and canonicalizes an SSH argument vector so it can ONLY contain
/// safe connection flags (`-4`, `-6`, `-C`, `-p <port>`, `-l <user>`, `-i <key>`,
/// `-J <jump>`) plus `-- <single destination>`.
///
/// Crucially, this rejects `-o`, `-F`, `-S`, `-W`, `-L`, `-R`, `-D`, `-E`,
/// extra remote command arguments, and any other flag that could execute local
/// commands or override OpenSSH security options.
pub fn validate_safe_ssh_args(args: &[String]) -> Result<Vec<String>, String> {
    if args.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(args.len() + 1);
    let mut i = 0;
    let mut after_double_dash = false;
    let mut destination: Option<String> = None;

    while i < args.len() {
        let arg = &args[i];
        if arg.contains('\0') {
            return Err("SSH arguments contain NUL".into());
        }
        if after_double_dash {
            if destination.is_some() {
                return Err("SSH arguments may only contain a single destination".into());
            }
            validate_ssh_token(arg, "destination")?;
            destination = Some(arg.clone());
            i += 1;
            continue;
        }
        if arg == "--" {
            after_double_dash = true;
            i += 1;
            continue;
        }
        match arg.as_str() {
            "-4" | "-6" | "-C" => {
                out.push(arg.clone());
                i += 1;
            }
            "-p" => {
                let val = args.get(i + 1).ok_or("SSH -p requires a port")?;
                let port: u16 = val.parse().map_err(|_| "invalid SSH port")?;
                if port == 0 {
                    return Err("SSH port must be > 0".into());
                }
                out.push("-p".into());
                out.push(port.to_string());
                i += 2;
            }
            "-l" => {
                let val = args.get(i + 1).ok_or("SSH -l requires a user")?;
                validate_ssh_token(val, "user")?;
                out.push("-l".into());
                out.push(val.clone());
                i += 2;
            }
            "-i" => {
                let val = args.get(i + 1).ok_or("SSH -i requires an identity path")?;
                if val.is_empty() || val.starts_with('-') || val.bytes().any(|b| b < 0x20 || b == 0x7f) {
                    return Err("invalid SSH identity path".into());
                }
                out.push("-i".into());
                out.push(val.clone());
                i += 2;
            }
            "-J" => {
                let val = args.get(i + 1).ok_or("SSH -J requires a jump specification")?;
                validate_jump_spec(val)?;
                out.push("-J".into());
                out.push(val.clone());
                i += 2;
            }
            s if s.starts_with('-') => {
                return Err(format!("disallowed SSH argument '{s}'"));
            }
            _ => {
                if destination.is_some() {
                    return Err("SSH arguments may only contain a single destination".into());
                }
                validate_ssh_token(arg, "destination")?;
                destination = Some(arg.clone());
                i += 1;
            }
        }
    }

    let dest = destination.ok_or_else(|| "SSH arguments must include a destination".to_string())?;
    out.push("--".into());
    out.push(dest);
    Ok(out)
}

/// Builds a safe SSH argument vector directly from validated structured fields
/// (`host`, `user`, `port`) when no explicit `ssh_args` were supplied.
pub fn fallback_ssh_args(host: &str, user: &str, port: u16) -> Result<Vec<String>, String> {
    validate_ssh_token(host, "host")?;
    if !user.is_empty() {
        validate_ssh_token(user, "user")?;
    }
    let mut out = Vec::new();
    if port > 0 && port != 22 {
        out.push("-p".into());
        out.push(port.to_string());
    }
    if !user.is_empty() {
        out.push("-l".into());
        out.push(user.to_string());
    }
    out.push("--".into());
    out.push(host.to_string());
    Ok(out)
}

/// Validates a registration payload before storing it, returning the verified
/// control path and canonicalized safe SSH args.
pub fn validate_registration(
    reg: &RegisterSshConnection,
    socket_dir: &Path,
) -> Result<(PathBuf, Vec<String>), String> {
    validate_remote_id(&reg.id)?;
    validate_ssh_token(&reg.host, "host")?;
    if !reg.user.is_empty() {
        validate_ssh_token(&reg.user, "user")?;
    }
    let safe_args = validate_safe_ssh_args(&reg.ssh_args)?;
    let control_path = validate_control_path(&reg.control_path, socket_dir, reg.owned_socket)?;
    Ok((control_path, safe_args))
}

/// Validates persisted connection metadata being restored from disk.
pub fn validate_restore(
    id: &str,
    host: &str,
    user: &str,
    ssh_args: &[String],
) -> Result<Vec<String>, String> {
    validate_remote_id(id)?;
    validate_ssh_token(host, "host")?;
    if !user.is_empty() {
        validate_ssh_token(user, "user")?;
    }
    validate_safe_ssh_args(ssh_args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_dir_is_short_and_private() {
        let dir = ensure_socket_dir().unwrap();
        assert!(dir.to_string_lossy().len() < 40, "too long: {}", dir.display());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let meta = fs::symlink_metadata(&dir).unwrap();
            assert!(meta.is_dir() && !meta.file_type().is_symlink());
            assert_eq!(meta.mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn validates_owned_and_unowned_control_paths() {
        let dir = ensure_socket_dir().unwrap();
        let good = dir.join("abc123def456");
        assert!(validate_control_path(good.to_str().unwrap(), &dir, true).is_ok());
        assert!(validate_control_path("/etc/passwd", &dir, true).is_err());
        assert!(validate_control_path("relative/sock", &dir, true).is_err());
        assert!(validate_control_path(&format!("{}/../escape", dir.display()), &dir, true).is_err());
        assert!(validate_control_path(&format!("{}/", dir.display()), &dir, true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_group_writable_or_symlinked_unowned_sockets() {
        use std::os::unix::fs::PermissionsExt;
        let dir = ensure_socket_dir().unwrap();
        let tmp = tempfile::tempdir_in("/tmp").unwrap();

        // Group-writable parent must be rejected.
        let gw = tmp.path().join("gw");
        fs::create_dir(&gw).unwrap();
        fs::set_permissions(&gw, fs::Permissions::from_mode(0o770)).unwrap();
        assert!(validate_control_path(gw.join("sock").to_str().unwrap(), &dir, false).is_err());

        // Symlinked parent must be rejected.
        let real = tmp.path().join("real");
        fs::create_dir(&real).unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o700)).unwrap();
        let link_parent = tmp.path().join("link-parent");
        std::os::unix::fs::symlink(&real, &link_parent).unwrap();
        assert!(
            validate_control_path(link_parent.join("sock").to_str().unwrap(), &dir, false).is_err()
        );

        // Regular file at socket path must be rejected.
        let regular = real.join("not-a-socket");
        fs::write(&regular, "hello").unwrap();
        assert!(validate_control_path(regular.to_str().unwrap(), &dir, false).is_err());

        // Symlink at socket path must be rejected.
        let link_sock = real.join("link-sock");
        std::os::unix::fs::symlink("/tmp/nowhere", &link_sock).unwrap();
        assert!(validate_control_path(link_sock.to_str().unwrap(), &dir, false).is_err());

        // Valid private directory with non-existent socket path passes registration validation,
        // while verify_live_socket_trust requires it to exist as a real socket.
        let priv_sock = real.join("cm-sock");
        // Ensure tmp itself is 0700 so ancestor check passes.
        fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        assert!(validate_control_path(priv_sock.to_str().unwrap(), &dir, false).is_ok());
        assert!(verify_live_socket_trust(&priv_sock, &dir, false).is_err());
    }

    #[test]
    fn ssh_args_allowlist_blocks_command_execution_options() {
        // Safe invocations pass and get `--` before destination.
        assert_eq!(
            validate_safe_ssh_args(&["-p".into(), "2222".into(), "-i".into(), "/key".into(), "prod".into()]).unwrap(),
            vec!["-p", "2222", "-i", "/key", "--", "prod"]
        );
        assert_eq!(
            validate_safe_ssh_args(&["-J".into(), "bastion,user@hop2:2200".into(), "box".into()]).unwrap(),
            vec!["-J", "bastion,user@hop2:2200", "--", "box"]
        );
        assert_eq!(validate_safe_ssh_args(&[]).unwrap(), Vec::<String>::new());

        // Dangerous options must be rejected.
        assert!(validate_safe_ssh_args(&["-o".into(), "ProxyCommand=sh -c id".into(), "box".into()]).is_err());
        assert!(validate_safe_ssh_args(&["-o".into(), "LocalCommand=id".into(), "box".into()]).is_err());
        assert!(validate_safe_ssh_args(&["-F".into(), "/tmp/evil_cfg".into(), "box".into()]).is_err());
        assert!(validate_safe_ssh_args(&["-S".into(), "/tmp/sock".into(), "box".into()]).is_err());
        assert!(validate_safe_ssh_args(&["box".into(), "rm -rf /".into()]).is_err());
        assert!(validate_safe_ssh_args(&["-oProxyCommand=evil".into(), "box".into()]).is_err());
        assert!(validate_safe_ssh_args(&["--".into(), "-oProxyCommand=evil".into()]).is_err());
        assert!(validate_safe_ssh_args(&["-p".into(), "0".into(), "box".into()]).is_err());
    }
}
