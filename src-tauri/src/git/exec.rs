//! Safe `git` command execution (local and over SSH) plus strict input
//! validation to prevent flag injection, path traversal, and lock contention.

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::ssh::SshManager;
use crate::ssh::location::Location;

/// Default timeout for local/remote non-network git queries and mutations.
pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
/// Extended timeout for network operations (`fetch`, `pull`, `push`).
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(90);
/// Maximum stdout bytes captured from a single git invocation (8 MiB).
pub const MAX_STDOUT_BYTES: usize = 8 * 1024 * 1024;
/// Maximum stderr bytes captured (256 KiB).
const MAX_STDERR_BYTES: usize = 256 * 1024;

const GIT_ENV_STRIP: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
];

#[derive(Debug, Clone)]
pub struct GitOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub truncated: bool,
}

impl GitOutput {
    /// Returns stdout when exit code is 0, failing closed if output was truncated.
    pub fn ok_stdout_complete(self, action: &str) -> Result<Vec<u8>, String> {
        if self.code != 0 {
            return Err(self.error_message(action));
        }
        if self.truncated {
            return Err(format!("git {action} output exceeded size limit"));
        }
        Ok(self.stdout)
    }

    /// Returns stdout when exit code is 0 (allowing truncated diff previews).
    pub fn ok_stdout(self, action: &str) -> Result<Vec<u8>, String> {
        if self.code == 0 {
            Ok(self.stdout)
        } else {
            Err(self.error_message(action))
        }
    }

    pub fn ok_text(self, action: &str) -> Result<String, String> {
        if self.code == 0 {
            let out = String::from_utf8_lossy(&self.stdout).trim().to_string();
            let err = self.stderr.trim();
            Ok(if out.is_empty() { err.to_string() } else { out })
        } else {
            Err(self.error_message(action))
        }
    }

    pub fn error_message(&self, action: &str) -> String {
        let msg = self.stderr.trim();
        if !msg.is_empty() {
            msg.to_string()
        } else {
            let out = String::from_utf8_lossy(&self.stdout);
            let out = out.trim();
            if !out.is_empty() {
                out.to_string()
            } else {
                format!("git {action} failed with exit code {}", self.code)
            }
        }
    }
}

/// Runs `git -C <loc> -c core.quotepath=false <args...>` locally or via the
/// remote SSH helper. Never uses a shell.
pub async fn run_git(
    ssh: &SshManager,
    loc: &Location,
    args: &[&str],
    stdin: Option<&[u8]>,
    read_only: bool,
    timeout: Duration,
) -> Result<GitOutput, String> {
    for arg in args {
        if arg.contains('\0') {
            return Err("git argument contains NUL byte".into());
        }
    }
    match loc {
        Location::Local(dir) => run_git_local(dir, args, stdin, read_only, timeout).await,
        Location::Remote { remote_id, path } => {
            let (code, stdout, stderr, truncated) = ssh
                .git_exec(remote_id, path, args, stdin, read_only, timeout)
                .await?;
            Ok(GitOutput {
                code,
                stdout,
                stderr,
                truncated,
            })
        }
    }
}

async fn read_bounded<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
) -> Result<(Vec<u8>, bool), std::io::Error> {
    let mut out = Vec::new();
    let mut buf = vec![0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        if out.len() < limit {
            let keep = (limit - out.len()).min(n);
            out.extend_from_slice(&buf[..keep]);
            if keep < n {
                truncated = true;
            }
        } else {
            truncated = true;
        }
    }
    Ok((out, truncated))
}

