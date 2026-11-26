//! Copying a file or directory tree into a directory, for the explorer's
//! copy and paste, with optional progress reporting and cancellation.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Chunk size for local file copies with progress/cancellation checks (256 KiB).
const COPY_CHUNK_SIZE: usize = 256 * 1024;
/// Minimum interval between intermediate progress emissions.
pub(crate) const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
/// Maximum recursion depth when pre-measuring a local directory tree.
const MEASURE_MAX_DEPTH: usize = 256;

/// Progress snapshot emitted during a copy or cross-host transfer.
/// Matches `CopyProgress` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyProgress {
    pub bytes_transferred: u64,
    pub total_bytes: Option<u64>,
    pub files_completed: u64,
    pub total_files: Option<u64>,
    pub current_file: Option<String>,
}

/// Streaming events for `fs_copy_start`.
/// Matches `TransferEvent` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TransferEvent {
    Progress(CopyProgress),
    Done { path: String },
    Error { message: String, cancelled: bool },
}

/// Outcome error distinguishing user cancellation from I/O failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopyError {
    Cancelled,
    Failed(String),
}

impl CopyError {
    pub fn into_string(self) -> String {
        match self {
            CopyError::Cancelled => "transfer cancelled".into(),
            CopyError::Failed(msg) => msg,
        }
    }
}

/// Registry of running file transfers, kept in Tauri managed state so the
/// frontend can cancel them and window teardown cleans them up.
#[derive(Default)]
pub struct TransferManager {
    state: Mutex<TransferState>,
    done: Condvar,
}

struct TransferState {
    next_id: u32,
    active: HashMap<u32, (String, Arc<AtomicBool>)>,
}

impl Default for TransferState {
    fn default() -> Self {
        Self {
            next_id: 1,
            active: HashMap::new(),
        }
    }
}

