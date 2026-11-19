//! Every file under a directory, for the command palette's fuzzy file open.

use std::path::Path;

use ignore::WalkBuilder;
use serde::Serialize;

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
    let walk = WalkBuilder::new(root)
        .hidden(true)
        .follow_links(false)
        // Sorted, so results (and their truncation) are stable between runs.
        .sort_by_file_name(|a, b| a.cmp(b))
        .build();
    for entry in walk {
        // Unreadable directories are skipped, not fatal.
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file() || t.is_symlink()) {
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

        let found = find_files(root, 100).unwrap();
        assert_eq!(found.paths, vec!["README.md", "src/a.ts", "src/deep/b.ts"]);
        assert!(!found.truncated);

        let limited = find_files(root, 2).unwrap();
        assert_eq!(limited.paths.len(), 2);
        assert!(limited.truncated);
    }

    #[test]
    fn rejects_a_missing_root() {
        assert!(find_files(Path::new("/definitely/not/here"), 10).is_err());
    }
}
