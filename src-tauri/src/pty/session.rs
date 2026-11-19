//! A single PTY session: one child process attached to a pseudo-terminal,
//! plus the threads that move bytes between it and the UI.
//!
//! Nothing in here knows about Tauri. Output and lifecycle events are handed
//! to caller-supplied [`Sinks`], which is what makes the core testable with
//! plain `cargo test`.
//!
//! # Threads
//!
//! Each session runs four small threads. All of them block (on the PTY, the
//! child or a condvar); none polls:
//!
//! * **reader** – blocking `read()` on the PTY master, appending to a bounded
//!   in-memory buffer (`State::pending`).
//! * **pump** – takes whatever has accumulated in that buffer, hands it to the
//!   data sink as one chunk and applies flow control.
//! * **writer** – drains an input queue into the PTY master, so a child that
//!   has stopped reading can never block the caller of [`Session::write`].
//! * **waiter** – blocks in `wait()` on the child and reports its exit.
//!
//! The reader/pump split exists because a PTY returns small reads (1 KiB at a
//! time on macOS). Forwarding each one individually would cost an IPC round
//! trip per kilobyte; the pump coalesces them into chunks of up to
//! ~[`CHUNK_TARGET`] bytes without delaying interactive output.
//!
//! # Back-pressure
//!
//! `unacked` counts bytes handed to the data sink that the consumer has not
//! yet acknowledged via [`Session::ack`]. Above the high watermark the pump
//! stops; the buffer then fills, the reader stops, the kernel PTY buffer
//! fills and the child blocks in `write()`. Acks below the low watermark
//! release the chain again.
//!
//! # Exit ordering
//!
//! The exit event is the last thing a session ever emits; see
//! [`waiter_loop`] for how that is guaranteed.

use std::io::{self, Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{
    Child, ChildKiller, CommandBuilder, MasterPty, PtyPair, PtySize, native_pty_system,
};
use serde::Serialize;

/// Unacknowledged bytes above which output to the UI is paused.
pub const HIGH_WATERMARK: usize = 1024 * 1024;
/// Unacknowledged bytes at or below which paused output resumes.
pub const LOW_WATERMARK: usize = 256 * 1024;

/// Size of the buffer used for each `read()` on the PTY master.
const READ_BUF_SIZE: usize = 64 * 1024;
/// The reader stops once this much output is waiting for the pump, and the
/// pump flushes immediately once this much has accumulated. A chunk can
/// exceed this by at most one read.
const CHUNK_TARGET: usize = 64 * 1024;
/// Minimum spacing between two chunks, unless [`CHUNK_TARGET`] is reached
/// first. Output arriving after a quiet period is forwarded immediately, so
/// this only batches sustained output and never delays a keystroke echo.
const COALESCE_WINDOW: Duration = Duration::from_millis(4);
/// After the child has exited: how long the PTY may stay silent without
/// reaching EOF before we stop waiting for more output. EOF normally arrives
/// immediately; it does not when another process (e.g. a `nohup`ed job)
/// still holds the slave side open.
const DRAIN_IDLE: Duration = Duration::from_millis(250);
/// After the child has exited: upper bound on output still read from the
/// PTY. The exited child can only have left behind what fits in the kernel's
/// PTY buffer, so anything beyond this comes from another process that
/// inherited the terminal and must not hold back the exit event.
const DRAIN_MAX_BYTES: u64 = 1024 * 1024;
/// How long the exit event waits for the consumer to acknowledge the output
/// that preceded it, measured from the last acknowledgement.
const EXIT_ACK_TIMEOUT: Duration = Duration::from_secs(1);
/// Grace period between the polite hang-up and a forced kill.
const KILL_GRACE: Duration = Duration::from_millis(250);
/// How often opening a PTY is attempted before giving up; see [`open_pty`].
const OPEN_PTY_ATTEMPTS: u32 = 6;

/// Lifecycle notification sent to the UI.
///
/// Serialises as `{ "event": "exit", "data": { "code": 0 } }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum PtyEvent {
    /// The child process has exited and all of its output has been
    /// delivered. `code` is `None` when it was terminated by a signal.
    Exit { code: Option<u32> },
}

