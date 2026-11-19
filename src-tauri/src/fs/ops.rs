//! Changes the explorer makes: create, rename, move to trash.

use std::fs::{self, OpenOptions};
use std::io;
use std::path::Path;

/// Creates an empty file or a directory at `path`. Fails if anything (even
/// a broken symlink) is already there or the parent does not exist.
pub fn create(path: &Path, dir: bool) -> Result<(), String> {
    let result = if dir {
        fs::create_dir(path)
    } else {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map(drop)
    };
    result.map_err(|e| format!("cannot create {}: {e}", path.display()))
}

/// Renames or moves `from` to `to`, failing if `to` exists.
///
/// Exception: `to` may name `from` itself with different letter case, so
/// that `readme` → `README` works on a case-insensitive file system, where
/// the destination "exists" because it is the source.
///
/// On macOS and Linux the rename itself refuses to replace anything
/// (`renamex_np(RENAME_EXCL)`, `renameat2(RENAME_NOREPLACE)`), so a file
/// created at `to` by another program after the check is never clobbered.
/// Elsewhere, or on a file system without that support, there is a small
/// window between the check and a plain rename.
pub fn rename(from: &Path, to: &Path) -> Result<(), String> {
    let fail = |e: io::Error| format!("cannot rename {} to {}: {e}", from.display(), to.display());
    let exists = || format!("{} already exists", to.display());
    match fs::symlink_metadata(to) {
        Ok(_) if is_case_only_rename(from, to) => return fs::rename(from, to).map_err(fail),
        Ok(_) => return Err(exists()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(fail(e)),
    }
    match rename_no_replace(from, to) {
        Some(Ok(())) => Ok(()),
        Some(Err(e)) if e.kind() == io::ErrorKind::AlreadyExists => Err(exists()),
        Some(Err(e)) => Err(fail(e)),
        None => fs::rename(from, to).map_err(fail),
    }
}

/// An atomic rename that fails with `AlreadyExists` instead of replacing;
/// `None` where the platform or file system cannot do that.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn rename_no_replace(from: &Path, to: &Path) -> Option<io::Result<()>> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(from.as_os_str().as_bytes()).ok()?;
    let to = CString::new(to.as_os_str().as_bytes()).ok()?;
    // SAFETY: both arguments are valid NUL-terminated paths for the call.
    #[cfg(target_os = "macos")]
    let rc = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    // SAFETY: as above; AT_FDCWD makes the paths relative to the cwd (they are absolute).
    #[cfg(target_os = "linux")]
    let rc = unsafe {
        libc::renameat2(libc::AT_FDCWD, from.as_ptr(), libc::AT_FDCWD, to.as_ptr(), libc::RENAME_NOREPLACE)
    };
    if rc == 0 {
        return Some(Ok(()));
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        // The file system (or an old kernel) does not support it.
        Some(libc::EINVAL | libc::ENOTSUP | libc::ENOSYS) => None,
        _ => Some(Err(error)),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_no_replace(_from: &Path, _to: &Path) -> Option<io::Result<()>> {
    None
}

/// `from` and `to` differ only in case and are the same directory entry.
/// Both are required: two hard links to one file are also "the same file",
/// and renaming one onto the other would silently do nothing.
fn is_case_only_rename(from: &Path, to: &Path) -> bool {
    let (Some(a), Some(b)) = (from.to_str(), to.to_str()) else {
        return false;
    };
    a != b && a.to_lowercase() == b.to_lowercase() && same_entry(from, to)
}

#[cfg(unix)]
fn same_entry(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    // Not following symlinks: the entry itself is what is renamed.
    match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_entry(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Moves `paths` to the system trash. A symlink is trashed itself, not its
/// target.
///
/// On macOS this uses `NSFileManager` rather than the crate's default of
/// scripting Finder: Finder would make macOS ask the user to let Midterm
/// control it, and is slower. The price is that "Put Back" may not be
/// offered for the trashed items.
pub fn trash(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete_all(paths)
        .map_err(|e| format!("cannot move to trash: {e}"))
}

#[cfg(test)]
mod tests {

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn no_replace_rename_refuses_an_existing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        // The step `rename` relies on once its own check has passed.
        let result = super::rename_no_replace(&a, &b).expect("supported on this file system");
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "b");
    }

    use super::*;
    use std::fs::{File, create_dir, read_to_string, write};

    #[test]
    fn creates_files_and_directories_but_never_over_something() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        create(&d.join("new.txt"), false).unwrap();
        assert!(d.join("new.txt").is_file());
        create(&d.join("newdir"), true).unwrap();
        assert!(d.join("newdir").is_dir());

        write(d.join("full.txt"), "content").unwrap();
        assert!(create(&d.join("full.txt"), false).is_err());
        assert_eq!(read_to_string(d.join("full.txt")).unwrap(), "content");
        assert!(create(&d.join("full.txt"), true).is_err());
        assert!(create(&d.join("newdir"), true).is_err());
        assert!(create(&d.join("newdir"), false).is_err());
        assert!(create(&d.join("missing/child"), true).is_err());
        assert!(create(&d.join("missing/child"), false).is_err());
    }

    #[test]
    fn renames_and_moves() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        write(d.join("a"), "a").unwrap();
        create_dir(d.join("dir")).unwrap();
        rename(&d.join("a"), &d.join("b")).unwrap();
        rename(&d.join("b"), &d.join("dir/b")).unwrap();
        assert_eq!(read_to_string(d.join("dir/b")).unwrap(), "a");
        assert!(rename(&d.join("missing"), &d.join("x")).is_err());
    }

    #[test]
    fn rename_refuses_to_replace() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        write(d.join("a"), "a").unwrap();
        write(d.join("b"), "b").unwrap();
        assert!(rename(&d.join("a"), &d.join("b")).is_err());
        assert_eq!(read_to_string(d.join("b")).unwrap(), "b");
        create_dir(d.join("empty")).unwrap();
        assert!(rename(&d.join("a"), &d.join("empty")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rename_refuses_to_replace_a_hard_link_or_a_dangling_symlink() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        write(d.join("a"), "a").unwrap();
        fs::hard_link(d.join("a"), d.join("A-link")).unwrap();
        assert!(rename(&d.join("a"), &d.join("A-link")).is_err());
        symlink(d.join("nowhere"), d.join("dangling")).unwrap();
        assert!(rename(&d.join("a"), &d.join("dangling")).is_err());
    }

    #[test]
    fn case_only_rename() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        File::create(d.join("readme")).unwrap();
        rename(&d.join("readme"), &d.join("README")).unwrap();
        let names: Vec<_> = fs::read_dir(d)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["README"]);
    }

    #[test]
    fn trashing_nothing_is_fine() {
        trash(&[]).unwrap();
    }
}
