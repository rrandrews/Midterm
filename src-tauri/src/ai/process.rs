//! Running a short-lived child process with a timeout, killed (with its
//! whole process group on Unix) if the caller stops waiting: on timeout, or
//! when the future is dropped because the request was cancelled.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::error::{AiError, ErrorKind};

pub struct Run {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    /// Environment variables set on top of the app's own.
    pub env: Vec<(OsString, OsString)>,
    /// Environment variables removed.
    pub env_remove: Vec<&'static str>,
    /// Written to stdin, which is then closed. `None`: stdin is /dev/null.
    pub stdin: Option<String>,
    pub timeout: Duration,
}

pub struct Output {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Kills the child's process group when dropped, unless disarmed.
struct GroupKill(Option<u32>);

impl Drop for GroupKill {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            // SAFETY: plain syscall. The group leader has not been reaped
            // (we never finished waiting), so the group id is still ours.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}

pub async fn run(spec: Run) -> Result<Output, AiError> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdin(if spec.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }
    for name in &spec.env_remove {
        command.env_remove(name);
    }
    for (name, value) in &spec.env {
        command.env(name, value);
    }
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command.spawn().map_err(|e| {
        let kind = if e.kind() == std::io::ErrorKind::NotFound {
            ErrorKind::NotFound
        } else {
            ErrorKind::Other
        };
        AiError::new(
            kind,
            format!("could not start {}: {e}", spec.program.display()),
        )
    })?;
    let mut guard = GroupKill(child.id());

    if let (Some(input), Some(mut stdin)) = (spec.stdin, child.stdin.take()) {
        // Written concurrently with reading the output, so a large prompt
        // cannot deadlock against a full stdout pipe.
        tokio::spawn(async move {
            let _ = stdin.write_all(input.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }

    let output = tokio::time::timeout(spec.timeout, child.wait_with_output())
        .await
        .map_err(|_| {
            AiError::new(
                ErrorKind::Timeout,
                format!(
                    "{} did not finish within {} s",
                    spec.program.display(),
                    spec.timeout.as_secs()
                ),
            )
        })?
        .map_err(|e| AiError::other(format!("waiting for {}: {e}", spec.program.display())))?;
    // The leader has been reaped: its group id may be reused, so never
    // signal it now.
    guard.0 = None;
    Ok(Output {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sh(script: &str, timeout: Duration) -> Run {
        Run {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: None,
            env: vec![("MIDTERM_TEST".into(), "yes".into())],
            env_remove: vec![],
            stdin: Some("from stdin".into()),
            timeout,
        }
    }

    #[tokio::test]
    async fn captures_output_and_stdin() {
        let out = run(sh(
            "cat; echo \" $MIDTERM_TEST\"; echo err >&2; exit 3",
            Duration::from_secs(5),
        ))
        .await
        .unwrap();
        assert!(!out.success);
        assert_eq!(out.code, Some(3));
        assert_eq!(out.stdout, "from stdin yes\n");
        assert_eq!(out.stderr, "err\n");
    }

    #[tokio::test]
    async fn times_out() {
        let started = std::time::Instant::now();
        let e = run(sh("sleep 30", Duration::from_millis(200)))
            .await
            .err()
            .unwrap();
        assert_eq!(e.kind, ErrorKind::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn missing_program_is_not_found() {
        let mut spec = sh("", Duration::from_secs(1));
        spec.program = "/nonexistent/midterm-test-binary".into();
        assert_eq!(run(spec).await.err().unwrap().kind, ErrorKind::NotFound);
    }
}