/// Flow-control thresholds, in bytes of unacknowledged output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlowLimits {
    /// Pause output when more than this many bytes are unacknowledged.
    pub high: usize,
    /// Resume once at most this many bytes are unacknowledged.
    pub low: usize,
}

impl Default for FlowLimits {
    fn default() -> Self {
        Self {
            high: HIGH_WATERMARK,
            low: LOW_WATERMARK,
        }
    }
}

/// Receives a chunk of raw PTY output. Returns `false` when the consumer is
/// gone, which terminates the session.
pub type DataSink = Box<dyn FnMut(Vec<u8>) -> bool + Send>;
/// Receives lifecycle events.
pub type EventSink = Box<dyn FnMut(PtyEvent) + Send>;

/// Where a session delivers its output. Calls are serialised: the sinks are
/// never invoked concurrently, and `on_data` is never invoked after
/// `on_event` has received [`PtyEvent::Exit`].
pub struct Sinks {
    pub on_data: DataSink,
    pub on_event: EventSink,
}

/// Handle to a running PTY session. Dropping it kills the child.
pub struct Session {
    shared: Arc<Shared>,
    #[cfg(test)]
    threads: Vec<thread::JoinHandle<()>>,
}

/// The parent's ends of the PTY. Dropped as a unit when the session closes.
struct PtyIo {
    master: Box<dyn MasterPty + Send>,
    /// Queue feeding the writer thread; dropping it stops that thread.
    input: mpsc::Sender<Vec<u8>>,
}

#[derive(Default)]
struct State {
    /// Output read from the PTY that the pump has not picked up yet.
    pending: Vec<u8>,
    /// Total bytes ever read from the PTY; a progress indicator.
    read_total: u64,
    /// The reader thread has finished (EOF, error or `closed`).
    eof: bool,
    /// The pump has taken a chunk that the data sink has not received yet.
    pump_busy: bool,
    /// Flow control is engaged: `unacked` exceeded the high watermark and
    /// has not come back down to the low one since.
    throttled: bool,
    /// The pump thread has finished; nothing more will reach the data sink.
    pump_done: bool,
    /// Bytes handed to the data sink and not yet acknowledged.
    unacked: usize,
    /// No further output may be delivered; reader and pump must stop.
    closed: bool,
    /// A kill was requested; nobody should wait for output or acks any more.
    killed: bool,
    /// The waiter has reaped the child, so its pid must not be signalled.
    child_exited: bool,
    /// The exit event has been (or is just about to be) emitted.
    finished: bool,
}

struct Shared {
    state: Mutex<State>,
    /// Signalled on every change to `state`. One condvar serves all threads;
    /// each waits in a loop on its own predicate.
    cond: Condvar,
    /// `None` once the exit event has been emitted. Held while calling
    /// `on_data`, which is what orders data against the exit event.
    sinks: Mutex<Option<Sinks>>,
    io: Mutex<Option<PtyIo>>,
    /// Owned by the waiter thread once it starts.
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    #[cfg_attr(not(unix), allow(dead_code))]
    pid: Option<u32>,
    limits: FlowLimits,
}

/// Locks a mutex, ignoring poisoning: everything guarded here is plain flags,
/// counters and handles that stay consistent even if a holder panicked.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        // A zero dimension makes many programs divide by zero or misrender.
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

