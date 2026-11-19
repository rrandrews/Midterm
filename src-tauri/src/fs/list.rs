//! Directory listings and single-path lookups for the explorer.

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::Path;

use ignore::WalkBuilder;
use serde::Serialize;

/// One directory entry, as `FsEntry` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    /// Absolute: the listed directory as given, joined with `name`.
    pub path: String,
    pub kind: EntryKind,
    pub symlink: bool,
    /// The name starts with a dot.
    pub hidden: bool,
    /// Excluded by ignore rules (or is `.git`). Only computed by [`list_dir`].
    pub ignored: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

/// The entries of `dir`, one level deep, directories first, then by name
/// (case-insensitive, ties broken by the exact name).
///
/// Ignore rules are those of the `ignore` crate (ripgrep's): `.gitignore`
/// files of `dir` and of its ancestors, `.git/info/exclude` and the global
/// git excludes file, but only inside a git repository (the crate's
/// `require_git` default), plus `.ignore` files anywhere. `.git` itself always
/// counts as ignored.
///
/// Without `show_hidden`, dotfiles and ignored entries are left out. With it,
/// everything is listed and flagged.
pub fn list_dir(dir: &Path, show_hidden: bool) -> Result<Vec<FsEntry>, String> {
    // `read_dir` is the source of truth for what exists, and gives a useful
    // error for a missing or unreadable directory. The walk below only
    // decides which of those entries the ignore rules keep.
    let read = fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    let kept = not_ignored(dir);

    let mut entries = Vec::new();
    for item in read {
        // An entry that vanished or cannot be read mid-listing is skipped
        // rather than failing the whole listing.
        let Ok(item) = item else { continue };
        let file_name = item.file_name();
        // A name that is not UTF-8 (possible on Linux, not on APFS) could
        // only be sent to the webview lossily, and the lossy path might name
        // a different file in later operations (rename, trash). Left out.
        let Some(name) = file_name.to_str().map(str::to_owned) else {
            continue;
        };
        let hidden = name.starts_with('.');
        let ignored = file_name == ".git" || !kept.contains(&file_name);
        if !show_hidden && (hidden || ignored) {
            continue;
        }
        let Ok(file_type) = item.file_type() else {
            continue;
        };
        let symlink = file_type.is_symlink();
        let is_dir = if symlink {
            // Reported as what it points to; a broken link is a file.
            fs::metadata(item.path()).is_ok_and(|m| m.is_dir())
        } else {
            file_type.is_dir()
        };
        entries.push(FsEntry {
            path: dir.join(&file_name).to_string_lossy().into_owned(),
            name,
            kind: if is_dir {
                EntryKind::Dir
            } else {
                EntryKind::File
            },
            symlink,
            hidden,
            ignored,
        });
    }
    sort_entries(&mut entries);
    Ok(entries)
}