impl TransferManager {
    fn lock(&self) -> MutexGuard<'_, TransferState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn register(&self, window: &str) -> Result<(u32, Arc<AtomicBool>), String> {
        let mut state = self.lock();
        let id = state.next_id;
        state.next_id = state
            .next_id
            .checked_add(1)
            .ok_or_else(|| "transfer id overflow".to_string())?;
        let cancel = Arc::new(AtomicBool::new(false));
        state.active.insert(id, (window.to_string(), cancel.clone()));
        Ok((id, cancel))
    }

    pub fn finish(&self, id: u32) {
        let mut state = self.lock();
        state.active.remove(&id);
        if state.active.is_empty() {
            self.done.notify_all();
        }
    }

    /// Cancels `id` only if it belongs to `window`.
    pub fn cancel_for_window(&self, window: &str, id: u32) {
        if let Some((owner, flag)) = self.lock().active.get(&id)
            && owner == window
        {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn cancel_owned_by(&self, window: &str) {
        let state = self.lock();
        for (owner, flag) in state.active.values() {
            if owner == window {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    /// Cancels every active transfer and waits up to `timeout` for workers (and
    /// any remote staging rollback) to finish before teardown closes transports.
    pub fn cancel_all_and_wait(&self, timeout: Duration) {
        let mut state = self.lock();
        for (_, flag) in state.active.values() {
            flag.store(true, Ordering::Relaxed);
        }
        let deadline = Instant::now() + timeout;
        while !state.active.is_empty() {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let (guard, result) = self
                .done
                .wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            state = guard;
            if result.timed_out() {
                break;
            }
        }
    }
}

/// Measures the total regular-file bytes and entry count under a local path
/// (without following symlinks). Returns `None` if cancelled.
pub(crate) fn measure_local_source(from: &Path, cancel: &AtomicBool) -> Option<(u64, u64)> {
    let mut bytes = 0u64;
    let mut files = 0u64;
    fn walk(path: &Path, depth: usize, cancel: &AtomicBool, bytes: &mut u64, files: &mut u64) -> bool {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        if depth >= MEASURE_MAX_DEPTH {
            return true;
        }
        let Ok(meta) = fs::symlink_metadata(path) else {
            return true;
        };
        match Kind::of(&meta) {
            Kind::File => {
                *bytes = bytes.saturating_add(meta.len());
                *files = files.saturating_add(1);
            }
            Kind::Symlink => {
                *files = files.saturating_add(1);
            }
            Kind::Dir => {
                let Ok(rd) = fs::read_dir(path) else {
                    return true;
                };
                for entry in rd.flatten() {
                    if !walk(&entry.path(), depth + 1, cancel, bytes, files) {
                        return false;
                    }
                }
            }
            Kind::Special => {}
        }
        true
    }
    if walk(from, 0, cancel, &mut bytes, &mut files) {
        Some((bytes, files))
    } else {
        None
    }
}

struct ProgressTracker<'a> {
    bytes_transferred: u64,
    total_bytes: Option<u64>,
    files_completed: u64,
    total_files: Option<u64>,
    current_file: Option<String>,
    last_emit: Option<Instant>,
    emit: &'a mut dyn FnMut(CopyProgress),
}

impl<'a> ProgressTracker<'a> {
    fn new(
        total_bytes: Option<u64>,
        total_files: Option<u64>,
        emit: &'a mut dyn FnMut(CopyProgress),
    ) -> Self {
        Self {
            bytes_transferred: 0,
            total_bytes,
            files_completed: 0,
            total_files,
            current_file: None,
            last_emit: None,
            emit,
        }
    }

    fn emit_now(&mut self) {
        self.last_emit = Some(Instant::now());
        (self.emit)(CopyProgress {
            bytes_transferred: self.bytes_transferred,
            total_bytes: self.total_bytes,
            files_completed: self.files_completed,
            total_files: self.total_files,
            current_file: self.current_file.clone(),
        });
    }

    fn emit_throttled(&mut self) {
        let should_emit = self
            .last_emit
            .is_none_or(|t| t.elapsed() >= PROGRESS_INTERVAL);
        if should_emit {
            self.emit_now();
        }
    }

    fn start_file(&mut self, name: String) {
        self.current_file = Some(name);
        self.emit_throttled();
    }

    fn add_bytes(&mut self, n: u64) {
        self.bytes_transferred = self.bytes_transferred.saturating_add(n);
        self.emit_throttled();
    }

    fn finish_file(&mut self) {
        self.files_completed = self.files_completed.saturating_add(1);
        self.emit_throttled();
    }
}

/// Copies `from` (a file, a directory tree or a symlink) into the directory
/// `to_dir` and returns the path of the copy. Nothing is ever replaced: if
/// the name is taken, the copy is named as Finder does ("a copy.txt", then
/// "a copy 2.txt", ...; "dir copy"; ".env copy").
///
/// Symlinks are copied as links, not followed, also inside a directory.
/// Permissions are kept. Sockets, FIFOs and devices inside a directory are
/// skipped (as the top-level item they are an error). Every file is created
/// exclusively, so a name that clashes inside a tree (`Report` and `report`
/// from a case-sensitive volume onto a case-insensitive one) is an error.
/// If copying fails midway, what the copy created is removed, one entry at a
/// time, so anything else that appeared there meanwhile stays.
///
/// A directory cannot be copied into itself or into one of its descendants.
pub fn copy_into(from: &Path, to_dir: &Path) -> Result<String, String> {
    let cancel = AtomicBool::new(false);
    copy_into_with_progress(from, to_dir, &cancel, &mut |_| {}).map_err(CopyError::into_string)
}

/// Like [`copy_into`], reporting throttled progress and checking `cancel`
/// between chunks and entries (rolling back created entries if cancelled).
pub fn copy_into_with_progress(
    from: &Path,
    to_dir: &Path,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(CopyProgress),
) -> Result<String, CopyError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(CopyError::Cancelled);
    }
    let fail = |e: io::Error| {
        CopyError::Failed(format!("cannot copy {} to {}: {e}", from.display(), to_dir.display()))
    };
    let meta = fs::symlink_metadata(from).map_err(fail)?;
    let name = from
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CopyError::Failed(format!("cannot copy {}: no usable name", from.display())))?;
    if !fs::metadata(to_dir).map_err(fail)?.is_dir() {
        return Err(CopyError::Failed(format!("{} is not a directory", to_dir.display())));
    }
    let kind = Kind::of(&meta);
    if kind == Kind::Dir {
        let source = fs::canonicalize(from).map_err(fail)?;
        let target = fs::canonicalize(to_dir).map_err(fail)?;
        if target.starts_with(&source) {
            return Err(CopyError::Failed(format!("cannot copy {} into itself", from.display())));
        }
    }
    if kind == Kind::Special {
        return Err(CopyError::Failed(format!("cannot copy {}: not a file or directory", from.display())));
    }

    let (total_bytes, total_files) = match measure_local_source(from, cancel) {
        Some((b, f)) => (Some(b), Some(f)),
        None => return Err(CopyError::Cancelled),
    };
    let mut tracker = ProgressTracker::new(total_bytes, total_files, on_progress);
    tracker.start_file(name.to_string());

    // Claiming a free name creates the destination (an empty file, the
    // directory, or the link), so two copies never take the same name.
    let is_dir = kind == Kind::Dir;
    for attempt in 1.. {
        if cancel.load(Ordering::Relaxed) {
            return Err(CopyError::Cancelled);
        }
        let dest = to_dir.join(candidate_name(name, is_dir, attempt));
        let claimed = match claim(from, &dest, kind) {
            Ok(claimed) => claimed,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(fail(e)),
        };
        let mut created = Created::default();
        let result: Result<(), CopyIoError> = match claimed {
            Claimed::File(out) => {
                created.add_open_file(&dest, &out);
                copy_file(from, out, cancel, &mut tracker).map(|()| tracker.finish_file())
            }
            Claimed::Dir => {
                created.add_dir(&dest, meta.permissions());
                copy_dir_contents(from, &dest, &mut created, cancel, &mut tracker)
                    .and_then(|()| created.apply_dir_permissions().map_err(CopyIoError::Io))
            }
            Claimed::Link => {
                tracker.finish_file();
                Ok(())
            }
        };
        if let Err(err) = result {
            created.roll_back();
            return Err(match err {
                CopyIoError::Cancelled => CopyError::Cancelled,
                CopyIoError::Io(e) => fail(e),
            });
        }
        tracker.emit_now();
        return dest
            .to_str()
            .map(str::to_string)
            .ok_or_else(|| CopyError::Failed(format!("{} is not UTF-8", dest.display())));
    }
    unreachable!("the loop only ends by returning")
}

