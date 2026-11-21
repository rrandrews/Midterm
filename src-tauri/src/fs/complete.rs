//! Listings for tab completion in the blocks input editor: the executables
//! on a `PATH`, and a directory's entries with their executable bit.
//!
//! Unlike [`super::list`] there are no ignore rules here: a shell completes
//! every name, and the frontend decides which dotfiles to offer.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

/// One entry of [`list_entries`], as `CompletionEntry` in `src/ipc/complete.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionEntry {
    pub name: String,
    /// A directory, or a symlink to one.
    pub dir: bool,
    /// A file (or a symlink to one) with an execute bit set.
    pub executable: bool,
}

/// How long a `PATH` directory's listing is reused when its modification
/// time has not changed (that catches added and removed programs; the TTL
/// catches a `chmod +x`).
const CACHE_TTL: Duration = Duration::from_secs(30);

struct Cached {
    mtime: Option<SystemTime>,
    at: Instant,
    names: Vec<String>,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether `path` (followed if a symlink) is a file anyone may execute.
fn is_executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The executable files directly in `dir`. Unreadable directories give
/// nothing; names that are not UTF-8 are left out.
fn executables_in(dir: &Path) -> Vec<String> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    read.filter_map(Result::ok)
        .filter_map(|item| {
            let name = item.file_name().into_string().ok()?;
            is_executable(&item.path()).then_some(name)
        })
        .collect()
}

/// [`executables_in`], cached per directory (see [`CACHE_TTL`]).
fn cached_executables(dir: &Path) -> Vec<String> {
    let mtime = fs::metadata(dir).and_then(|m| m.modified()).ok();
    if let Some(hit) = cache().lock().unwrap().get(dir)
        && hit.mtime == mtime
        && hit.at.elapsed() < CACHE_TTL
    {
        return hit.names.clone();
    }
    let names = executables_in(dir);
    cache().lock().unwrap().insert(
        dir.to_path_buf(),
        Cached {
            mtime,
            at: Instant::now(),
            names: names.clone(),
        },
    );
    names
}

/// The names of the executables on `path_var` (a `:`-separated `PATH`),
/// sorted and without duplicates. Empty and relative entries are skipped
/// (they depend on the shell's directory), as are unreadable directories.
pub fn path_commands(path_var: &str) -> Vec<String> {
    let mut seen_dirs = BTreeSet::new();
    let mut names = BTreeSet::new();
    for dir in path_var.split(':') {
        if !dir.starts_with('/') || !seen_dirs.insert(dir) {
            continue;
        }
        names.extend(cached_executables(Path::new(dir)));
    }
    names.into_iter().collect()
}

/// Every entry of `dir` (dotfiles too), sorted by name. Fails if `dir` is
/// not a readable directory.
pub fn list_entries(dir: &Path) -> Result<Vec<CompletionEntry>, String> {
    let read = fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    let mut entries: Vec<CompletionEntry> = read
        .filter_map(Result::ok)
        .filter_map(|item| {
            let name = item.file_name().into_string().ok()?;
            let path = item.path();
            // Followed: a symlink counts as what it points to.
            let meta = fs::metadata(&path).ok();
            let dir = meta.as_ref().is_some_and(fs::Metadata::is_dir);
            let executable = meta
                .as_ref()
                .is_some_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
            Some(CompletionEntry {
                name,
                dir,
                executable,
            })
        })
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir, set_permissions, write};
    use std::os::unix::fs::symlink;

    fn make_exec(path: &Path) {
        write(path, "#!/bin/sh\n").unwrap();
        set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn path_commands_lists_executables_once_and_skips_the_rest() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        make_exec(&a.path().join("tool"));
        make_exec(&b.path().join("tool"));
        make_exec(&b.path().join("other"));
        write(a.path().join("plain"), "").unwrap();
        create_dir(a.path().join("subdir")).unwrap();
        symlink(a.path().join("tool"), b.path().join("linked")).unwrap();
        symlink(a.path().join("missing"), b.path().join("broken")).unwrap();
        let path_var = format!(
            "{}::relative:{}:/does/not/exist:{}",
            a.path().display(),
            b.path().display(),
            a.path().display()
        );
        assert_eq!(path_commands(&path_var), ["linked", "other", "tool"]);
    }

    #[test]
    fn path_commands_sees_new_programs() {
        let a = tempfile::tempdir().unwrap();
        let path_var = a.path().to_str().unwrap().to_owned();
        make_exec(&a.path().join("one"));
        assert_eq!(path_commands(&path_var), ["one"]);
        // A new entry changes the directory's mtime; make sure it differs
        // even on file systems with a coarse clock.
        std::thread::sleep(Duration::from_millis(20));
        make_exec(&a.path().join("two"));
        let dir_time = fs::metadata(a.path()).unwrap().modified().unwrap();
        let cached = cache().lock().unwrap().get(a.path()).unwrap().mtime;
        if cached != Some(dir_time) {
            assert_eq!(path_commands(&path_var), ["one", "two"]);
        }
    }

    #[test]
    fn list_entries_flags_dirs_and_executables() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        create_dir(d.join("sub")).unwrap();
        make_exec(&d.join("run.sh"));
        write(d.join(".hidden"), "").unwrap();
        write(d.join("notes.txt"), "").unwrap();
        symlink(d.join("sub"), d.join("link")).unwrap();
        let entries = list_entries(d).unwrap();
        let summary: Vec<(&str, bool, bool)> = entries
            .iter()
            .map(|e| (e.name.as_str(), e.dir, e.executable))
            .collect();
        assert_eq!(
            summary,
            [
                (".hidden", false, false),
                ("link", true, false),
                ("notes.txt", false, false),
                ("run.sh", false, true),
                ("sub", true, false),
            ]
        );
        assert!(list_entries(&d.join("nope")).is_err());
    }
}
