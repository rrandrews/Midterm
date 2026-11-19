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
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FileVersion {
    /// Modification time, milliseconds since the Unix epoch (fractional).
    pub mtime: f64,
    pub size: u64,
}

impl FileVersion {
    fn of(meta: &fs::Metadata) -> Self {
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        Self {
            mtime,
            size: meta.len(),
        }
    }
}

/// Result of [`read_text`], as `TextFile` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
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
#[derive(Debug, Clone, PartialEq, Serialize)]
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
    let mut file = File::open(path)?;
    let meta = file.metadata()?;
    if meta.is_dir() {
        return Err(io::Error::other("is a directory"));
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

/// Writes `text` to `path`.
///
/// With `expected`, the file must still be that version (it must exist);
/// otherwise nothing is written and the current version is returned as a
/// conflict. Without it, the file is written whatever is there, and created
/// if missing (its directory must exist).
///
/// The write is atomic where possible: a temp file in the same directory is
/// written, synced, given the old file's permissions (new files get 0644 on Unix)
/// and renamed over the file, so a crash never leaves a half-written file.
/// A symlink is written through (its target is replaced, the link stays).
/// If the directory is not writable, the file is overwritten in place.
/// Replacing the file breaks hard links and drops extended attributes.
pub fn write_text(
    path: &Path,
    text: &str,
    expected: Option<FileVersion>,
) -> Result<WriteResult, String> {
    let fail = |e: io::Error| format!("cannot save {}: {e}", path.display());
    let current = version(path)?;
    if let Some(expected) = expected
        && current != Some(expected)
    {
        return Ok(WriteResult::Conflict { current });
    }

    let target = resolve_symlinks(path).map_err(fail)?;
    let permissions = fs::metadata(&target).ok().map(|m| m.permissions());
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));

    match tempfile::Builder::new()
        .prefix(".midterm-save-")
        .suffix(".tmp")
        .tempfile_in(dir)
    {
        Ok(mut tmp) => {
            tmp.write_all(text.as_bytes()).map_err(fail)?;
            tmp.as_file().sync_all().map_err(fail)?;
            if let Some(permissions) = permissions.or_else(default_permissions) {
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

/// `path` with symlinks resolved if it exists, else `path` itself.
fn resolve_symlinks(path: &Path) -> io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(resolved) => Ok(resolved),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(e) => Err(e),
    }
}

/// Permissions for a new file, if the temp file's own (0600 on Unix) will not do.
#[cfg(unix)]
fn default_permissions() -> Option<fs::Permissions> {
    use std::os::unix::fs::PermissionsExt;
    Some(fs::Permissions::from_mode(0o644))
}

#[cfg(not(unix))]
fn default_permissions() -> Option<fs::Permissions> {
    None
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
        assert_eq!(Some(v), version(&path).unwrap());
        assert_eq!(v.size, 7);
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
        let v1 = written(write_text(&path, "one", None).unwrap());
        assert_eq!(read_to_string(&path).unwrap(), "one");
        assert_eq!(Some(v1), version(&path).unwrap());
        let v2 = written(write_text(&path, "two!", Some(v1)).unwrap());
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
            mtime: v.mtime - 5000.0,
            ..v
        };
        let result = write_text(&path, "lost", Some(stale)).unwrap();
        assert_eq!(
            result,
            WriteResult::Conflict {
                current: version(&path).unwrap()
            }
        );
        assert_eq!(read_to_string(&path).unwrap(), "mine");

        let v = version(&path).unwrap().unwrap();
        fs::remove_file(&path).unwrap();
        let result = write_text(&path, "lost", Some(v)).unwrap();
        assert_eq!(result, WriteResult::Conflict { current: None });
        assert!(!path.exists());
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

        written(write_text(&link, "#!/bin/sh\necho hi\n", None).unwrap());
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(read_to_string(&target).unwrap(), "#!/bin/sh\necho hi\n");
        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);

        let fresh = tmp.path().join("fresh.txt");
        written(write_text(&fresh, "x", None).unwrap());
        assert_eq!(
            fs::metadata(&fresh).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }
}