impl Session {
    /// Opens a PTY of the given size, starts `cmd` on it and begins
    /// streaming its output to `sinks`.
    pub fn spawn(
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
        limits: FlowLimits,
        sinks: Sinks,
    ) -> Result<Self, String> {
        let pair = open_pty(pty_size(cols, rows))?;
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn process: {e:#}"))?;
        // The child has its own copies of the slave end. Ours must go, or
        // the master would never see EOF when the child exits.
        drop(pair.slave);

        let master = pair.master;
        let ends = master
            .try_clone_reader()
            .and_then(|reader| Ok((reader, master.take_writer()?)));
        let (reader, writer) = match ends {
            Ok(ends) => ends,
            Err(e) => {
                reap(child.as_mut());
                return Err(format!("failed to set up pty: {e:#}"));
            }
        };

        let (input, input_rx) = mpsc::channel();
        let shared = Arc::new(Shared {
            state: Mutex::default(),
            cond: Condvar::new(),
            sinks: Mutex::new(Some(sinks)),
            io: Mutex::new(Some(PtyIo { master, input })),
            killer: Mutex::new(child.clone_killer()),
            pid: child.process_id(),
            child: Mutex::new(Some(child)),
            limits,
        });

        match start_threads(&shared, reader, writer, input_rx) {
            Ok(threads) => {
                // Detached in normal builds; the tests keep the handles to
                // verify that no thread outlives its session.
                #[cfg(not(test))]
                drop(threads);
                Ok(Self {
                    shared,
                    #[cfg(test)]
                    threads,
                })
            }
            Err(e) => {
                // Stop whichever threads did start, then clean up the child
                // ourselves if the waiter never took ownership of it.
                shared.close();
                if let Some(mut child) = lock(&shared.child).take() {
                    reap(child.as_mut());
                }
                Err(format!("failed to start pty threads: {e}"))
            }
        }
    }

    /// Queues `data` to be written to the child's terminal input. Never
    /// blocks, and preserves the order of calls.
    pub fn write(&self, data: Vec<u8>) -> Result<(), String> {
        match lock(&self.shared.io).as_ref() {
            Some(io) => io.input.send(data).map_err(|_| closed_error()),
            None => Err(closed_error()),
        }
    }

    /// Changes the terminal size seen by the child (delivers `SIGWINCH`).
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        match lock(&self.shared.io).as_ref() {
            Some(io) => io
                .master
                .resize(pty_size(cols, rows))
                .map_err(|e| format!("failed to resize pty: {e:#}")),
            None => Err(closed_error()),
        }
    }

    /// Acknowledges that the consumer has finished processing `bytes` bytes
    /// previously delivered to the data sink.
    pub fn ack(&self, bytes: usize) {
        let mut st = lock(&self.shared.state);
        st.unacked = st.unacked.saturating_sub(bytes);
        if st.unacked <= self.shared.limits.low {
            st.throttled = false;
        }
        self.shared.cond.notify_all();
    }

    /// Terminates the child and stops output delivery. Returns immediately
    /// and is idempotent. The exit event is still emitted once the child is
    /// gone.
    pub fn kill(&self) {
        self.shared.kill();
    }

    /// Kills several sessions and waits (bounded by one shared grace period)
    /// until their children are gone, force-killing any that ignore the
    /// hang-up. For application shutdown, where the background escalation
    /// used by [`Session::kill`] would not get the chance to run.
    pub fn kill_all_and_wait(sessions: &[Session]) {
        for session in sessions {
            session.shared.begin_kill();
        }
        let deadline = Instant::now() + KILL_GRACE;
        for session in sessions {
            if !session.shared.wait_child_exit(deadline) {
                session.shared.force_kill();
            }
        }
    }

    /// True once the exit event has been emitted (or is being emitted).
    pub fn is_finished(&self) -> bool {
        lock(&self.shared.state).finished
    }

    /// True once every thread belonging to this session has terminated.
    #[cfg(test)]
    pub fn threads_finished(&self) -> bool {
        self.threads.iter().all(thread::JoinHandle::is_finished)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // A no-op if the child has already exited. Otherwise this is what
        // guarantees a discarded handle leaves neither a child process nor a
        // blocked thread behind.
        self.shared.kill();
    }
}

