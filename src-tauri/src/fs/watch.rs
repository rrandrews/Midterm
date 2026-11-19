//! Directory watching for the explorer: each watcher follows a set of
//! directories (non-recursively) and reports which of them may have changed.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use notify_debouncer_mini::{DebounceEventResult, new_debouncer};
use serde::Serialize;

/// How long a path must be quiet before its change is reported.
pub const DEBOUNCE: Duration = Duration::from_millis(150);

/// Sent to the frontend, as `WatchEvent` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WatchEvent {
    /// Watched directories, as the frontend spelled them, whose listing may
    /// have changed. Never empty, no duplicates.
    pub dirs: Vec<String>,
}

/// Receives the directories to report. Called on the debouncer's thread.
pub type Sink = Box<dyn FnMut(Vec<String>) + Send>;

/// The watched set: each directory as the frontend asked for it, and its
/// canonical form.
///
/// Event paths are canonical (FSEvents reports `/private/tmp/x` for a watch
/// on `/tmp/x`), so they are matched against the canonical form and
/// reported in the requested one. Two requested spellings of one directory
/// share a single OS watch and are both reported.
#[derive(Debug, Default)]
pub(crate) struct WatchedDirs {
    canonical_of: HashMap<String, PathBuf>,
    requested_as: HashMap<PathBuf, Vec<String>>,
}

impl WatchedDirs {
    /// Records `requested`. True if `canonical` was not watched before.
    pub(crate) fn insert(&mut self, requested: String, canonical: PathBuf) -> bool {
        let spellings = self.requested_as.entry(canonical.clone()).or_default();
        let new = spellings.is_empty();
        spellings.push(requested.clone());
        self.canonical_of.insert(requested, canonical);
        new
    }

    /// Forgets `requested`. Returns its canonical path if nothing else
    /// needs it watched any more.
    pub(crate) fn remove(&mut self, requested: &str) -> Option<PathBuf> {
        let canonical = self.canonical_of.remove(requested)?;
        let spellings = self.requested_as.get_mut(&canonical)?;
        spellings.retain(|s| s != requested);
        if spellings.is_empty() {
            self.requested_as.remove(&canonical);
            Some(canonical)
        } else {
            None
        }
    }

    fn contains(&self, requested: &str) -> bool {
        self.canonical_of.contains_key(requested)
    }

    fn requested(&self, canonical: &Path) -> &[String] {
        self.requested_as.get(canonical).map_or(&[], Vec::as_slice)
    }

    fn is_watched(&self, canonical: &Path) -> bool {
        self.requested_as.contains_key(canonical)
    }
}

/// Which watched directories to report for a batch of changed paths.
///
/// * A created, deleted or renamed entry changes its parent's listing, so a
///   path reports its parent; a path that is itself a watched directory is
///   reported too (it was deleted, created or had its metadata changed).
/// * A path inside a watched `.git` directory reports only that `.git`
///   directory, so the frontend can tell "git state changed" from "this
///   listing changed".
///
/// Directories that are not watched are never reported: the frontend has
/// no listing for them.
pub(crate) fn reported_dirs<'a>(
    changed: impl IntoIterator<Item = &'a Path>,
    watched: &WatchedDirs,
) -> Vec<String> {
    let mut out = BTreeSet::new();
    for path in changed {
        let git_dir = path
            .ancestors()
            .skip(1)
            .find(|a| a.file_name().is_some_and(|n| n == ".git") && watched.is_watched(a));
        if let Some(git_dir) = git_dir {
            out.extend(watched.requested(git_dir));
            continue;
        }
        if let Some(parent) = path.parent() {
            out.extend(watched.requested(parent));
        }
        out.extend(watched.requested(path));
    }
    out.into_iter().cloned().collect()
}

struct SetRequest {
    dirs: Vec<String>,
    /// Signalled once the set has been applied (tests only, in practice).
    done: Option<Sender<()>>,
}

