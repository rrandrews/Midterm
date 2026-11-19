//! End-to-end tests of the PTY core against real child processes. No Tauri
//! runtime is involved: sessions deliver into an in-process channel.
//!
//! Every wait has a timeout, so a regression fails instead of hanging.

#![cfg(unix)]

use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use portable_pty::CommandBuilder;

use super::manager::PtyManager;
use super::session::{FlowLimits, PtyEvent, Session, Sinks, wait_until_terminated};
use super::shell::shell_command;

/// Upper bound for anything that is expected to happen.
const TIMEOUT: Duration = Duration::from_secs(10);
/// How long nothing must happen for output to count as stalled.
const QUIET: Duration = Duration::from_millis(300);

#[derive(Debug)]
enum Msg {
    Data(Vec<u8>),
    Event(PtyEvent),
}

/// Sinks that forward into one channel, preserving the order of emission.
fn channel_sinks() -> (Sinks, mpsc::Receiver<Msg>) {
    let (tx, rx) = mpsc::channel();
    let data_tx = tx.clone();
    let sinks = Sinks {
        on_data: Box::new(move |bytes| data_tx.send(Msg::Data(bytes)).is_ok()),
        on_event: Box::new(move |event| {
            let _ = tx.send(Msg::Event(event));
        }),
    };
    (sinks, rx)
}

fn sh(script: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.args(["-c", script]);
    cmd
}

/// A session plus the receiving end of its sinks.
struct Harness {
    session: Session,
    rx: mpsc::Receiver<Msg>,
    /// Acknowledge output as it is received, like a healthy frontend.
    auto_ack: bool,
    /// Everything received so far.
    output: Vec<u8>,
}

impl Harness {
    fn spawn(cmd: CommandBuilder) -> Self {
        Self::spawn_with(cmd, FlowLimits::default(), true)
    }

    fn spawn_with(cmd: CommandBuilder, limits: FlowLimits, auto_ack: bool) -> Self {
        let (sinks, rx) = channel_sinks();
        let session = Session::spawn(cmd, 80, 24, limits, sinks).expect("spawn failed");
        Self {
            session,
            rx,
            auto_ack,
            output: Vec::new(),
        }
    }

    /// Next message, or `None` if nothing arrives within `timeout`.
    fn next(&mut self, timeout: Duration) -> Option<Msg> {
        let msg = self.rx.recv_timeout(timeout).ok()?;
        if let Msg::Data(bytes) = &msg {
            self.output.extend_from_slice(bytes);
            if self.auto_ack {
                self.session.ack(bytes.len());
            }
        }
        Some(msg)
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output).into_owned()
    }

    fn wait_for_output(&mut self, needle: &str) {
        let deadline = Instant::now() + TIMEOUT;
        while !self.text().contains(needle) {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.next(left) {
                Some(Msg::Data(_)) => {}
                Some(Msg::Event(event)) => {
                    panic!("{event:?} before {needle:?}; output: {:?}", self.text())
                }
                None => panic!(
                    "timed out waiting for {needle:?}; output: {:?}",
                    self.text()
                ),
            }
        }
    }

    /// Consumes messages up to the exit event and returns its code.
    fn wait_for_exit(&mut self) -> Option<u32> {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.next(left) {
                Some(Msg::Data(_)) => {}
                Some(Msg::Event(PtyEvent::Exit { code, .. })) => return code,
                None => panic!("timed out waiting for exit; output: {:?}", self.text()),
            }
        }
    }

    /// Reads until nothing has arrived for [`QUIET`]; returns bytes read.
    fn read_until_quiet(&mut self) -> usize {
        let deadline = Instant::now() + TIMEOUT;
        let before = self.output.len();
        while let Some(msg) = self.next(QUIET) {
            assert!(matches!(msg, Msg::Data(_)), "unexpected {msg:?}");
            assert!(Instant::now() < deadline, "output never stalled");
        }
        self.output.len() - before
    }

    /// After the exit event nothing else may arrive, and the session must
    /// let go of its sinks (which disconnects the channel).
    fn assert_nothing_after_exit(&self) {
        match self.rx.recv_timeout(TIMEOUT) {
            Err(RecvTimeoutError::Disconnected) => {}
            other => panic!("expected the sinks to be dropped after exit, got {other:?}"),
        }
    }

    fn assert_threads_finish(&self) {
        wait_until("session threads to finish", || {
            self.session.threads_finished()
        });
    }
}

