//! Reading and writing whole files for the editor and viewer panes.
//!
//! * [`read_text`] reads a file as UTF-8 text, refusing binary and very
//!   large files.
//! * [`write_text`] replaces a file atomically (temp file + rename), keeping
//!   its permissions and writing through symlinks, and refuses to overwrite
//!   a file that changed since the caller read it.
//! * [`read_bytes`] reads a file's raw bytes (images for the viewer).
//! * [`version`] is what change detection compares: modification time and
//!   size.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

/// Text files larger than this are not opened (bytes).
pub const TEXT_LIMIT: u64 = 16 * 1024 * 1024;
/// Files larger than this are not read as bytes.
pub const BYTES_LIMIT: u64 = 64 * 1024 * 1024;
/// A NUL byte within this many leading bytes marks a file as binary (git's
/// heuristic).
const BINARY_SNIFF: usize = 8000;

/// What change detection compares, as `FileVersion` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileVersion {
    /// Modification time in nanoseconds since the Unix epoch, as a decimal
    /// string: exact through JSON, where a number would lose precision.
    pub mtime: String,
    pub size: u64,
}

impl FileVersion {
    fn of(meta: &fs::Metadata) -> Self {
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos());
        Self {
            mtime: mtime.to_string(),
            size: meta.len(),
        }
    }
}

/// Saves are serialized, so two saves of one file (open in two panes)
/// cannot both pass the version check before either replaces the file.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Result of [`read_text`], as `TextFile` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TextFile {
    Text {
        text: String,
        version: FileVersion,
    },
    /// Has a NUL byte near the start, or is not valid UTF-8.
    Binary {
        version: FileVersion,
    },
    /// Larger than the limit.
    TooLarge {
        version: FileVersion,
    },
}

/// Result of [`write_text`], as `WriteResult` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WriteResult {
    Written {
        version: FileVersion,
    },
    /// The file is not the version the caller expected (`current` is `None`
    /// if it is gone). Nothing was written.
    Conflict {
        current: Option<FileVersion>,
    },
}

/// `path`'s version, or `None` if there is no file there (nothing, or a
/// directory). Symlinks are followed.
pub fn version(path: &Path) -> Result<Option<FileVersion>, String> {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => Ok(Some(FileVersion::of(&meta))),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Reads `path` as text, unless it is larger than `limit` bytes or binary.
pub fn read_text(path: &Path, limit: u64) -> Result<TextFile, String> {
    let fail = |e: io::Error| format!("cannot read {}: {e}", path.display());
    let (bytes, version) = match read_limited(path, limit).map_err(fail)? {
        Limited::Read(bytes, version) => (bytes, version),
        Limited::TooLarge(version) => return Ok(TextFile::TooLarge { version }),
    };
    if bytes.iter().take(BINARY_SNIFF).any(|&b| b == 0) {
        return Ok(TextFile::Binary { version });
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(TextFile::Text { text, version }),
        Err(_) => Ok(TextFile::Binary { version }),
    }
}

/// Reads `path`'s bytes. Fails if it is larger than `limit`.
pub fn read_bytes(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let fail = |e: io::Error| format!("cannot read {}: {e}", path.display());
    match read_limited(path, limit).map_err(fail)? {
        Limited::Read(bytes, _) => Ok(bytes),
        Limited::TooLarge(v) => Err(format!(
            "{} is too large to show ({} bytes)",
            path.display(),
            v.size
        )),
    }
}

enum Limited {
    Read(Vec<u8>, FileVersion),
    TooLarge(FileVersion),
}

fn read_limited(path: &Path, limit: u64) -> io::Result<Limited> {
    if !fs::metadata(path)?.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    let mut file = open_nonblocking(path)?;
    // Checked again on the handle: the path may have changed since.
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    let version = FileVersion::of(&meta);
    if meta.len() > limit {
        return Ok(Limited::TooLarge(version));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // A file that grew past the limit since the stat is cut off there and
    // reported as too large.
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Ok(Limited::TooLarge(version));
    }
    Ok(Limited::Read(bytes, version))
}

/// Opens a file for reading without blocking on a FIFO or device (the
/// caller checks that it is a regular file).
fn open_nonblocking(path: &Path) -> io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    options.open(path)
}

