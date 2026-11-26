//! Every file (or file and directory) under a directory, for the command
//! palette's fuzzy file open and the explorer's name search.

use std::path::Path;

use ignore::{Walk, WalkBuilder};
use serde::Serialize;

/// A sorted, sequential walk under `root` that does not follow symlinks.
///
/// Without `show_hidden`, hidden and ignored entries are skipped (the
/// explorer's rules: `.gitignore` and friends inside a repository,
/// `.ignore` anywhere). With it, everything is walked except the contents
/// of `.git` directories (the `.git` entry itself is still yielded).
/// The first item is `root` itself.
pub(crate) fn walk(root: &Path, show_hidden: bool) -> Walk {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(!show_hidden)
        .follow_links(false)
        // Sorted, so results (and their truncation) are stable between runs.
        .sort_by_file_name(|a, b| a.cmp(b));
    if show_hidden {
        builder.standard_filters(false).filter_entry(|entry| {
            // Depth 1 is root's own children: a root that is itself named
            // `.git` can still be searched.
            entry.depth() < 2 || entry.path().parent().and_then(Path::file_name).is_none_or(|n| n != ".git")
        });
    }
    builder.build()
}

/// The files found under a root, as `FoundFiles` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundFiles {
    /// `/`-separated paths relative to the root, in walk order.
    pub paths: Vec<String>,
    /// The walk stopped at `limit` files.
    pub truncated: bool,
}

/// Files under `root` (not directories), skipping hidden entries and
/// anything the ignore rules exclude (the same rules as the explorer:
/// `.gitignore` and friends inside a repository, `.ignore` anywhere).
/// Symlinks are not followed. Stops after `limit` files.
pub fn find_files(root: &Path, limit: usize) -> Result<FoundFiles, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let mut paths = Vec::new();
    let mut truncated = false;
    for entry in walk(root, false) {
        // Unreadable directories are skipped, not fatal.
        let Ok(entry) = entry else { continue };
        let Some(file_type) = entry.file_type() else { continue };
        // A symlink counts only if it leads to a regular file.
        let is_file = file_type.is_file()
            || (file_type.is_symlink() && std::fs::metadata(entry.path()).is_ok_and(|m| m.is_file()));
        if !is_file {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let Some(relative) = relative.to_str() else {
            continue;
        };
        if paths.len() == limit {
            truncated = true;
            break;
        }
        paths.push(relative.replace(std::path::MAIN_SEPARATOR, "/"));
    }
    Ok(FoundFiles { paths, truncated })
}

/// One entry found by [`find_entries`], as `FoundEntry` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FoundEntry {
    /// `/`-separated, relative to the root.
    pub path: String,
    pub dir: bool,
}

/// The entries found under a root, as `FoundEntries` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FoundEntries {
    /// In walk order (sorted by name within each directory).
    pub entries: Vec<FoundEntry>,
    /// The walk stopped at `limit` entries.
    pub truncated: bool,
}