fn wait_until(what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + TIMEOUT;
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn streams_output_then_exit_code_zero() {
    let mut h = Harness::spawn(sh("printf hello"));
    assert_eq!(h.wait_for_exit(), Some(0));
    // The exit event came last, and everything before it was the output.
    assert_eq!(h.text(), "hello");
    h.assert_nothing_after_exit();
    h.assert_threads_finish();
}

#[test]
fn large_output_is_complete_before_exit() {
    // Far more than a PTY buffers, and above the default high watermark, so
    // this crosses back-pressure, coalescing and flow control on the way.
    let mut h = Harness::spawn(sh("head -c 3000000 /dev/zero | tr '\\0' x; printf END"));
    assert_eq!(h.wait_for_exit(), Some(0));
    assert_eq!(h.output.len(), 3_000_003);
    assert!(h.output.ends_with(b"xEND"));
    assert!(h.output[..3_000_000].iter().all(|b| *b == b'x'));
    h.assert_nothing_after_exit();
    h.assert_threads_finish();
}

#[test]
fn reports_non_zero_exit_code() {
    let mut h = Harness::spawn(sh("exit 7"));
    assert_eq!(h.wait_for_exit(), Some(7));
}

#[test]
fn spawn_failure_is_an_error() {
    let (sinks, _rx) = channel_sinks();
    let cmd = CommandBuilder::new("/definitely/not/a/program");
    let result = Session::spawn(cmd, 80, 24, FlowLimits::default(), sinks);
    assert!(result.is_err());
}

#[test]
fn write_reaches_the_child() {
    let mut h = Harness::spawn(CommandBuilder::new("/bin/cat"));
    h.session.write(b"ping\n".to_vec()).expect("write failed");
    // Once echoed by the terminal's line discipline, once by cat.
    h.wait_for_output("ping\r\nping\r\n");
    // Ctrl-D on an empty line is end-of-file for cat.
    h.session.write(vec![0x04]).expect("write failed");
    assert_eq!(h.wait_for_exit(), Some(0));
    h.assert_threads_finish();
    assert!(h.session.write(b"late".to_vec()).is_err());
}

#[test]
fn resize_changes_the_terminal_size() {
    let mut h = Harness::spawn(sh("stty size; read _; stty size; read _; stty size"));
    h.wait_for_output("24 80");
    h.session.resize(100, 40).expect("resize failed");
    h.session.write(b"\n".to_vec()).expect("write failed");
    h.wait_for_output("40 100");
    // Zero dimensions are clamped instead of being passed to the child.
    h.session.resize(0, 0).expect("resize failed");
    h.session.write(b"\n".to_vec()).expect("write failed");
    h.wait_for_output("1 1");
    assert_eq!(h.wait_for_exit(), Some(0));
    assert!(h.session.resize(80, 24).is_err());
}

#[test]
fn kill_terminates_a_long_running_child() {
    let mut h = Harness::spawn(CommandBuilder::from_argv(vec![
        "/bin/sleep".into(),
        "600".into(),
    ]));
    let started = Instant::now();
    h.session.kill();
    h.session.kill(); // idempotent
    // Terminated by a signal, so there is no exit code.
    assert_eq!(h.wait_for_exit(), None);
    assert!(started.elapsed() < Duration::from_secs(2));
    h.assert_nothing_after_exit();
    h.assert_threads_finish();
}

#[test]
fn kill_escalates_when_hangup_is_ignored() {
    let mut h = Harness::spawn(sh("trap '' HUP; echo ready; while :; do :; done"));
    h.wait_for_output("ready");
    let started = Instant::now();
    h.session.kill();
    assert_eq!(h.wait_for_exit(), None);
    assert!(started.elapsed() < Duration::from_secs(2));
    h.assert_threads_finish();
}

#[test]
fn dropping_the_session_kills_the_child() {
    let Harness { session, rx, .. } = Harness::spawn(sh("echo ready; sleep 600"));
    drop(session);
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(Msg::Event(PtyEvent::Exit { code, .. })) => break assert_eq!(code, None),
            Ok(Msg::Data(_)) => {}
            Err(e) => panic!("no exit event after drop: {e:?}"),
        }
    }
}