/// What a save expects to find on disk, as `WriteExpect` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WriteExpect {
    /// The file, still at this version.
    Version { version: FileVersion },
    /// No file: it is being created (or recreated after it was deleted).
    Absent,
    /// Anything: overwrite or create.
    Any,
}

/// Writes `text` to `path` if what is there matches `expect`; otherwise
/// nothing is written and the current version is returned as a conflict.
/// Missing files are created (their directory must exist).
///
/// The write is atomic where possible: a temp file in the same directory is
/// written, synced, given the old file's permissions (a new file gets 0666
/// less the umask) and renamed over the file, so a crash never leaves a
/// half-written file. A symlink is written through (its target is replaced,
/// or created if missing; the link stays). If the directory is not
/// writable, the file is overwritten in place. Replacing the file breaks
/// hard links and drops extended attributes.
///
/// Saves are serialized with each other, but a change by another program
/// between the check and the rename is overwritten.
pub fn write_text(path: &Path, text: &str, expect: &WriteExpect) -> Result<WriteResult, String> {
    let fail = |e: io::Error| format!("cannot save {}: {e}", path.display());
    let _guard = WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let current = version(path)?;
    let matches = match expect {
        WriteExpect::Version { version } => current.as_ref() == Some(version),
        WriteExpect::Absent => current.is_none(),
        WriteExpect::Any => true,
    };
    if !matches {
        return Ok(WriteResult::Conflict { current });
    }

    let target = resolve_symlinks(path).map_err(fail)?;
    let permissions = fs::metadata(&target).ok().map(|m| m.permissions());
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));

    let mut builder = tempfile::Builder::new();
    builder.prefix(".midterm-save-").suffix(".tmp");
    #[cfg(unix)]
    if permissions.is_none() {
        // Created with this mode, so the umask applies, as for any new file.
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    match builder.tempfile_in(dir) {
        Ok(mut tmp) => {
            tmp.write_all(text.as_bytes()).map_err(fail)?;
            tmp.as_file().sync_all().map_err(fail)?;
            if let Some(permissions) = permissions {
                fs::set_permissions(tmp.path(), permissions).map_err(fail)?;
            }
            tmp.persist(&target).map_err(|e| fail(e.error))?;
        }
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
            // e.g. a writable file in a read-only directory.
            fs::write(&target, text).map_err(fail)?;
        }
        Err(e) => return Err(fail(e)),
    }

    let version = version(&target)?.ok_or_else(|| fail(io::ErrorKind::NotFound.into()))?;
    Ok(WriteResult::Written { version })
}