/// Opens a PTY pair, retrying transient failures.
///
/// On macOS, `openpty` fails spuriously with errno -6 when PTYs are being
/// opened and closed concurrently on other threads (reproducible by running
/// this module's tests in parallel without the retry). -6 is not a real
/// errno but XNU's kernel-internal `EREDRIVEOPEN`, which escapes to user
/// space while a `/dev/ttysNNN` node is being recycled. It clears within
/// milliseconds. portable-pty reports errors as text only, so every failure
/// is retried a few times with a short backoff (31 ms in total) before it is
/// believed.
fn open_pty(size: PtySize) -> Result<PtyPair, String> {
    let system = native_pty_system();
    let mut attempt = 0;
    loop {
        match system.openpty(size) {
            Ok(pair) => return Ok(pair),
            Err(e) => {
                attempt += 1;
                if attempt == OPEN_PTY_ATTEMPTS {
                    return Err(format!("failed to open pty: {e:#}"));
                }
                thread::sleep(Duration::from_millis(1 << (attempt - 1)));
            }
        }
    }
}

fn closed_error() -> String {
    "pty session is closed".to_string()
}

/// Kills and reaps a child that never got a waiter thread.
fn reap(child: &mut (dyn Child + Send + Sync)) {
    let _ = child.kill();
    let _ = child.wait();
}

fn start_threads(
    shared: &Arc<Shared>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    input: mpsc::Receiver<Vec<u8>>,
) -> io::Result<Vec<thread::JoinHandle<()>>> {
    let spawn = |name: &str, body: Box<dyn FnOnce() + Send>| {
        thread::Builder::new().name(name.to_string()).spawn(body)
    };
    let (s1, s2, s3) = (shared.clone(), shared.clone(), shared.clone());
    Ok(vec![
        spawn("pty-reader", Box::new(move || reader_loop(&s1, reader)))?,
        spawn("pty-pump", Box::new(move || pump_loop(&s2)))?,
        spawn("pty-writer", Box::new(move || writer_loop(writer, &input)))?,
        // Last, so that on any failure above the child is still in `shared`
        // for the caller to clean up.
        spawn("pty-waiter", Box::new(move || waiter_loop(&s3)))?,
    ])
}