const TINY: FlowLimits = FlowLimits {
    high: 8 * 1024,
    low: 2 * 1024,
};
/// The most a stalled session can have delivered beyond `high`: one chunk,
/// which is at most the coalescing target plus one read.
const MAX_OVERSHOOT: usize = 128 * 1024;

#[test]
fn flow_control_stalls_until_acked() {
    let mut h = Harness::spawn_with(CommandBuilder::new("/usr/bin/yes"), TINY, false);

    // Without acks an endless producer stops soon after the high watermark.
    let unacked = h.read_until_quiet();
    assert!(unacked > TINY.high, "stalled after only {unacked} bytes");
    assert!(unacked <= TINY.high + MAX_OVERSHOOT, "{unacked} bytes");
    assert_eq!(h.read_until_quiet(), 0, "output resumed without an ack");

    // Acking down to just above the low watermark is not enough...
    h.session.ack(unacked - TINY.low - 1);
    assert_eq!(h.read_until_quiet(), 0, "resumed above the low watermark");

    // ...reaching it is.
    h.session.ack(1);
    assert!(
        matches!(h.next(TIMEOUT), Some(Msg::Data(_))),
        "no output after ack"
    );

    // And it stalls again rather than running free.
    let resumed = h.read_until_quiet();
    assert!(resumed <= TINY.high + MAX_OVERSHOOT, "{resumed} bytes");

    h.session.kill();
    assert_eq!(h.wait_for_exit(), None);
    h.assert_threads_finish();
}

#[test]
fn kill_while_stalled_does_not_hang() {
    let mut h = Harness::spawn_with(CommandBuilder::new("/usr/bin/yes"), TINY, false);
    assert!(h.read_until_quiet() > TINY.high);

    let started = Instant::now();
    h.session.kill();
    assert_eq!(h.wait_for_exit(), None);
    assert!(started.elapsed() < Duration::from_secs(2));
    h.assert_nothing_after_exit();
    h.assert_threads_finish();
}

#[test]
fn drop_while_stalled_does_not_hang() {
    let mut h = Harness::spawn_with(CommandBuilder::new("/usr/bin/yes"), TINY, false);
    assert!(h.read_until_quiet() > TINY.high);

    let Harness { session, rx, .. } = h;
    drop(session);
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(Msg::Event(PtyEvent::Exit { .. })) => break,
            Ok(Msg::Data(_)) => {}
            Err(e) => panic!("no exit event after drop: {e:?}"),
        }
    }
}

#[test]
fn slow_consumer_still_gets_everything_before_exit() {
    // The child has long finished writing (and is trying to exit) while its
    // output is still held back by flow control.
    let script = "head -c 200000 /dev/zero | tr '\\0' x; printf END";
    let mut h = Harness::spawn_with(sh(script), TINY, false);
    let mut acked = 0;
    let code = loop {
        match h.next(QUIET) {
            Some(Msg::Data(_)) => {}
            Some(Msg::Event(PtyEvent::Exit { code, .. })) => break code,
            // Stalled: acknowledge what has arrived, as a slow UI would.
            None => {
                h.session.ack(h.output.len() - acked);
                acked = h.output.len();
            }
        }
    };
    assert_eq!(code, Some(0));
    assert_eq!(h.output.len(), 200_003);
    assert!(h.output.ends_with(b"xEND"));
    h.assert_nothing_after_exit();
    h.assert_threads_finish();
}

#[test]
fn exit_waits_for_output_to_be_acked() {
    let mut h = Harness::spawn_with(sh("printf hello"), FlowLimits::default(), false);
    h.wait_for_output("hello");
    // The child is long gone, but its output is not acknowledged yet.
    assert!(h.next(Duration::from_millis(200)).is_none());
    h.session.ack(5);
    assert_eq!(h.wait_for_exit(), Some(0));
}

