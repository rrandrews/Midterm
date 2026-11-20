//! Running a short-lived child process with a timeout, killed (with its
//! whole process group on Unix) if the caller stops waiting: on timeout, or
//! when the future is dropped because the request was cancelled. On
//! Windows only the direct child is killed (descendants may survive; see
//! the M11 item in the roadmap).
//!
//! [`LongChild`] is the long-lived variant for ACP adapters: piped stdio,
//! its own process group, the end of stderr kept, and the group killed on
//! shutdown, on drop, or from another thread through a [`GroupHandle`].

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::task::JoinHandle;

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

/// How long to keep reading output after the process has exited.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Reads a pipe to its end in a task, into a buffer readable at any time.
struct Collector {
    buf: Arc<Mutex<Vec<u8>>>,
    task: Option<JoinHandle<()>>,
}

impl Collector {
    fn start(pipe: Option<impl AsyncRead + Unpin + Send + 'static>) -> Self {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let task = pipe.map(|mut pipe| {
            let buf = buf.clone();
            tokio::spawn(async move {
                let mut chunk = [0u8; 8192];
                while let Ok(n) = pipe.read(&mut chunk).await {
                    if n == 0 {
                        break;
                    }
                    buf.lock().unwrap().extend_from_slice(&chunk[..n]);
                }
            })
        });
        Self { buf, task }
    }

    async fn wait(&mut self) {
        if let Some(task) = self.task.as_mut() {
            let _ = task.await;
            self.task = None;
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.buf.lock().unwrap()).into_owned()
    }
}

impl Drop for Collector {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

/// Kills the child's process group when dropped, unless disarmed.
struct GroupKill(Option<u32>);

impl Drop for GroupKill {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            // SAFETY: plain syscall. The guard is disarmed as soon as the
            // leader is reaped, so the group id is still ours here.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}

/// A long-lived process: its group is killed by [`LongChild::shutdown`],
/// when dropped, or through a [`GroupHandle`] (app exit). The group is never
/// signalled once the leader has been reaped (its id could be reused): the
/// handle is cleared under its lock first.
pub struct LongChild {
    child: tokio::process::Child,
    group: GroupHandle,
    stderr: Tail,
}

/// Kills a [`LongChild`]'s process group from anywhere, until it is reaped.
#[derive(Clone, Default)]
pub struct GroupHandle(Arc<Mutex<Option<u32>>>);

impl GroupHandle {
    /// SIGKILLs the group, if the leader has not been reaped yet.
    pub fn kill(&self) {
        #[cfg(unix)]
        if let Some(pid) = *self.0.lock().unwrap() {
            // SAFETY: plain syscall; the id is cleared under this lock
            // before the leader is reaped, so the group is still ours.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }

    fn disarm(&self) {
        *self.0.lock().unwrap() = None;
    }
}

/// How much of the end of stderr a [`LongChild`] keeps.
const STDERR_TAIL: usize = 16 * 1024;

/// Reads a pipe to its end in a task, keeping only its last bytes.
struct Tail {
    buf: Arc<Mutex<Vec<u8>>>,
    task: Option<JoinHandle<()>>,
}

impl Tail {
    fn start(pipe: Option<impl AsyncRead + Unpin + Send + 'static>) -> Self {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let task = pipe.map(|mut pipe| {
            let buf = buf.clone();
            tokio::spawn(async move {
                let mut chunk = [0u8; 8192];
                while let Ok(n) = pipe.read(&mut chunk).await {
                    if n == 0 {
                        break;
                    }
                    let mut buf = buf.lock().unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() > STDERR_TAIL {
                        let cut = buf.len() - STDERR_TAIL;
                        buf.drain(..cut);
                    }
                }
            })
        });
        Self { buf, task }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.buf.lock().unwrap()).into_owned()
    }
}

impl Drop for Tail {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

/// What [`LongChild::spawn`] runs. Stdin and stdout are piped to the caller.
pub struct Spawn {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(OsString, OsString)>,
    pub env_remove: Vec<&'static str>,
}

impl LongChild {
    pub fn spawn(
        spec: Spawn,
    ) -> Result<
        (
            Self,
            tokio::process::ChildStdin,
            tokio::process::ChildStdout,
        ),
        AiError,
    > {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .stdin(Stdio::piped())
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
        let mut child = command.spawn().map_err(|e| spawn_error(&spec.program, e))?;
        let group = GroupHandle(Arc::new(Mutex::new(child.id())));
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = Tail::start(child.stderr.take());
        let this = Self {
            child,
            group,
            stderr,
        };
        match (stdin, stdout) {
            (Some(stdin), Some(stdout)) => Ok((this, stdin, stdout)),
            _ => Err(AiError::other("could not connect to the process's stdio")),
        }
    }

    pub fn group(&self) -> GroupHandle {
        self.group.clone()
    }