enum CopyIoError {
    Cancelled,
    Io(io::Error),
}

impl From<io::Error> for CopyIoError {
    fn from(e: io::Error) -> Self {
        CopyIoError::Io(e)
    }
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Kind {
    File,
    Dir,
    Symlink,
    Special,
}

impl Kind {
    fn of(meta: &fs::Metadata) -> Self {
        let t = meta.file_type();
        if t.is_symlink() {
            Kind::Symlink
        } else if t.is_dir() {
            Kind::Dir
        } else if t.is_file() {
            Kind::File
        } else {
            Kind::Special
        }
    }
}

/// What [`claim`] created.
enum Claimed {
    /// An empty file, open for writing.
    File(fs::File),
    Dir,
    Link,
}

/// Creates the destination for `from` at `dest`, failing with
/// `AlreadyExists` if anything is there: an empty file (filled in
/// afterwards through the returned handle), an empty directory, or the
/// finished symlink.
fn claim(from: &Path, dest: &Path, kind: Kind) -> io::Result<Claimed> {
    match kind {
        Kind::File => create_new(dest).map(Claimed::File),
        Kind::Dir => fs::create_dir(dest).map(|()| Claimed::Dir),
        Kind::Symlink => symlink(&fs::read_link(from)?, dest).map(|()| Claimed::Link),
        Kind::Special => unreachable!("rejected earlier"),
    }
}

/// Creates a file that must not exist yet, open for writing.
fn create_new(path: &Path) -> io::Result<fs::File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

/// Copies the contents of `from` and its permissions through `out`, a file
/// this copy just created, so nothing is reopened by name.
fn copy_file(
    from: &Path,
    mut out: fs::File,
    cancel: &AtomicBool,
    tracker: &mut ProgressTracker<'_>,
) -> Result<(), CopyIoError> {
    let mut src = fs::File::open(from)?;
    let meta = src.metadata()?;
    if !meta.is_file() {
        return Err(CopyIoError::Io(io::Error::other("not a regular file")));
    }
    let mut buf = vec![0u8; COPY_CHUNK_SIZE];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CopyIoError::Cancelled);
        }
        let n = src.read(&mut buf)?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
        tracker.add_bytes(n as u64);
    }
    out.set_permissions(meta.permissions())?;
    Ok(())
}