#[test]
fn exit_is_not_held_back_forever_by_missing_acks() {
    let mut h = Harness::spawn_with(sh("printf hello"), FlowLimits::default(), false);
    let started = Instant::now();
    assert_eq!(h.wait_for_exit(), Some(0));
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(h.text(), "hello");
}

#[test]
fn exit_is_not_held_back_by_a_throttled_pump_with_nothing_left() {
    // The only chunk crosses the high watermark, so the pump is stalled
    // waiting for acks although there is nothing left to send. That must
    // count as "all output delivered", not as output still in transit.
    let limits = FlowLimits { high: 3, low: 1 };
    let mut h = Harness::spawn_with(sh("printf hello"), limits, false);
    let started = Instant::now();
    assert_eq!(h.wait_for_exit(), Some(0));
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(h.text(), "hello");
    h.assert_threads_finish();
}

#[test]
fn exit_does_not_wait_for_background_processes() {
    // The background sleep inherits the terminal, so the PTY does not reach
    // EOF when the shell itself exits.
    let mut h = Harness::spawn(sh("sleep 4 & echo started"));
    let started = Instant::now();
    assert_eq!(h.wait_for_exit(), Some(0));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(h.text().contains("started"));
    h.assert_nothing_after_exit();
}

#[test]
fn default_shell_is_a_login_shell_with_terminal_env() {
    let home = std::env::temp_dir()
        .canonicalize()
        .expect("temp dir must exist");
    let mut cmd = shell_command(home.to_str());
    // Pin the shell and keep the developer's own profile out of the test.
    cmd.env("SHELL", "/bin/sh");
    cmd.env("HOME", &home);

    let mut h = Harness::spawn(cmd);
    h.session
        .write(b"echo \"argv0=$0 prog=$TERM_PROGRAM term=$TERM dir=$(pwd -P)\"; exit 3\n".to_vec())
        .expect("write failed");
    assert_eq!(h.wait_for_exit(), Some(3));
    let expected = format!(
        "argv0=-sh prog=midterm term=xterm-256color dir={}",
        home.display()
    );
    assert!(h.text().contains(&expected), "output: {:?}", h.text());
}

#[test]
fn waiting_for_termination_does_not_reap() {
    let mut child = std::process::Command::new("/usr/bin/true")
        .spawn()
        .expect("spawn failed");
    assert!(wait_until_terminated(child.id()));
    // Still a zombie: its status (and so its pid) has not been released.
    let status = child.try_wait().expect("try_wait failed");
    assert_eq!(status.and_then(|s| s.code()), Some(0));
    // Not our child (any more): reported as failure instead of blocking.
    assert!(!wait_until_terminated(child.id()));
}

#[test]
fn event_json_shape() {
    let exit = |code| {
        let event = PtyEvent::Exit {
            code,
            runtime_ms: 12,
        };
        serde_json::to_string(&event).expect("serialize")
    };
    assert_eq!(
        exit(Some(0)),
        r#"{"event":"exit","data":{"code":0,"runtimeMs":12}}"#
    );
    assert_eq!(
        exit(None),
        r#"{"event":"exit","data":{"code":null,"runtimeMs":12}}"#
    );
}

/// Drives sessions through a [`PtyManager`], acking like a frontend would.
struct ManagedSession {
    id: u32,
    rx: mpsc::Receiver<Msg>,
}

impl ManagedSession {
    fn spawn(manager: &PtyManager, owner: &str, cmd: CommandBuilder) -> Self {
        let (sinks, rx) = channel_sinks();
        let id = manager
            .spawn(owner, cmd, 80, 24, sinks)
            .expect("spawn failed");
        Self { id, rx }
    }

    fn wait_for_output(&self, manager: &PtyManager, needle: &str) {
        let mut output = Vec::new();
        while !String::from_utf8_lossy(&output).contains(needle) {
            match self.rx.recv_timeout(TIMEOUT) {
                Ok(Msg::Data(bytes)) => {
                    manager.ack(self.id, bytes.len());
                    output.extend_from_slice(&bytes);
                }
                other => panic!("waiting for {needle:?}, got {other:?}"),
            }
        }
    }