    /// Waits up to `grace` for the leader to exit by itself (the caller has
    /// closed its stdin), then kills the group, so nothing it started
    /// survives, and reaps the leader. Returns its exit code (if it exited
    /// with one) and the end of its stderr.
    pub async fn shutdown(mut self, grace: Duration) -> (Option<i32>, String) {
        let deadline = tokio::time::Instant::now() + grace;
        while !self.exited() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        // The leader is at most a zombie here, so its group id is still ours.
        self.group.kill();
        let status = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
        self.group.disarm();
        // Let the stderr reader catch up with the last lines.
        if let Some(task) = self.stderr.task.as_mut() {
            let _ = tokio::time::timeout(Duration::from_millis(500), task).await;
            self.stderr.task = None;
        }
        let code = match status {
            Ok(Ok(status)) => status.code(),
            _ => None,
        };
        (code, self.stderr.text())
    }

    /// Whether the leader has exited, without reaping it.
    fn exited(&self) -> bool {
        #[cfg(unix)]
        {
            let Some(pid) = *self.group.0.lock().unwrap() else {
                return true;
            };
            // SAFETY: `info` is a plain struct the call fills in. WNOWAIT
            // leaves the child waitable, so `wait` still reaps it.
            unsafe {
                let mut info: libc::siginfo_t = std::mem::zeroed();
                let rc = libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                );
                rc == 0 && info.si_pid != 0
            }
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
}

impl Drop for LongChild {
    fn drop(&mut self) {
        // Not reaped (else the handle is clear): the group is still ours.
        self.group.kill();
    }
}

fn spawn_error(program: &std::path::Path, e: std::io::Error) -> AiError {
    let kind = if e.kind() == std::io::ErrorKind::NotFound {
        ErrorKind::NotFound
    } else {
        ErrorKind::Other
    };
    AiError::new(kind, format!("could not start {}: {e}", program.display()))
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

    let mut child = command.spawn().map_err(|e| spawn_error(&spec.program, e))?;
    let mut guard = GroupKill(child.id());

    if let (Some(input), Some(mut stdin)) = (spec.stdin, child.stdin.take()) {
        // Written concurrently with reading the output, so a large prompt
        // cannot deadlock against a full stdout pipe.
        tokio::spawn(async move {
            let _ = stdin.write_all(input.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }
    let mut stdout = Collector::start(child.stdout.take());
    let mut stderr = Collector::start(child.stderr.take());

    // Wait for the process itself, not its pipes: the guard must be
    // disarmed the moment the leader is reaped (after that its group id may
    // be reused), and a descendant that keeps a pipe open must not hold
    // the reply hostage.
    let status = tokio::time::timeout(spec.timeout, child.wait())
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
    guard.0 = None;

    // If something the process left behind still holds a pipe, keep what
    // has arrived so far.
    let drained = async {
        stdout.wait().await;
        stderr.wait().await;
    };
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, drained).await;
    Ok(Output {
        success: status.success(),
        code: status.code(),
        stdout: stdout.text(),
        stderr: stderr.text(),
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
    async fn a_descendant_holding_the_pipe_does_not_block() {
        let started = std::time::Instant::now();
        let out = run(sh("echo done; sleep 30 &", Duration::from_secs(10)))
            .await
            .unwrap();
        assert!(out.success);
        assert_eq!(out.stdout, "done\n");
        assert!(started.elapsed() < Duration::from_secs(5));
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

    fn long(script: &str) -> Spawn {
        Spawn {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: None,
            env: vec![],
            env_remove: vec![],
        }
    }

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    async fn first_line(stdout: tokio::process::ChildStdout) -> i32 {
        use tokio::io::AsyncBufReadExt;
        let mut line = String::new();
        tokio::io::BufReader::new(stdout)
            .read_line(&mut line)
            .await
            .unwrap();
        line.trim().parse().unwrap()
    }

    async fn gone(pid: i32) -> bool {
        for _ in 0..100 {
            if !alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[tokio::test]
    async fn long_child_group_dies_on_drop_and_from_a_handle() {
        let (child, _stdin, stdout) = LongChild::spawn(long("sleep 300 & echo $!; cat")).unwrap();
        let pid = first_line(stdout).await;
        assert!(alive(pid));
        drop(child);
        assert!(gone(pid).await);

        let (child, _stdin, stdout) = LongChild::spawn(long("sleep 300 & echo $!; cat")).unwrap();
        let pid = first_line(stdout).await;
        child.group().kill();
        assert!(gone(pid).await);
        drop(child);
    }

    #[tokio::test]
    async fn long_child_shutdown_kills_leftovers_and_keeps_stderr() {
        // Exits when stdin closes, leaving a descendant behind.
        let (child, stdin, stdout) =
            LongChild::spawn(long("sleep 300 & echo $!; echo bye >&2; cat; exit 4")).unwrap();
        let pid = first_line(stdout).await;
        drop(stdin);
        let (code, stderr) = child.shutdown(Duration::from_secs(2)).await;
        assert_eq!(code, Some(4));
        assert_eq!(stderr, "bye\n");
        assert!(gone(pid).await);
    }
}