#[cfg(unix)]
fn entry_identity(meta: &fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn entry_identity(_meta: &fs::Metadata) -> Option<(u64, u64)> {
    None
}

/// Everything a copy has created, so a failed or cancelled copy removes
/// exactly what it created (verified by `(dev, ino)` on Unix) and never
/// deletes a replacement somebody else put at the same path meanwhile.
#[derive(Default)]
struct Created {
    /// In creation order; `(path, is_dir, expected_identity)`.
    entries: Vec<(PathBuf, bool, Option<(u64, u64)>)>,
    /// Directory permissions, applied once everything is copied (a read-only
    /// directory could not be filled, or rolled back, otherwise).
    dir_permissions: Vec<(PathBuf, fs::Permissions)>,
}

impl Created {
    fn add_open_file(&mut self, path: &Path, file: &fs::File) {
        let id = file.metadata().ok().and_then(|m| entry_identity(&m));
        self.entries.push((path.to_path_buf(), false, id));
    }

    fn add_file(&mut self, path: &Path) {
        let id = fs::symlink_metadata(path).ok().and_then(|m| entry_identity(&m));
        self.entries.push((path.to_path_buf(), false, id));
    }

    fn add_dir(&mut self, path: &Path, permissions: fs::Permissions) {
        let id = fs::symlink_metadata(path).ok().and_then(|m| entry_identity(&m));
        self.entries.push((path.to_path_buf(), true, id));
        self.dir_permissions.push((path.to_path_buf(), permissions));
    }

    /// Children before their parents.
    fn apply_dir_permissions(&self) -> io::Result<()> {
        for (path, permissions) in self.dir_permissions.iter().rev() {
            fs::set_permissions(path, permissions.clone())?;
        }
        Ok(())
    }

    /// Removes the entries newest first, verifying `(dev, ino)` matches what
    /// this copy created so a concurrent replacement is never deleted.
    fn roll_back(&self) {
        for (path, is_dir, expected_id) in self.entries.iter().rev() {
            if let Some(expected) = expected_id {
                let Ok(meta) = fs::symlink_metadata(path) else {
                    continue;
                };
                if entry_identity(&meta) != Some(*expected) {
                    continue;
                }
            }
            let _ = if *is_dir { fs::remove_dir(path) } else { fs::remove_file(path) };
        }
    }
}

#[cfg(unix)]
fn symlink(target: &Path, dest: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, dest)
}

#[cfg(not(unix))]
fn symlink(_target: &Path, _dest: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "copying symlinks is not supported here"))
}