/// One watcher: a debouncer plus a worker thread that applies changes to
/// the watched set. Dropping it stops both.
///
/// Changing the set is done on the worker because it can be slow (every
/// directory is canonicalized, and on macOS the FSEvents stream is torn
/// down and recreated), while the command that requests it must return at
/// once and in order: if `fs_watch_set` ran on Tauri's async pool, two
/// quick calls could be applied in the wrong order. The worker also skips
/// straight to the latest of several queued sets.
pub struct DirWatch {
    requests: Sender<SetRequest>,
    #[cfg(test)]
    dirs: Arc<Mutex<WatchedDirs>>,
}

fn lock(dirs: &Mutex<WatchedDirs>) -> MutexGuard<'_, WatchedDirs> {
    dirs.lock().unwrap_or_else(PoisonError::into_inner)
}

impl DirWatch {
    pub fn start(mut sink: Sink) -> Result<Self, String> {
        let dirs = Arc::new(Mutex::new(WatchedDirs::default()));
        let handler_dirs = Arc::clone(&dirs);
        let debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| {
            // Errors (e.g. a dropped event queue) carry no paths to report.
            let Ok(events) = result else { return };
            let reported = reported_dirs(
                events.iter().map(|e| e.path.as_path()),
                &lock(&handler_dirs),
            );
            if !reported.is_empty() {
                sink(reported);
            }
        })
        .map_err(|e| format!("cannot start watcher: {e}"))?;

        let (requests, rx) = mpsc::channel();
        let worker_dirs = Arc::clone(&dirs);
        thread::Builder::new()
            .name("fs-watch".into())
            .spawn(move || {
                let mut debouncer = debouncer;
                worker(&rx, debouncer.watcher(), &worker_dirs);
                // `debouncer` is dropped here, stopping the OS watch.
            })
            .map_err(|e| format!("cannot start watcher thread: {e}"))?;

        Ok(DirWatch {
            requests,
            #[cfg(test)]
            dirs,
        })
    }

    /// Replaces the watched set. Applied shortly after, in order.
    pub fn set(&self, dirs: Vec<String>) {
        // Fails only if the worker is gone, i.e. the watch is being stopped.
        let _ = self.requests.send(SetRequest { dirs, done: None });
    }

    #[cfg(test)]
    fn set_and_wait(&self, dirs: Vec<String>) {
        let (done, wait) = mpsc::channel();
        self.requests
            .send(SetRequest {
                dirs,
                done: Some(done),
            })
            .unwrap();
        wait.recv_timeout(Duration::from_secs(10)).unwrap();
    }

    #[cfg(test)]
    fn watched(&self) -> Vec<String> {
        let mut dirs: Vec<_> = lock(&self.dirs).canonical_of.keys().cloned().collect();
        dirs.sort();
        dirs
    }
}

fn worker(rx: &Receiver<SetRequest>, watcher: &mut dyn Watcher, dirs: &Mutex<WatchedDirs>) {
    while let Ok(mut request) = rx.recv() {
        let mut done: Vec<Sender<()>> = request.done.take().into_iter().collect();
        while let Ok(mut newer) = rx.try_recv() {
            done.extend(newer.done.take());
            request = newer;
        }
        apply(watcher, dirs, request.dirs);
        for d in done {
            let _ = d.send(());
        }
    }
}

/// Watches what is in `wanted` but not yet watched and unwatches the rest.
/// Directories that do not exist (or are not directories) are skipped
/// without error; since they are not recorded, the next set retries them.
fn apply(watcher: &mut dyn Watcher, dirs: &Mutex<WatchedDirs>, wanted: Vec<String>) {
    // Held throughout so events are never matched against a half-applied
    // set. The event handler only waits on it; it is never held while
    // waiting on the debouncer, so this cannot deadlock.
    let mut state = lock(dirs);
    let wanted: HashSet<String> = wanted.into_iter().collect();
    let removed: Vec<String> = state
        .canonical_of
        .keys()
        .filter(|d| !wanted.contains(*d))
        .cloned()
        .collect();
    let added: Vec<String> = wanted.into_iter().filter(|d| !state.contains(d)).collect();
    if removed.is_empty() && added.is_empty() {
        return;
    }

    // One batch, so macOS rebuilds its FSEvents stream once, not per path.
    let mut paths = watcher.paths_mut();
    for dir in removed {
        if let Some(canonical) = state.remove(&dir) {
            // Fails if the OS already dropped the watch (inotify does when
            // the directory is deleted); either way it is gone.
            let _ = paths.remove(&canonical);
        }
    }
    for dir in added {
        let Ok(canonical) = Path::new(&dir).canonicalize() else {
            continue;
        };
        if !canonical.is_dir() {
            continue;
        }
        if state.is_watched(&canonical) {
            state.insert(dir, canonical);
            continue;
        }
        if paths.add(&canonical, RecursiveMode::NonRecursive).is_ok() {
            state.insert(dir, canonical);
        }
    }
    if let Err(e) = paths.commit() {
        eprintln!("fs watch: cannot apply watched directories: {e}");
    }
}

