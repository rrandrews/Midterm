//! Registry of live PTY sessions, addressed by numeric id.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use portable_pty::CommandBuilder;

use super::session::{FlowLimits, PtyEvent, Session, Sinks};

/// Owns every running session. Registered as Tauri managed state, but has no
/// dependency on Tauri itself.
///
/// A session stays registered until its child process is confirmed dead and
/// its exit event has been sent; killing a session does not unregister it.
/// That way [`PtyManager::kill_all`] can still find, wait for and force-kill
/// a child that was asked to terminate a moment before the app quit.
///
/// Every `Session` operation used here returns promptly (writes are queued,
/// kills are asynchronous), so they are simply performed under the registry
/// lock.
#[derive(Default)]
pub struct PtyManager {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    registry: Mutex<Registry>,
    next_id: AtomicU32,
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<u32, Entry>,
    /// Set by [`PtyManager::kill_all`]; no session may be added afterwards.
    shut_down: bool,
}

const SHUT_DOWN: &str = "pty manager is shut down";

struct Entry {
    /// Label of the window the session belongs to.
    owner: String,
    session: Session,
}

impl Inner {
    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn remove(&self, id: u32) -> Option<Session> {
        // The guard is released before the caller gets to drop the session.
        let entry = self.registry().sessions.remove(&id);
        entry.map(|entry| entry.session)
    }
}

impl PtyManager {
    /// Starts `cmd` in a new session owned by the window `owner` and returns
    /// its id. The session removes itself once its exit event has been sent.
    pub fn spawn(
        &self,
        owner: &str,
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
        sinks: Sinks,
    ) -> Result<u32, String> {
        if self.inner.registry().shut_down {
            return Err(SHUT_DOWN.to_string());
        }
        // Ids start at 1 and are never reused within a run.
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed) + 1;

        let Sinks {
            on_data,
            mut on_event,
        } = sinks;
        // Weak: the session's threads must not keep the registry alive.
        let registry = Arc::downgrade(&self.inner);
        let sinks = Sinks {
            on_data,
            on_event: Box::new(move |event| {
                let exited = matches!(event, PtyEvent::Exit { .. });
                on_event(event);
                if exited && let Some(inner) = registry.upgrade() {
                    drop(inner.remove(id));
                }
            }),
        };

        let session = Session::spawn(cmd, cols, rows, FlowLimits::default(), sinks)?;
        let mut registry = self.inner.registry();
        if registry.shut_down {
            // `kill_all` ran while the child was being started and can no
            // longer take care of it.
            drop(registry);
            Session::kill_all_and_wait(&[session]);
            return Err(SHUT_DOWN.to_string());
        }
        // A very short-lived child may already have sent its exit event, in
        // which case the removal above ran before there was anything to
        // remove. `is_finished` is set before the event is emitted, so
        // checking it under the registry lock closes that race.
        if !session.is_finished() {
            registry.sessions.insert(
                id,
                Entry {
                    owner: owner.to_string(),
                    session,
                },
            );
        }
        Ok(id)
    }

    pub fn write(&self, id: u32, data: Vec<u8>) -> Result<(), String> {
        self.with(id, |session| session.write(data))
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        self.with(id, |session| session.resize(cols, rows))
    }

    /// Acknowledges output. Unknown ids are ignored: the last acks of a
    /// session routinely arrive after it has exited and been removed.
    pub fn ack(&self, id: u32, bytes: usize) {
        if let Some(entry) = self.inner.registry().sessions.get(&id) {
            entry.session.ack(bytes);
        }
    }

    /// Kills a session without blocking. It unregisters itself as soon as
    /// the child is gone. Unknown (including already exited) ids are ignored.
    pub fn kill(&self, id: u32) {
        if let Some(entry) = self.inner.registry().sessions.get(&id) {
            entry.session.kill();
        }
    }

    /// Kills every session owned by the window `owner`, without blocking.
    pub fn kill_owned_by(&self, owner: &str) {
        for entry in self.inner.registry().sessions.values() {
            if entry.owner == owner {
                entry.session.kill();
            }
        }
    }

    /// Kills every session and waits briefly for the children to go away,
    /// force-killing stragglers. Call when the application is exiting: the
    /// manager refuses to start new sessions afterwards.
    pub fn kill_all(&self) {
        let doomed: Vec<Session> = {
            let mut registry = self.inner.registry();
            registry.shut_down = true;
            let sessions = registry.sessions.drain();
            sessions.map(|(_, entry)| entry.session).collect()
        };
        Session::kill_all_and_wait(&doomed);
    }

    /// Number of sessions currently registered.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.registry().sessions.len()
    }

    fn with<T>(
        &self,
        id: u32,
        op: impl FnOnce(&Session) -> Result<T, String>,
    ) -> Result<T, String> {
        match self.inner.registry().sessions.get(&id) {
            Some(entry) => op(&entry.session),
            None => Err(format!("no pty session with id {id}")),
        }
    }
}