/// Files and directories under `root` (not `root` itself); see [`walk`] for
/// what `show_hidden` changes. A symlink is reported with its target's
/// kind (a broken one is a file) and never followed. Stops after `limit`
/// entries.
pub fn find_entries(root: &Path, limit: usize, show_hidden: bool) -> Result<FoundEntries, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in walk(root, show_hidden) {
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let Some(file_type) = entry.file_type() else { continue };
        let dir = file_type.is_dir()
            || (file_type.is_symlink() && std::fs::metadata(entry.path()).is_ok_and(|m| m.is_dir()));
        let Some(relative) = entry.path().strip_prefix(root).ok().and_then(Path::to_str) else {
            continue;
        };
        if entries.len() == limit {
            truncated = true;
            break;
        }
        entries.push(FoundEntry { path: relative.replace(std::path::MAIN_SEPARATOR, "/"), dir });
    }
    Ok(FoundEntries { entries, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_files_respecting_ignore_rules() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("src/a.ts"), "").unwrap();
        fs::write(root.join("src/deep/b.ts"), "").unwrap();
        fs::write(root.join("build/out.js"), "").unwrap();
        fs::write(root.join(".hidden/x"), "").unwrap();
        fs::write(root.join("README.md"), "").unwrap();
        fs::write(root.join(".ignore"), "build/\n").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("src"), root.join("dirlink")).unwrap();
            std::os::unix::fs::symlink(root.join("missing"), root.join("broken")).unwrap();
            std::os::unix::fs::symlink(root.join("README.md"), root.join("readme-link")).unwrap();
        }

        let found = find_files(root, 100).unwrap();
        #[cfg(unix)]
        assert_eq!(found.paths, vec!["README.md", "readme-link", "src/a.ts", "src/deep/b.ts"]);
        assert!(!found.truncated);

        let limited = find_files(root, 2).unwrap();
        #[cfg(not(unix))]
        let _ = &found;
        assert_eq!(limited.paths.len(), 2);
        assert!(limited.truncated);
    }

    #[test]
    fn rejects_a_missing_root() {
        assert!(find_files(Path::new("/definitely/not/here"), 10).is_err());
    }

    fn paths(found: &FoundEntries) -> Vec<String> {
        found.entries.iter().map(|e| format!("{}{}", e.path, if e.dir { "/" } else { "" })).collect()
    }

    #[test]
    fn finds_entries_respecting_ignore_rules() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("src/a.ts"), "").unwrap();
        fs::write(root.join("src/deep/b.ts"), "").unwrap();
        fs::write(root.join("build/out.js"), "").unwrap();
        fs::write(root.join(".hidden/x"), "").unwrap();
        fs::write(root.join("README.md"), "").unwrap();
        fs::write(root.join(".ignore"), "build/\n").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("src"), root.join("dirlink")).unwrap();
            std::os::unix::fs::symlink(root.join("missing"), root.join("broken")).unwrap();
        }

        let found = find_entries(root, 100, false).unwrap();
        #[cfg(unix)]
        assert_eq!(
            paths(&found),
            vec!["README.md", "broken", "dirlink/", "src/", "src/a.ts", "src/deep/", "src/deep/b.ts"]
        );
        #[cfg(not(unix))]
        assert_eq!(paths(&found), vec!["README.md", "src/", "src/a.ts", "src/deep/", "src/deep/b.ts"]);
        assert!(!found.truncated);

        let limited = find_entries(root, 3, false).unwrap();
        assert_eq!(limited.entries.len(), 3);
        assert!(limited.truncated);
        let exact = find_entries(root, found.entries.len(), false).unwrap();
        assert!(!exact.truncated);
    }

    #[test]
    fn find_entries_with_hidden_includes_everything_but_git_contents() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".git/objects")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::create_dir_all(root.join("build/sub/.git/x")).unwrap();
        fs::write(root.join(".git/HEAD"), "").unwrap();
        fs::write(root.join(".hidden/x"), "").unwrap();
        fs::write(root.join("build/out.js"), "").unwrap();
        fs::write(root.join(".ignore"), "build/\n").unwrap();

        let found = find_entries(root, 100, true).unwrap();
        assert_eq!(
            paths(&found),
            vec![".git/", ".hidden/", ".hidden/x", ".ignore", "build/", "build/out.js", "build/sub/", "build/sub/.git/"]
        );
    }

    #[test]
    fn find_entries_rejects_a_missing_root() {
        assert!(find_entries(Path::new("/definitely/not/here"), 10, false).is_err());
    }

    #[test]
    fn find_entries_can_search_inside_a_git_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".git");
        fs::create_dir_all(root.join("objects")).unwrap();
        fs::write(root.join("HEAD"), "").unwrap();
        let found = find_entries(&root, 100, true).unwrap();
        assert_eq!(paths(&found), vec!["HEAD", "objects/"]);
    }
}