/// Copies what is inside `from` into the existing directory `dest`. Every
/// file and directory is created exclusively and recorded in `created`: a
/// name already taken (two source names that are one on this volume, say)
/// is an error, never an overwrite.
fn copy_dir_contents(
    from: &Path,
    dest: &Path,
    created: &mut Created,
    cancel: &AtomicBool,
    tracker: &mut ProgressTracker<'_>,
) -> Result<(), CopyIoError> {
    for entry in fs::read_dir(from)? {
        if cancel.load(Ordering::Relaxed) {
            return Err(CopyIoError::Cancelled);
        }
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        let target = dest.join(&file_name);
        let meta = fs::symlink_metadata(&path)?;
        match Kind::of(&meta) {
            Kind::File => {
                tracker.start_file(file_name.to_string_lossy().into_owned());
                let out = create_new(&target)?;
                created.add_open_file(&target, &out);
                copy_file(&path, out, cancel, tracker)?;
                tracker.finish_file();
            }
            Kind::Dir => {
                fs::create_dir(&target)?;
                created.add_dir(&target, meta.permissions());
                copy_dir_contents(&path, &target, created, cancel, tracker)?;
            }
            Kind::Symlink => {
                tracker.start_file(file_name.to_string_lossy().into_owned());
                symlink(&fs::read_link(&path)?, &target)?;
                created.add_file(&target);
                tracker.finish_file();
            }
            Kind::Special => {}
        }
    }
    Ok(())
}