/// Registry of watchers in Tauri managed state, by id, each tagged with the
/// label of the window that started it so that it can be stopped with the
/// window's page, as PTYs are.
#[derive(Default)]
pub struct WatchManager {
    registry: Mutex<Registry>,
}

#[derive(Default)]
struct Registry {
    watches: HashMap<u32, Entry>,
    next_id: u32,
    /// Set by [`WatchManager::stop_all`]; nothing may start afterwards.
    shut_down: bool,
}

struct Entry {
    owner: String,
    watch: DirWatch,
}

impl WatchManager {
    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts a watcher with an empty set and returns its id (from 1, never
    /// reused within a run).
    pub fn start(&self, owner: &str, sink: Sink) -> Result<u32, String> {
        let watch = DirWatch::start(sink)?;
        let mut registry = self.registry();
        if registry.shut_down {
            return Err("watch manager is shut down".into());
        }
        registry.next_id += 1;
        let id = registry.next_id;
        let owner = owner.to_string();
        registry.watches.insert(id, Entry { owner, watch });
        Ok(id)
    }

    pub fn set(&self, id: u32, dirs: Vec<String>) -> Result<(), String> {
        match self.registry().watches.get(&id) {
            Some(entry) => {
                entry.watch.set(dirs);
                Ok(())
            }
            None => Err(format!("no watcher with id {id}")),
        }
    }

    /// Stops a watcher. Unknown ids are ignored.
    pub fn stop(&self, id: u32) {
        // Dropping only disconnects the worker, which then stops the OS
        // watch on its own thread.
        let entry = self.registry().watches.remove(&id);
        drop(entry);
    }

    pub fn stop_owned_by(&self, owner: &str) {
        self.registry()
            .watches
            .retain(|_, entry| entry.owner != owner);
    }

    pub fn stop_all(&self) {
        let mut registry = self.registry();
        registry.shut_down = true;
        registry.watches.clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.registry().watches.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn watched(entries: &[(&str, &str)]) -> WatchedDirs {
        let mut dirs = WatchedDirs::default();
        for (requested, canonical) in entries {
            dirs.insert(requested.to_string(), PathBuf::from(canonical));
        }
        dirs
    }

    fn report(paths: &[&str], dirs: &WatchedDirs) -> Vec<String> {
        reported_dirs(paths.iter().map(Path::new), dirs)
    }

    #[test]
    fn a_change_reports_its_watched_parent_in_the_requested_spelling() {
        let dirs = watched(&[
            ("/tmp/p", "/private/tmp/p"),
            ("/tmp/p/src", "/private/tmp/p/src"),
        ]);
        assert_eq!(report(&["/private/tmp/p/new.txt"], &dirs), ["/tmp/p"]);
        assert_eq!(
            report(
                &["/private/tmp/p/src/a.rs", "/private/tmp/p/src/b.rs"],
                &dirs
            ),
            ["/tmp/p/src"]
        );
        // Not watched: nothing to report.
        assert!(report(&["/private/tmp/other/x"], &dirs).is_empty());
    }

    #[test]
    fn a_watched_directory_itself_reports_it_and_its_parent() {
        let dirs = watched(&[("/p", "/p"), ("/p/src", "/p/src")]);
        assert_eq!(report(&["/p/src"], &dirs), ["/p", "/p/src"]);
        let only_child = watched(&[("/p/src", "/p/src")]);
        assert_eq!(report(&["/p/src"], &only_child), ["/p/src"]);
    }

    #[test]
    fn changes_inside_a_watched_git_dir_report_only_the_git_dir() {
        let dirs = watched(&[("/r", "/r"), ("/r/.git", "/r/.git")]);
        assert_eq!(report(&["/r/.git/index"], &dirs), ["/r/.git"]);
        assert_eq!(report(&["/r/.git/refs/heads/main"], &dirs), ["/r/.git"]);
        assert_eq!(
            report(&["/r/.git/index.lock", "/r/file"], &dirs),
            ["/r", "/r/.git"]
        );
        // `.git` itself (say, deleted) is an ordinary watched directory.
        assert_eq!(report(&["/r/.git"], &dirs), ["/r", "/r/.git"]);
        // An unwatched `.git` falls back to the parent rule.
        let no_git = watched(&[("/r", "/r")]);
        assert!(report(&["/r/.git/index"], &no_git).is_empty());
        assert_eq!(report(&["/r/.git"], &no_git), ["/r"]);
    }

    #[test]
    fn two_spellings_of_one_directory_share_a_watch() {
        let mut dirs = WatchedDirs::default();
        assert!(dirs.insert("/tmp/p".into(), "/private/tmp/p".into()));
        assert!(!dirs.insert("/private/tmp/p".into(), "/private/tmp/p".into()));
        assert_eq!(
            report(&["/private/tmp/p/x"], &dirs),
            ["/private/tmp/p", "/tmp/p"]
        );
        assert_eq!(dirs.remove("/tmp/p"), None);
        assert_eq!(dirs.remove("/private/tmp/p"), Some("/private/tmp/p".into()));
        assert_eq!(dirs.remove("/private/tmp/p"), None);
        assert!(report(&["/private/tmp/p/x"], &dirs).is_empty());
    }

    fn string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    /// Keeps poking `poke` until an event naming `expected` arrives. Real
    /// file system events can be slow to start flowing after a watch is set
    /// up (FSEvents in particular), so a single write could be missed.
    fn wait_for(events: &Receiver<Vec<String>>, expected: &str, mut poke: impl FnMut(usize)) {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut i = 0;
        while Instant::now() < deadline {
            poke(i);
            i += 1;
            if let Ok(dirs) = events.recv_timeout(Duration::from_millis(500))
                && dirs.iter().any(|d| d == expected)
            {
                return;
            }
        }
        panic!("no event for {expected}");
    }

    #[test]
    fn reports_real_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_owned();
        let git = root.join(".git");
        std::fs::create_dir(&git).unwrap();
        let (tx, events) = mpsc::channel();
        let watch = DirWatch::start(Box::new(move |dirs| {
            let _ = tx.send(dirs);
        }))
        .unwrap();

        let missing = root.join("missing");
        watch.set_and_wait(vec![string(&root), string(&git), string(&missing)]);
        assert_eq!(watch.watched(), [string(&root), string(&git)]);

        wait_for(&events, &string(&root), |i| {
            std::fs::write(root.join(format!("file{i}")), "x").unwrap();
        });
        wait_for(&events, &string(&git), |i| {
            std::fs::write(git.join("index"), i.to_string()).unwrap();
        });

        // A directory that appears later is picked up by the next set.
        std::fs::create_dir(&missing).unwrap();
        watch.set_and_wait(vec![string(&missing)]);
        assert_eq!(watch.watched(), [string(&missing)]);
        wait_for(&events, &string(&missing), |i| {
            std::fs::write(missing.join(format!("f{i}")), "x").unwrap();
        });
    }

    #[test]
    fn manager_tracks_owners() {
        let manager = WatchManager::default();
        let a = manager.start("main", Box::new(|_| {})).unwrap();
        let b = manager.start("other", Box::new(|_| {})).unwrap();
        assert_ne!(a, b);
        manager.set(a, vec![]).unwrap();
        assert!(manager.set(999, vec![]).is_err());
        manager.stop(999);
        manager.stop_owned_by("main");
        assert_eq!(manager.len(), 1);
        assert!(manager.set(a, vec![]).is_err());
        manager.stop(b);
        assert_eq!(manager.len(), 0);
        manager.start("main", Box::new(|_| {})).unwrap();
        manager.stop_all();
        assert_eq!(manager.len(), 0);
        assert!(manager.start("main", Box::new(|_| {})).is_err());
    }
}