/// Names of the entries of `dir` that the ignore rules keep.
fn not_ignored(dir: &Path) -> HashSet<OsString> {
    WalkBuilder::new(dir)
        .max_depth(Some(1))
        // Dotfiles are flagged separately, so the walk must not drop them.
        .hidden(false)
        .parents(true)
        .ignore(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .follow_links(false)
        .build()
        // Errors here are about individual ignore files or entries; the
        // walk still yields everything it could judge.
        .filter_map(Result::ok)
        .filter(|entry| entry.depth() == 1)
        .map(|entry| entry.file_name().to_owned())
        .collect()
}

fn sort_entries(entries: &mut [FsEntry]) {
    entries.sort_by_cached_key(|e| {
        (
            e.kind != EntryKind::Dir,
            e.name.to_lowercase(),
            e.name.clone(),
        )
    });
}

/// `path`'s entry, or `None` if nothing is there (a broken symlink is
/// there). `ignored` is always `false`: deciding it would mean evaluating the
/// ignore rules of every ancestor for one path, and callers that care get it
/// from the parent's listing.
pub fn stat(path: &Path) -> Result<Option<FsEntry>, String> {
    let link_meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot stat {}: {e}", path.display())),
    };
    let symlink = link_meta.file_type().is_symlink();
    let is_dir = if symlink {
        fs::metadata(path).is_ok_and(|m| m.is_dir())
    } else {
        link_meta.is_dir()
    };
    let name = match path.file_name() {
        Some(name) => name.to_string_lossy().into_owned(),
        // `/` (or a path ending in `..`) has no file name.
        None => path.to_string_lossy().into_owned(),
    };
    Ok(Some(FsEntry {
        hidden: name.starts_with('.'),
        path: path.to_string_lossy().into_owned(),
        name,
        kind: if is_dir {
            EntryKind::Dir
        } else {
            EntryKind::File
        },
        symlink,
        ignored: false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{File, create_dir, write};

    fn names(entries: &[FsEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.name.as_str()).collect()
    }

    fn find<'a>(entries: &'a [FsEntry], name: &str) -> &'a FsEntry {
        entries.iter().find(|e| e.name == name).unwrap()
    }

    #[test]
    fn sorts_dirs_first_then_case_insensitively() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        for f in ["b.txt", "A.txt", "C.txt"] {
            File::create(d.join(f)).unwrap();
        }
        for sub in ["zdir", "Bdir", "adir"] {
            create_dir(d.join(sub)).unwrap();
        }
        let entries = list_dir(d, false).unwrap();
        assert_eq!(
            names(&entries),
            ["adir", "Bdir", "zdir", "A.txt", "b.txt", "C.txt"]
        );
        let adir = find(&entries, "adir");
        assert_eq!(adir.kind, EntryKind::Dir);
        assert_eq!(adir.path, d.join("adir").to_string_lossy());
        assert!(!adir.symlink && !adir.hidden && !adir.ignored);
    }

    /// Names equal but for case only coexist on case-sensitive file
    /// systems, so the tie-break is tested on the sort alone.
    #[test]
    fn names_equal_but_for_case_sort_by_exact_name() {
        let entry = |name: &str| FsEntry {
            name: name.into(),
            path: format!("/{name}"),
            kind: EntryKind::File,
            symlink: false,
            hidden: false,
            ignored: false,
        };
        let mut entries = vec![entry("b"), entry("a"), entry("B"), entry("A")];
        sort_entries(&mut entries);
        assert_eq!(names(&entries), ["A", "a", "B", "b"]);
    }

    #[test]
    fn hidden_entries_are_flagged_or_left_out() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        File::create(d.join(".env")).unwrap();
        create_dir(d.join(".config")).unwrap();
        File::create(d.join("visible")).unwrap();

        assert_eq!(names(&list_dir(d, false).unwrap()), ["visible"]);

        let all = list_dir(d, true).unwrap();
        assert_eq!(names(&all), [".config", ".env", "visible"]);
        assert!(find(&all, ".env").hidden);
        assert!(!find(&all, ".env").ignored);
        assert!(!find(&all, "visible").hidden);
    }

    /// A repository with `.gitignore`s at the root and in `sub/`.
    fn ignore_fixture() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git2::Repository::init(d).unwrap();
        write(d.join(".gitignore"), "*.midterm-tmp\nbuild/\n").unwrap();
        File::create(d.join("keep.rs")).unwrap();
        File::create(d.join("junk.midterm-tmp")).unwrap();
        create_dir(d.join("build")).unwrap();
        create_dir(d.join("sub")).unwrap();
        write(d.join("sub/.gitignore"), "local-only\n").unwrap();
        File::create(d.join("sub/local-only")).unwrap();
        File::create(d.join("sub/inherited.midterm-tmp")).unwrap();
        File::create(d.join("sub/fine.txt")).unwrap();
        tmp
    }

    #[test]
    fn gitignore_hides_entries_and_dot_git() {
        let tmp = ignore_fixture();
        let d = tmp.path();
        assert_eq!(names(&list_dir(d, false).unwrap()), ["sub", "keep.rs"]);

        let all = list_dir(d, true).unwrap();
        assert_eq!(
            names(&all),
            [
                ".git",
                "build",
                "sub",
                ".gitignore",
                "junk.midterm-tmp",
                "keep.rs"
            ]
        );
        assert!(find(&all, ".git").ignored);
        assert!(find(&all, ".git").hidden);
        assert!(find(&all, "build").ignored);
        assert!(find(&all, "junk.midterm-tmp").ignored);
        assert!(!find(&all, ".gitignore").ignored);
        assert!(!find(&all, "sub").ignored);
    }

    #[test]
    fn nested_and_parent_gitignores_apply_to_a_subdirectory() {
        let tmp = ignore_fixture();
        let sub = tmp.path().join("sub");
        assert_eq!(names(&list_dir(&sub, false).unwrap()), ["fine.txt"]);
        let all = list_dir(&sub, true).unwrap();
        assert!(find(&all, "local-only").ignored);
        assert!(find(&all, "inherited.midterm-tmp").ignored);
        assert!(!find(&all, "fine.txt").ignored);
    }

    #[test]
    fn gitignore_outside_a_repository_is_not_honoured() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        write(d.join(".gitignore"), "skipped\n").unwrap();
        File::create(d.join("skipped")).unwrap();
        assert_eq!(names(&list_dir(d, false).unwrap()), ["skipped"]);
    }

    #[test]
    fn dot_ignore_files_apply_anywhere() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        write(d.join(".ignore"), "skipped\n").unwrap();
        File::create(d.join("skipped")).unwrap();
        File::create(d.join("kept")).unwrap();
        assert_eq!(names(&list_dir(d, false).unwrap()), ["kept"]);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_report_their_target_kind() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        create_dir(d.join("real-dir")).unwrap();
        File::create(d.join("real-file")).unwrap();
        symlink(d.join("real-dir"), d.join("link-dir")).unwrap();
        symlink(d.join("real-file"), d.join("link-file")).unwrap();
        symlink(d.join("nowhere"), d.join("link-broken")).unwrap();

        let entries = list_dir(d, false).unwrap();
        assert_eq!(
            names(&entries),
            [
                "link-dir",
                "real-dir",
                "link-broken",
                "link-file",
                "real-file"
            ]
        );
        assert_eq!(find(&entries, "link-dir").kind, EntryKind::Dir);
        assert!(find(&entries, "link-dir").symlink);
        assert_eq!(find(&entries, "link-file").kind, EntryKind::File);
        assert_eq!(find(&entries, "link-broken").kind, EntryKind::File);
        assert!(find(&entries, "link-broken").symlink);
        assert!(!find(&entries, "real-dir").symlink);

        let broken = stat(&d.join("link-broken")).unwrap().unwrap();
        assert!(broken.symlink);
        assert_eq!(broken.kind, EntryKind::File);
        assert_eq!(
            stat(&d.join("link-dir")).unwrap().unwrap().kind,
            EntryKind::Dir
        );
    }

    #[test]
    fn listing_something_that_is_not_a_directory_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("file");
        File::create(&file).unwrap();
        assert!(list_dir(&file, true).is_err());
        assert!(list_dir(&tmp.path().join("missing"), true).is_err());
    }

    #[test]
    fn stat_reports_entries_and_missing_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        File::create(d.join(".hidden")).unwrap();
        let entry = stat(&d.join(".hidden")).unwrap().unwrap();
        assert_eq!(entry.name, ".hidden");
        assert_eq!(entry.path, d.join(".hidden").to_string_lossy());
        assert_eq!(entry.kind, EntryKind::File);
        assert!(entry.hidden && !entry.symlink && !entry.ignored);
        assert_eq!(stat(d).unwrap().unwrap().kind, EntryKind::Dir);
        assert_eq!(stat(&d.join("missing")).unwrap(), None);
        assert_eq!(stat(Path::new("/")).unwrap().unwrap().name, "/");
    }
}