/// Runs `git` locally with sanitized environment, bounded output, and timeout.
pub async fn run_git_local(
    dir: &Path,
    args: &[&str],
    stdin_data: Option<&[u8]>,
    read_only: bool,
    timeout: Duration,
) -> Result<GitOutput, String> {
    let mut cmd = Command::new("git");
    for key in GIT_ENV_STRIP {
        cmd.env_remove(key);
    }
    // Keep UTF-8 character handling while pinning Git's human/machine messages to C locale.
    if std::env::var_os("LC_CTYPE").is_none()
        && let Some(lc_all) = std::env::var_os("LC_ALL")
    {
        cmd.env("LC_CTYPE", lc_all);
    }
    cmd.env_remove("LC_ALL");
    cmd.env("LC_MESSAGES", "C");
    cmd.env("LANGUAGE", "C");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    if read_only {
        cmd.env("GIT_OPTIONAL_LOCKS", "0");
    }
    cmd.arg("-C")
        .arg(dir)
        .arg("-c")
        .arg("core.quotepath=false")
        .arg("--literal-pathspecs");
    cmd.args(args);
    cmd.stdin(if stdin_data.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch git: {e}"))?;

    let stdin_handle = child.stdin.take();
    let stdout_handle = child
        .stdout
        .take()
        .ok_or_else(|| "git stdout unavailable".to_string())?;
    let stderr_handle = child
        .stderr
        .take()
        .ok_or_else(|| "git stderr unavailable".to_string())?;

    let owned_stdin = stdin_data.map(|b| b.to_vec());
    let io_future = async {
        let write_fut = async move {
            if let (Some(mut pipe), Some(bytes)) = (stdin_handle, owned_stdin) {
                let _ = pipe.write_all(&bytes).await;
                let _ = pipe.shutdown().await;
            }
        };
        let out_fut = read_bounded(stdout_handle, MAX_STDOUT_BYTES);
        let err_fut = read_bounded(stderr_handle, MAX_STDERR_BYTES);
        let ((), out_res, err_res) = tokio::join!(write_fut, out_fut, err_fut);
        let status = child
            .wait()
            .await
            .map_err(|e| format!("failed waiting for git: {e}"))?;
        let (stdout, truncated) = out_res.map_err(|e| format!("reading git stdout failed: {e}"))?;
        let (stderr_bytes, _) = err_res.map_err(|e| format!("reading git stderr failed: {e}"))?;
        Ok::<GitOutput, String>(GitOutput {
            code: status.code().unwrap_or(-1),
            stdout,
            stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
            truncated,
        })
    };

    match tokio::time::timeout(timeout, io_future).await {
        Ok(res) => res,
        Err(_) => Err(format!("git command timed out after {}s", timeout.as_secs())),
    }
}

/// Validates a git branch / ref name (rejects flag injection, control chars,
/// and invalid git ref syntax).
pub fn validate_ref_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 256 {
        return Err("invalid branch or ref name".into());
    }
    if name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.starts_with('.')
        || name.ends_with('.')
        || name.ends_with(".lock")
        || name.contains("..")
        || name.contains("//")
        || name.contains("@{")
        || name == "@"
    {
        return Err(format!("invalid ref name: {name}"));
    }
    if name.chars().any(|c| {
        c.is_control()
            || c.is_whitespace()
            || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
    }) {
        return Err(format!("invalid characters in ref name: {name}"));
    }
    if name
        .split('/')
        .any(|seg| seg.is_empty() || seg.starts_with('.') || seg.ends_with(".lock"))
    {
        return Err(format!("invalid ref name segment: {name}"));
    }
    Ok(())
}

/// Validates a repository-relative POSIX path (rejects absolute paths, NUL,
/// `..` traversal, and case-insensitive `.git` segments).
pub fn validate_rel_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\0') || path.starts_with('/') {
        return Err(format!("invalid repository path: {path}"));
    }
    let mut has_normal = false;
    for comp in Path::new(path).components() {
        match comp {
            Component::Normal(seg) => {
                if seg.to_string_lossy().eq_ignore_ascii_case(".git") {
                    return Err("refusing to operate on .git metadata".into());
                }
                has_normal = true;
            }
            _ => return Err(format!("invalid repository path: {path}")),
        }
    }
    if !has_normal {
        return Err(format!("invalid repository path: {path}"));
    }
    Ok(())
}

/// Validates a hex commit SHA (4..=64 hex chars).
pub fn validate_hash(hash: &str) -> Result<(), String> {
    if !(4..=64).contains(&hash.len()) || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("invalid commit hash: {hash}"));
    }
    Ok(())
}

/// Validates a git remote name (rejects leading `-`, `:`, whitespace, control chars).
pub fn validate_remote_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 128
        || name.starts_with('-')
        || name
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '/' | ':' | '\\'))
    {
        return Err(format!("invalid remote name: {name}"));
    }
    Ok(())
}

/// Expresses `workdir` using `caller`'s symlink prefix when they resolve to
/// the same directory (e.g. `/tmp` vs `/private/tmp` on macOS).
pub fn root_in_callers_terms(caller: &Path, workdir: &Path) -> String {
    let fallback = || trim_trailing_sep(workdir);
    let (Ok(real_caller), Ok(real_workdir)) = (caller.canonicalize(), workdir.canonicalize()) else {
        return fallback();
    };
    let Ok(below) = real_caller.strip_prefix(&real_workdir) else {
        return fallback();
    };
    let mut candidate: PathBuf = caller.to_owned();
    for _ in below.components() {
        if !candidate.pop() {
            return fallback();
        }
    }
    match candidate.canonicalize() {
        Ok(real) if real == real_workdir => trim_trailing_sep(&candidate),
        _ => fallback(),
    }
}

fn trim_trailing_sep(path: &Path) -> String {
    let s = path.to_string_lossy();
    let trimmed = s.trim_end_matches(std::path::is_separator);
    if trimmed.is_empty() {
        s.into_owned()
    } else {
        trimmed.to_owned()
    }
}