/// The file `path` names: symlinks followed, even to a target that does not
/// exist (so saving through a dangling link creates its target).
fn resolve_symlinks(path: &Path) -> io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(resolved) => return Ok(resolved),
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        Err(_) => {}
    }
    let mut current = path.to_path_buf();
    for _ in 0..40 {
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let target = fs::read_link(&current)?;
                current = match current.parent() {
                    Some(parent) if target.is_relative() => parent.join(target),
                    _ => target,
                };
            }
            _ => return Ok(current),
        }
    }
    Err(io::Error::other("too many levels of symbolic links"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{read_to_string, write};

    fn written(result: WriteResult) -> FileVersion {
        match result {
            WriteResult::Written { version } => version,
            other => panic!("expected a write, got {other:?}"),
        }
    }

    #[test]
    fn reads_text_with_its_version() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("a.txt");
        write(&path, "héllo\n").unwrap();
        let TextFile::Text { text, version: v } = read_text(&path, TEXT_LIMIT).unwrap() else {
            panic!("not text");
        };
        assert_eq!(text, "héllo\n");
        assert_eq!(v.size, 7);
        assert_eq!(Some(v), version(&path).unwrap());
    }

    #[test]
    fn refuses_binary_and_large_files() {
        let tmp = tempfile::tempdir().unwrap();
        let nul = tmp.path().join("nul");
        write(&nul, b"abc\0def").unwrap();
        assert!(matches!(
            read_text(&nul, TEXT_LIMIT).unwrap(),
            TextFile::Binary { .. }
        ));
        let latin1 = tmp.path().join("latin1");
        write(&latin1, b"caf\xe9").unwrap();
        assert!(matches!(
            read_text(&latin1, TEXT_LIMIT).unwrap(),
            TextFile::Binary { .. }
        ));
        let big = tmp.path().join("big");
        write(&big, "0123456789").unwrap();
        assert!(matches!(
            read_text(&big, 9).unwrap(),
            TextFile::TooLarge { .. }
        ));
        assert!(matches!(
            read_text(&big, 10).unwrap(),
            TextFile::Text { .. }
        ));
        assert!(read_bytes(&big, 9).is_err());
        assert_eq!(read_bytes(&big, 10).unwrap(), b"0123456789");
    }

    #[test]
    fn reading_a_missing_file_or_a_directory_fails() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_text(&tmp.path().join("missing"), TEXT_LIMIT).is_err());
        assert!(read_text(tmp.path(), TEXT_LIMIT).is_err());
        assert_eq!(version(tmp.path()).unwrap(), None);
        assert_eq!(version(&tmp.path().join("missing")).unwrap(), None);
    }

    #[test]
    fn writes_new_and_existing_files_and_leaves_no_temp_files() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("new.txt");
        let v1 = written(write_text(&path, "one", &WriteExpect::Absent).unwrap());
        assert_eq!(read_to_string(&path).unwrap(), "one");
        assert_eq!(Some(v1.clone()), version(&path).unwrap());
        let expect = WriteExpect::Version { version: v1 };
        let v2 = written(write_text(&path, "two!", &expect).unwrap());
        assert_eq!(read_to_string(&path).unwrap(), "two!");
        assert_eq!(v2.size, 4);
        let names: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec!["new.txt"]);
    }

    #[test]
    fn refuses_to_overwrite_a_changed_or_deleted_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("a.txt");
        write(&path, "mine").unwrap();
        let v = version(&path).unwrap().unwrap();
        let stale = FileVersion {
            mtime: "1".into(),
            ..v
        };
        let expect = WriteExpect::Version { version: stale };
        let result = write_text(&path, "lost", &expect).unwrap();
        assert_eq!(
            result,
            WriteResult::Conflict {
                current: version(&path).unwrap()
            }
        );
        assert_eq!(read_to_string(&path).unwrap(), "mine");

        // Creating refuses to replace a file that appeared meanwhile.
        let result = write_text(&path, "lost", &WriteExpect::Absent).unwrap();
        assert_eq!(
            result,
            WriteResult::Conflict {
                current: version(&path).unwrap()
            }
        );
        assert_eq!(read_to_string(&path).unwrap(), "mine");

        let v = version(&path).unwrap().unwrap();
        fs::remove_file(&path).unwrap();
        let expect = WriteExpect::Version { version: v };
        let result = write_text(&path, "lost", &expect).unwrap();
        assert_eq!(result, WriteResult::Conflict { current: None });
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn reading_a_fifo_fails_instead_of_blocking() {
        let tmp = tempfile::tempdir().unwrap();
        let fifo = tmp.path().join("fifo");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert!(read_text(&fifo, TEXT_LIMIT).is_err());
        assert!(read_bytes(&fifo, BYTES_LIMIT).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn keeps_permissions_and_writes_through_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("script.sh");
        write(&target, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        let link = tmp.path().join("link.sh");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        written(write_text(&link, "#!/bin/sh\necho hi\n", &WriteExpect::Any).unwrap());
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(read_to_string(&target).unwrap(), "#!/bin/sh\necho hi\n");
        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);

        // A dangling link: saving creates its target and keeps the link.
        fs::remove_file(&target).unwrap();
        written(write_text(&link, "new", &WriteExpect::Absent).unwrap());
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(read_to_string(&target).unwrap(), "new");

        // New files get 0666 less the umask, not the temp file's 0600.
        let fresh = tmp.path().join("fresh.txt");
        written(write_text(&fresh, "x", &WriteExpect::Absent).unwrap());
        let mode = fs::metadata(&fresh).unwrap().permissions().mode() & 0o777;
        // SAFETY: umask only swaps the process mask; it is set straight back.
        let umask = unsafe {
            let old = libc::umask(0o022);
            libc::umask(old);
            old
        } as u32;
        assert_eq!(mode, 0o666 & !umask);
    }
}