/// The name for the `attempt`th try (1 is the original name): "a.txt",
/// "a copy.txt", "a copy 2.txt", ... The extension is the part after the
/// last dot, unless the dot starts the name (".env copy") or the item is a
/// directory.
fn candidate_name(name: &str, is_dir: bool, attempt: u32) -> String {
    if attempt == 1 {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !is_dir && i + 1 < name.len() => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    if attempt == 2 {
        format!("{stem} copy{ext}")
    } else {
        format!("{stem} copy {}{ext}", attempt - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn names(dir: &Path) -> Vec<String> {
        let mut out: Vec<String> =
            fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        out.sort();
        out
    }

    #[test]
    fn copies_a_file_keeping_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("f.txt"), "hello").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(a.join("f.txt"), fs::Permissions::from_mode(0o750)).unwrap();
        }
        let copy = copy_into(&a.join("f.txt"), &b).unwrap();
        assert_eq!(PathBuf::from(&copy), b.join("f.txt"));
        assert_eq!(fs::read_to_string(&copy).unwrap(), "hello");
        assert!(a.join("f.txt").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&copy).unwrap().permissions().mode() & 0o777, 0o750);
        }
    }

    #[test]
    fn copies_a_nested_directory() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("proj");
        fs::create_dir_all(src.join("sub/deep")).unwrap();
        fs::create_dir_all(src.join("empty")).unwrap();
        fs::write(src.join("a.txt"), "a").unwrap();
        fs::write(src.join("sub/deep/b.txt"), "b").unwrap();
        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();

        let copy = PathBuf::from(copy_into(&src, &dest).unwrap());
        assert_eq!(copy, dest.join("proj"));
        assert_eq!(fs::read_to_string(copy.join("a.txt")).unwrap(), "a");
        assert_eq!(fs::read_to_string(copy.join("sub/deep/b.txt")).unwrap(), "b");
        assert!(copy.join("empty").is_dir());
        assert!(src.join("sub/deep/b.txt").exists());
    }

    #[test]
    fn names_clashing_copies_like_finder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), "1").unwrap();
        fs::write(root.join("Makefile"), "2").unwrap();
        fs::write(root.join(".env"), "3").unwrap();
        fs::create_dir(root.join("dir.d")).unwrap();

        assert_eq!(copy_into(&root.join("a.txt"), root).unwrap(), root.join("a copy.txt").to_str().unwrap());
        assert_eq!(copy_into(&root.join("a.txt"), root).unwrap(), root.join("a copy 2.txt").to_str().unwrap());
        // Copying a copy: its own name gets the suffix.
        assert_eq!(copy_into(&root.join("a copy.txt"), root).unwrap(), root.join("a copy copy.txt").to_str().unwrap());
        assert_eq!(copy_into(&root.join("Makefile"), root).unwrap(), root.join("Makefile copy").to_str().unwrap());
        assert_eq!(copy_into(&root.join(".env"), root).unwrap(), root.join(".env copy").to_str().unwrap());
        assert_eq!(copy_into(&root.join(".env"), root).unwrap(), root.join(".env copy 2").to_str().unwrap());
        assert_eq!(copy_into(&root.join("dir.d"), root).unwrap(), root.join("dir.d copy").to_str().unwrap());
        assert_eq!(copy_into(&root.join("dir.d"), root).unwrap(), root.join("dir.d copy 2").to_str().unwrap());
        assert_eq!(fs::read_to_string(root.join("a copy 2.txt")).unwrap(), "1");
    }

    #[test]
    fn candidate_names() {
        assert_eq!(candidate_name("a.tar.gz", false, 2), "a.tar copy.gz");
        assert_eq!(candidate_name("a.", false, 2), "a. copy");
        assert_eq!(candidate_name("a.txt", false, 4), "a copy 3.txt");
        assert_eq!(candidate_name("v1.2", true, 3), "v1.2 copy 2");
    }

    #[test]
    fn rejects_copying_a_directory_into_itself() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(src.join("inner")).unwrap();
        fs::write(src.join("f"), "x").unwrap();
        assert!(copy_into(&src, &src).is_err());
        assert!(copy_into(&src, &src.join("inner")).is_err());
        // A sibling whose name merely starts the same is fine.
        let other = dir.path().join("src2");
        fs::create_dir(&other).unwrap();
        assert!(copy_into(&src, &other).is_ok());
        // Copying into the parent makes "src copy".
        let copy = copy_into(&src, dir.path()).unwrap();
        assert_eq!(PathBuf::from(copy), dir.path().join("src copy"));
        assert_eq!(names(&src), vec!["f", "inner"]);
    }

    #[test]
    fn rejects_bad_arguments() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f"), "").unwrap();
        assert!(copy_into(&dir.path().join("missing"), dir.path()).is_err());
        assert!(copy_into(&dir.path().join("f"), &dir.path().join("f")).is_err());
        assert!(copy_into(&dir.path().join("f"), &dir.path().join("nodir")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn copies_symlinks_as_links() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let src = root.join("src");
        fs::create_dir_all(src.join("real")).unwrap();
        fs::write(src.join("real/f"), "x").unwrap();
        std::os::unix::fs::symlink("real", src.join("dirlink")).unwrap();
        std::os::unix::fs::symlink("missing", src.join("broken")).unwrap();
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();

        let copy = PathBuf::from(copy_into(&src, &dest).unwrap());
        for link in ["dirlink", "broken"] {
            assert!(fs::symlink_metadata(copy.join(link)).unwrap().file_type().is_symlink());
        }
        assert_eq!(fs::read_link(copy.join("dirlink")).unwrap(), Path::new("real"));
        assert_eq!(fs::read_link(copy.join("broken")).unwrap(), Path::new("missing"));

        // A link at the top level is copied as a link too, even a dangling one.
        let top = PathBuf::from(copy_into(&src.join("dirlink"), &dest).unwrap());
        assert!(fs::symlink_metadata(&top).unwrap().file_type().is_symlink());
        let top = PathBuf::from(copy_into(&src.join("broken"), &dest).unwrap());
        assert_eq!(fs::read_link(top).unwrap(), Path::new("missing"));
    }

    #[test]
    fn a_clash_inside_a_tree_is_an_error_and_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a"), "a").unwrap();
        fs::write(src.join("clash"), "from source").unwrap();
        fs::write(src.join("sub/x"), "x").unwrap();
        let target = dir.path().join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("clash"), "foreign").unwrap();

        let mut created = Created::default();
        let cancel = AtomicBool::new(false);
        let mut noop = |_| {};
        let mut tracker = ProgressTracker::new(None, None, &mut noop);
        let err = match copy_dir_contents(&src, &target, &mut created, &cancel, &mut tracker).unwrap_err() {
            CopyIoError::Io(e) => e,
            CopyIoError::Cancelled => panic!("unexpected cancel"),
        };
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(target.join("clash")).unwrap(), "foreign");
        assert!(!created.entries.iter().any(|(p, _, _)| p == &target.join("clash")));
        created.roll_back();
        assert_eq!(names(&target), vec!["clash"]);
        assert_eq!(fs::read_to_string(target.join("clash")).unwrap(), "foreign");
    }

    #[test]
    fn rolling_back_leaves_foreign_files_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let (made, sub) = (dir.path().join("made"), dir.path().join("made/sub"));
        fs::create_dir_all(&sub).unwrap();
        fs::write(made.join("a"), "a").unwrap();
        fs::write(sub.join("b"), "b").unwrap();
        fs::write(sub.join("foreign"), "keep").unwrap();
        let mut created = Created::default();
        created.add_dir(&made, fs::metadata(&made).unwrap().permissions());
        created.add_file(&made.join("a"));
        created.add_dir(&sub, fs::metadata(&sub).unwrap().permissions());
        created.add_file(&sub.join("b"));
        created.roll_back();
        assert_eq!(names(&made), vec!["sub"]);
        assert_eq!(names(&sub), vec!["foreign"]);
        assert_eq!(fs::read_to_string(sub.join("foreign")).unwrap(), "keep");
    }

    #[cfg(unix)]
    #[test]
    fn removes_a_partial_copy_on_failure() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a"), "a").unwrap();
        fs::write(src.join("unreadable"), "b").unwrap();
        fs::set_permissions(src.join("unreadable"), fs::Permissions::from_mode(0o000)).unwrap();
        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();

        let result = copy_into(&src, &dest);
        fs::set_permissions(src.join("unreadable"), fs::Permissions::from_mode(0o644)).unwrap();
        // Running as root, the file is readable and the copy succeeds.
        if result.is_err() {
            assert!(names(&dest).is_empty(), "partial copy left behind: {:?}", names(&dest));
        }
    }

    #[test]
    fn reports_progress_and_rolls_back_on_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("bundle");
        fs::create_dir_all(&src).unwrap();
        let payload = vec![b'x'; COPY_CHUNK_SIZE * 2 + 123];
        fs::write(src.join("a.bin"), &payload).unwrap();
        fs::write(src.join("b.bin"), &payload).unwrap();
        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();

        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();
        let out = copy_into_with_progress(&src, &dest, &cancel, &mut |p| events.push(p)).unwrap();
        assert_eq!(PathBuf::from(&out), dest.join("bundle"));
        let last = events.last().unwrap();
        assert_eq!(last.total_bytes, Some((payload.len() * 2) as u64));
        assert_eq!(last.bytes_transferred, (payload.len() * 2) as u64);
        assert_eq!(last.total_files, Some(2));
        assert_eq!(last.files_completed, 2);

        // Cancelling mid-transfer rolls back everything created by that copy.
        let dest2 = dir.path().join("dest2");
        fs::create_dir(&dest2).unwrap();
        let cancel2 = AtomicBool::new(false);
        let err = copy_into_with_progress(&src, &dest2, &cancel2, &mut |p| {
            if p.bytes_transferred == 0 {
                // Ensure the next chunk passes the 50 ms progress throttle.
                std::thread::sleep(PROGRESS_INTERVAL + Duration::from_millis(5));
            } else {
                cancel2.store(true, Ordering::Relaxed);
            }
        })
        .unwrap_err();
        assert_eq!(err, CopyError::Cancelled);
        assert!(names(&dest2).is_empty(), "cancelled copy left files behind: {:?}", names(&dest2));
    }

    #[cfg(unix)]
    #[test]
    fn rollback_does_not_delete_a_replaced_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("item.txt");
        fs::write(&path, "original").unwrap();
        let mut created = Created::default();
        created.add_file(&path);
        // Replace with a distinct inode via atomic rename.
        let replacement = dir.path().join("replacement.txt");
        fs::write(&replacement, "foreign").unwrap();
        fs::rename(&replacement, &path).unwrap();
        created.roll_back();
        assert_eq!(fs::read_to_string(&path).unwrap(), "foreign");
    }
}