    fn wait_for_exit(&self, manager: &PtyManager) -> Option<u32> {
        loop {
            match self.rx.recv_timeout(TIMEOUT) {
                Ok(Msg::Data(bytes)) => manager.ack(self.id, bytes.len()),
                Ok(Msg::Event(PtyEvent::Exit { code, .. })) => return code,
                Err(e) => panic!("no exit event: {e:?}"),
            }
        }
    }

    fn is_running(&self) -> bool {
        matches!(self.rx.recv_timeout(QUIET), Err(RecvTimeoutError::Timeout))
    }
}

#[test]
fn manager_forgets_sessions_that_exit() {
    let manager = PtyManager::default();
    // Includes children that exit before `spawn` has even returned.
    let sessions: Vec<_> = (0..16)
        .map(|_| ManagedSession::spawn(&manager, "main", sh("printf hi")))
        .collect();
    let mut ids: Vec<u32> = sessions.iter().map(|s| s.id).collect();
    ids.dedup();
    assert_eq!(ids.len(), 16, "ids must be unique");
    assert!(ids.iter().all(|id| *id > 0));

    for session in &sessions {
        assert_eq!(session.wait_for_exit(&manager), Some(0));
    }
    wait_until("sessions to be removed", || manager.len() == 0);
}

#[test]
fn manager_commands_on_unknown_ids() {
    let manager = PtyManager::default();
    assert!(manager.write(42, b"x".to_vec()).is_err());
    assert!(manager.resize(42, 80, 24).is_err());
    // Acks and kills race with exit by nature, so these are not errors.
    manager.ack(42, 10);
    manager.kill(42);
}

#[test]
fn manager_kill_is_idempotent() {
    let manager = PtyManager::default();
    let session = ManagedSession::spawn(&manager, "main", sh("echo ready; sleep 600"));
    session.wait_for_output(&manager, "ready");
    manager.write(session.id, b"x".to_vec()).expect("write");
    manager.resize(session.id, 120, 30).expect("resize");

    manager.kill(session.id);
    manager.kill(session.id);
    assert!(manager.write(session.id, b"x".to_vec()).is_err());
    assert_eq!(session.wait_for_exit(&manager), None);
    // Unregistered once the child is gone; killing again is still fine.
    wait_until("session to be removed", || manager.len() == 0);
    manager.kill(session.id);
}

#[test]
fn manager_kills_by_owner() {
    let manager = PtyManager::default();
    let a = ManagedSession::spawn(&manager, "a", sh("echo ready; sleep 600"));
    let b = ManagedSession::spawn(&manager, "b", sh("echo ready; sleep 600"));
    a.wait_for_output(&manager, "ready");
    b.wait_for_output(&manager, "ready");

    manager.kill_owned_by("a");
    assert_eq!(a.wait_for_exit(&manager), None);
    wait_until("session to be removed", || manager.len() == 1);
    assert!(b.is_running());

    manager.kill_all();
    assert_eq!(b.wait_for_exit(&manager), None);
    assert_eq!(manager.len(), 0);
}

#[test]
fn manager_kill_all_terminates_every_child() {
    let manager = PtyManager::default();
    let sessions = [
        ManagedSession::spawn(&manager, "main", sh("echo ready; sleep 600")),
        ManagedSession::spawn(&manager, "main", sh("echo ready; sleep 600")),
        // Ignores the hang-up, so this one needs the forced kill.
        ManagedSession::spawn(
            &manager,
            "main",
            sh("trap '' HUP; echo ready; while :; do :; done"),
        ),
    ];
    for session in &sessions {
        session.wait_for_output(&manager, "ready");
    }

    let started = Instant::now();
    manager.kill_all();
    // Bounded: shutdown must not hang on an uncooperative child.
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(manager.len(), 0);
    for session in &sessions {
        assert_eq!(session.wait_for_exit(&manager), None);
    }

    // Nothing can be started once the manager has shut down.
    let (sinks, _rx) = channel_sinks();
    assert!(manager.spawn("main", sh("true"), 80, 24, sinks).is_err());
}