/// Blocking read loop: PTY master -> `State::pending`.
fn reader_loop(shared: &Shared, mut reader: Box<dyn Read + Send>) {
    let mut buf = vec![0u8; READ_BUF_SIZE];
    loop {
        {
            // Back-pressure: leave further output in the kernel (and so
            // eventually block the child) while the pump is behind.
            let mut st = lock(&shared.state);
            while st.pending.len() >= CHUNK_TARGET && !st.closed {
                st = shared.wait(st);
            }
            if st.closed {
                break;
            }
        }
        match reader.read(&mut buf) {
            // EOF: every process holding the slave side has closed it.
            // (portable-pty maps Linux's EIO to this as well.)
            Ok(0) => break,
            Ok(n) => {
                let mut st = lock(&shared.state);
                if st.closed {
                    break;
                }
                st.pending.extend_from_slice(&buf[..n]);
                st.read_total += n as u64;
                shared.cond.notify_all();
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    // Close our duplicate of the master before announcing EOF.
    drop(reader);
    let mut st = lock(&shared.state);
    st.eof = true;
    shared.cond.notify_all();
}

/// `State::pending` -> data sink, with coalescing and flow control.
fn pump_loop(shared: &Arc<Shared>) {
    let mut last_flush: Option<Instant> = None;
    while let Some(chunk) = shared.next_chunk(last_flush) {
        // The sinks lock is held across the call so that the waiter, which
        // takes the sinks away before emitting the exit event, can never
        // overtake a chunk that is being delivered.
        let delivered = match lock(&shared.sinks).as_mut() {
            Some(sinks) => (sinks.on_data)(chunk),
            None => false,
        };
        if !delivered {
            // Nobody is listening any more; a terminal without a consumer
            // has no reason to keep running.
            shared.kill();
            break;
        }
        last_flush = Some(Instant::now());
        if !shared.wait_while_throttled() {
            break;
        }
    }
    let mut st = lock(&shared.state);
    st.pump_busy = false;
    st.pump_done = true;
    shared.cond.notify_all();
}

/// Input queue -> PTY master. Ends when the queue's sender is dropped (the
/// session closed) or the PTY rejects a write (the child is gone).
fn writer_loop(mut writer: Box<dyn Write + Send>, input: &mpsc::Receiver<Vec<u8>>) {
    while let Ok(data) = input.recv() {
        if writer
            .write_all(&data)
            .and_then(|()| writer.flush())
            .is_err()
        {
            break;
        }
    }
}

/// Waits for the child to exit, then emits the exit event as the very last
/// thing the session delivers.
///
/// The sequence matters:
///
/// 1. Reap the child and record that, atomically with respect to kills, so
///    nobody can signal a recycled pid (see [`Shared::reap`]).
/// 2. Close our write side of the PTY (required for EOF with ConPTY).
/// 3. Wait for the reader to hit EOF and the pump to deliver everything.
/// 4. Forbid further output (`closed`).
/// 5. Wait for the consumer to acknowledge what it was sent. Data and events
///    reach the UI over independent channels, so emitting in order is not
///    enough to be *received* in order; an acknowledgement is proof that the
///    output has actually arrived.
/// 6. Take the sinks away and emit the exit event.
///
/// A kill short-circuits steps 3 and 5: nobody is interested in the rest.
fn waiter_loop(shared: &Shared) {
    let Some(child) = lock(&shared.child).take() else {
        return;
    };
    let code = match shared.reap(child) {
        Ok(status) if status.signal().is_none() => Some(status.exit_code()),
        _ => None,
    };

    // On Unix this does not disturb the reader: it owns a duplicate of the
    // master descriptor, so buffered output stays readable. On Windows the
    // pseudo-console must be closed before its output pipe reports EOF.
    shared.close_io();

    shared.wait_for_drain();
    {
        let mut st = lock(&shared.state);
        st.closed = true;
        shared.cond.notify_all();
    }
    shared.wait_for_acks();

    // Taking the sinks waits for an in-flight `on_data` call to return and
    // makes any later one impossible.
    let sinks = lock(&shared.sinks).take();
    lock(&shared.state).finished = true;
    if let Some(mut sinks) = sinks {
        // No locks are held here: the sink is free to drop the `Session`.
        (sinks.on_event)(PtyEvent::Exit { code });
    }
}

/// Blocks until the process `pid` has terminated, leaving it unreaped (a
/// zombie) so that its pid stays reserved. Returns `false` if that could not
/// be done.
#[cfg(unix)]
pub(super) fn wait_until_terminated(pid: u32) -> bool {
    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: `info` points to writable memory of the right size and
        // alignment; waitid(2) has no other memory-safety preconditions.
        let rc = unsafe {
            libc::waitid(
                libc::P_PID,
                libc::id_t::from(pid),
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if rc == 0 {
            return true;
        }
        if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return false;
        }
    }
}

impl Shared {
    /// Waits for the child to exit, reaps it and records that in
    /// `child_exited`.
    ///
    /// Kills signal the child by pid, under the state lock, after checking
    /// `child_exited`. For that check to mean anything, reaping (which frees
    /// the pid for reuse by an unrelated process) and setting the flag must
    /// be atomic under the same lock. So on Unix we first wait *without*
    /// reaping, and only then reap the zombie, which cannot block, while
    /// holding the lock.
    fn reap(
        &self,
        mut child: Box<dyn Child + Send + Sync>,
    ) -> io::Result<portable_pty::ExitStatus> {
        #[cfg(unix)]
        if self.pid.is_some_and(wait_until_terminated) {
            let mut st = lock(&self.state);
            let status = child.wait();
            st.child_exited = true;
            self.cond.notify_all();
            return status;
        }
        // Windows (a process handle, unlike a pid, is never recycled while
        // open), or the unexpected case of waitid failing.
        let status = child.wait();
        let mut st = lock(&self.state);
        st.child_exited = true;
        self.cond.notify_all();
        status
    }

    fn wait<'a>(&self, guard: MutexGuard<'a, State>) -> MutexGuard<'a, State> {
        self.cond
            .wait(guard)
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Waits for a state change or until `deadline`, whichever comes first.
    fn wait_until<'a>(
        &self,
        guard: MutexGuard<'a, State>,
        deadline: Instant,
    ) -> MutexGuard<'a, State> {
        let timeout = deadline.saturating_duration_since(Instant::now());
        self.cond
            .wait_timeout(guard, timeout)
            .unwrap_or_else(PoisonError::into_inner)
            .0
    }

    /// Blocks until there is output to deliver and returns it, already
    /// counted as unacknowledged. `None` means the pump should stop.
    fn next_chunk(&self, last_flush: Option<Instant>) -> Option<Vec<u8>> {
        let mut st = lock(&self.state);
        loop {
            if st.closed {
                return None;
            }
            if !st.pending.is_empty() {
                break;
            }
            if st.eof {
                return None;
            }
            st = self.wait(st);
        }
        // Having just sent a chunk, give the reader a moment to accumulate
        // more instead of forwarding every small read on its own.
        if let Some(deadline) = last_flush.map(|at| at + COALESCE_WINDOW) {
            while st.pending.len() < CHUNK_TARGET
                && !st.eof
                && !st.closed
                && Instant::now() < deadline
            {
                st = self.wait_until(st, deadline);
            }
            if st.closed {
                return None;
            }
        }
        let chunk = std::mem::take(&mut st.pending);
        // Counted before delivery so an ack can never arrive "early".
        st.unacked += chunk.len();
        if st.unacked > self.limits.high {
            st.throttled = true;
        }
        st.pump_busy = true;
        // The reader may be waiting for room in `pending`.
        self.cond.notify_all();
        Some(chunk)
    }

    /// Called once a chunk has reached the data sink. Applies flow control:
    /// if that chunk pushed `unacked` over the high watermark, blocks until
    /// acks have brought it down to the low one. Returns `false` if the
    /// session was closed meanwhile (which is how a kill wakes a stalled
    /// pump).
    fn wait_while_throttled(&self) -> bool {
        let mut st = lock(&self.state);
        // Nothing is in transit any more; the waiter may be watching for
        // exactly this, and must not mistake a stalled pump for pending
        // output.
        st.pump_busy = false;
        self.cond.notify_all();
        while st.throttled && !st.closed {
            st = self.wait(st);
        }
        !st.closed
    }

    /// After the child exited: waits until all of its output has been handed
    /// to the data sink.
    fn wait_for_drain(&self) {
        let mut st = lock(&self.state);
        let start = st.read_total;
        let mut seen = st.read_total;
        let mut idle_since: Option<Instant> = None;
        while !st.pump_done && !st.closed {
            if st.read_total - start > DRAIN_MAX_BYTES {
                // Still producing: this is not the exited child's output.
                break;
            }
            let in_transit = !st.pending.is_empty() || st.pump_busy;
            if st.eof && !in_transit {
                // Everything was delivered; the pump itself is merely
                // stalled by flow control with nothing left to send.
                break;
            }
            if in_transit || st.read_total != seen {
                seen = st.read_total;
                idle_since = None;
            }
            if in_transit {
                // Output that has not reached the sink yet (possibly because
                // flow control has stalled the pump) must be waited for,
                // however long the UI takes to make room.
                st = self.wait(st);
                continue;
            }
            // Everything read so far is delivered and the reader is blocked
            // in `read()`. EOF should follow at once; if the PTY stays
            // silent instead, something else is keeping the slave open.
            let deadline = *idle_since.get_or_insert_with(Instant::now) + DRAIN_IDLE;
            if Instant::now() >= deadline {
                break;
            }
            st = self.wait_until(st, deadline);
        }
    }

    /// After output has stopped: waits until the consumer has acknowledged
    /// all of it, giving up when acks stop arriving.
    fn wait_for_acks(&self) {
        let mut st = lock(&self.state);
        let mut seen = st.unacked;
        let mut deadline = Instant::now() + EXIT_ACK_TIMEOUT;
        while st.unacked > 0 && !st.killed {
            if st.unacked != seen {
                seen = st.unacked;
                deadline = Instant::now() + EXIT_ACK_TIMEOUT;
            } else if Instant::now() >= deadline {
                break;
            }
            st = self.wait_until(st, deadline);
        }
    }

    /// Waits until the waiter has reaped the child. Returns whether it has.
    fn wait_child_exit(&self, deadline: Instant) -> bool {
        let mut st = lock(&self.state);
        while !st.child_exited && Instant::now() < deadline {
            st = self.wait_until(st, deadline);
        }
        st.child_exited
    }

    /// Drops the master and the input queue (which stops the writer thread).
    fn close_io(&self) {
        let io = lock(&self.io).take();
        drop(io);
    }

    /// Stops output delivery and releases the PTY, without signalling the
    /// child. Wakes every thread blocked on the condvar.
    fn close(&self) {
        {
            let mut st = lock(&self.state);
            st.killed = true;
            st.closed = true;
            self.cond.notify_all();
        }
        self.close_io();
    }

    /// First half of a kill: stop output, wake blocked threads and ask the
    /// child to terminate (`SIGHUP` on Unix, `TerminateProcess` on Windows).
    /// Returns whether the child was signalled by this call.
    fn begin_kill(&self) -> bool {
        let signalled = {
            let mut st = lock(&self.state);
            let first = !st.killed;
            st.killed = true;
            // Wakes a pump stalled on flow control and a reader stalled on
            // back-pressure; both exit when they see `closed`.
            st.closed = true;
            self.cond.notify_all();
            // Signalled under the state lock, after checking `child_exited`,
            // so we never hit a pid the waiter has already reaped (the
            // waiter reaps under this lock; see `reap`).
            if first && !st.child_exited {
                let _ = lock(&self.killer).kill();
                true
            } else {
                false
            }
        };
        // Releasing our master descriptors lets the kernel hang up the
        // terminal as soon as the reader lets go of its duplicate.
        self.close_io();
        signalled
    }

    /// Second half of a kill, for children that ignore the hang-up.
    fn force_kill(&self) {
        let st = lock(&self.state);
        if st.child_exited {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self
            .pid
            .and_then(|pid| libc::pid_t::try_from(pid).ok())
            .filter(|pid| *pid > 0)
        {
            // SAFETY: kill(2) has no memory-safety preconditions. `pid` is a
            // positive pid of our own, not yet reaped child (checked above
            // under the lock the waiter holds while reaping), so it cannot
            // name another process or a process group.
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = lock(&self.killer).kill();
        }
    }

    /// Non-blocking kill: hang up now, force-kill from a short-lived helper
    /// thread if the child is still alive after [`KILL_GRACE`].
    fn kill(self: &Arc<Self>) {
        if !self.begin_kill() {
            return;
        }
        let shared = Arc::clone(self);
        let escalate = move || {
            if !shared.wait_child_exit(Instant::now() + KILL_GRACE) {
                shared.force_kill();
            }
        };
        let spawned = thread::Builder::new()
            .name("pty-kill".to_string())
            .spawn(escalate);
        if spawned.is_err() {
            // Cannot wait in the background, so do not wait at all.
            self.force_kill();
        }
    }
}
