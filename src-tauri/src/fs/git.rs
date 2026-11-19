//! Git status of a work tree, for the explorer's decorations.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use git2::{Repository, Status, StatusOptions};
use serde::Serialize;

/// As `GitStatus` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Work tree root, absolute, no trailing slash.
    pub root: String,
    pub branch: Option<String>,
    /// Paths relative to `root`, `/`-separated.
    pub entries: BTreeMap<String, GitCode>,
}

/// One letter per path. Declared from highest to lowest precedence: when
/// several apply to a path (say, staged as new and then deleted from the
/// work tree), the first one wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum GitCode {
    #[serde(rename = "C")]
    Conflicted,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "R")]
    Renamed,
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "U")]
    Untracked,
}

impl GitCode {
    fn from_status(s: Status) -> Option<GitCode> {
        Some(if s.is_conflicted() {
            GitCode::Conflicted
        } else if s.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
            GitCode::Deleted
        } else if s.is_index_renamed() {
            GitCode::Renamed
        } else if s.is_index_new() {
            GitCode::Added
        } else if s.intersects(
            Status::INDEX_MODIFIED
                | Status::INDEX_TYPECHANGE
                | Status::WT_MODIFIED
                | Status::WT_TYPECHANGE
                | Status::WT_RENAMED,
        ) {
            GitCode::Modified
        } else if s.is_wt_new() {
            GitCode::Untracked
        } else {
            // Current, or ignored.
            return None;
        })
    }
}

/// Status of the work tree containing `path`, or `None` if there is none
/// (not in a repository, a bare repository, or one libgit2 cannot open).
///
/// Never writes to the repository: libgit2 only refreshes the index's stat
/// cache when asked to (`update_index`), and a write to `.git/index` would
/// wake the explorer's `.git` watcher and ask for status again.
pub fn status(path: &Path) -> Result<Option<GitStatus>, String> {
    // `discover`, unlike `open_from_env`, ignores `GIT_DIR` and friends,
    // which the app may have inherited from the shell that launched it.
    let Ok(repo) = Repository::discover(path) else {
        return Ok(None);
    };
    let Some(workdir) = repo.workdir() else {
        return Ok(None);
    };
    let root = root_in_callers_terms(path, workdir);

    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        // As `git status`: staged renames are detected, unstaged ones show
        // as a deletion and an untracked file.
        .renames_head_to_index(true);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|e| format!("git status failed: {}", e.message()))?;

    let mut entries = BTreeMap::new();
    for entry in statuses.iter() {
        let Some(code) = GitCode::from_status(entry.status()) else {
            continue;
        };
        // `path()` is the old path of a rename; report it at the new one.
        let renamed_to = (code == GitCode::Renamed)
            .then(|| entry.head_to_index())
            .flatten()
            .and_then(|delta| delta.new_file().path().map(Path::to_owned));
        let rel = match renamed_to {
            Some(new) => new.to_str().map(str::to_owned),
            None => entry.path().ok().map(str::to_owned),
        };
        // Paths that are not UTF-8 cannot be matched by the frontend anyway.
        let Some(rel) = rel else { continue };
        let rel = if cfg!(windows) {
            rel.replace('\\', "/")
        } else {
            rel
        };
        entries
            .entry(rel)
            .and_modify(|c: &mut GitCode| *c = (*c).min(code))
            .or_insert(code);
    }

    Ok(Some(GitStatus {
        root,
        branch: branch_name(&repo),
        entries,
    }))
}

/// HEAD's branch, `None` when detached. For an unborn branch (a fresh
/// `git init`) it is the branch HEAD points at, so a new repository shows
/// `main` rather than nothing.
fn branch_name(repo: &Repository) -> Option<String> {
    match repo.head() {
        Ok(head) if head.is_branch() => head.shorthand().ok().map(str::to_owned),
        Ok(_) => None,
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => {
            let head = repo.find_reference("HEAD").ok()?;
            let target = head.symbolic_target().ok()??;
            target.strip_prefix("refs/heads/").map(str::to_owned)
        }
        Err(_) => None,
    }
}

/// The work tree root, spelled the way the caller spells `path`.
///
/// libgit2 resolves symlinks (on macOS `/tmp` becomes `/private/tmp`), but
/// the frontend joins `root` with relative paths and compares the result
/// with the paths it lists, so the root has to keep the caller's prefix.
/// When `path` resolves to somewhere inside `workdir`, the root is `path`
/// with as many trailing components dropped as it is deeper than `workdir`;
/// otherwise it is `workdir` as libgit2 reports it.
fn root_in_callers_terms(path: &Path, workdir: &Path) -> String {
    let fallback = || trim_trailing_separator(workdir);
    let (Ok(real_path), Ok(real_workdir)) = (path.canonicalize(), workdir.canonicalize()) else {
        return fallback();
    };
    let Ok(below) = real_path.strip_prefix(&real_workdir) else {
        return fallback();
    };
    let mut candidate: PathBuf = path.to_owned();
    for _ in below.components() {
        if !candidate.pop() {
            return fallback();
        }
    }
    // Dropping components lexically is wrong if they were `..` or symlinks;
    // only use the result if it really is the work tree.
    match candidate.canonicalize() {
        Ok(real) if real == real_workdir => trim_trailing_separator(&candidate),
        _ => fallback(),
    }
}

fn trim_trailing_separator(path: &Path) -> String {
    let s = path.to_string_lossy();
    let trimmed = s.trim_end_matches(std::path::is_separator);
    if trimmed.is_empty() {
        s.into_owned()
    } else {
        trimmed.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, remove_file, write};

    use git2::Signature;

    /// A repository with `tracked.txt`, `gone.txt` and `old.txt` committed
    /// on `main`.
    fn repo_fixture() -> (tempfile::TempDir, Repository) {
        let tmp = tempfile::tempdir().unwrap();
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("main");
        let repo = Repository::init_opts(tmp.path(), &opts).unwrap();
        for f in ["tracked.txt", "gone.txt", "old.txt", "staged-gone.txt"] {
            write(tmp.path().join(f), f).unwrap();
        }
        stage(
            &repo,
            &["tracked.txt", "gone.txt", "old.txt", "staged-gone.txt"],
            &[],
        );
        commit(&repo);
        (tmp, repo)
    }

    fn stage(repo: &Repository, add: &[&str], remove: &[&str]) {
        let mut index = repo.index().unwrap();
        for f in add {
            index.add_path(Path::new(f)).unwrap();
        }
        for f in remove {
            index.remove_path(Path::new(f)).unwrap();
        }
        index.write().unwrap();
    }

    fn commit(repo: &Repository) {
        let mut index = repo.index().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<_> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, "commit", &tree, &parents)
            .unwrap();
    }

    fn code_of(status: &GitStatus, path: &str) -> Option<GitCode> {
        status.entries.get(path).copied()
    }

    #[test]
    fn reports_each_kind_of_change() {
        let (tmp, repo) = repo_fixture();
        let d = tmp.path();
        write(d.join("tracked.txt"), "changed").unwrap();
        remove_file(d.join("gone.txt")).unwrap();
        write(d.join("staged-new.txt"), "new").unwrap();
        create_dir_all(d.join("newdir/deeper")).unwrap();
        write(d.join("newdir/deeper/untracked.txt"), "u").unwrap();
        write(d.join("untracked.txt"), "u").unwrap();
        std::fs::rename(d.join("old.txt"), d.join("new.txt")).unwrap();
        remove_file(d.join("staged-gone.txt")).unwrap();
        write(d.join(".gitignore"), "*.ignored\n").unwrap();
        write(d.join("skip.ignored"), "i").unwrap();
        stage(
            &repo,
            &["staged-new.txt", "new.txt"],
            &["old.txt", "staged-gone.txt"],
        );

        let status = status(d).unwrap().unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(code_of(&status, "tracked.txt"), Some(GitCode::Modified));
        assert_eq!(code_of(&status, "gone.txt"), Some(GitCode::Deleted));
        assert_eq!(code_of(&status, "staged-gone.txt"), Some(GitCode::Deleted));
        assert_eq!(code_of(&status, "staged-new.txt"), Some(GitCode::Added));
        assert_eq!(code_of(&status, "new.txt"), Some(GitCode::Renamed));
        assert_eq!(code_of(&status, "old.txt"), None);
        assert_eq!(code_of(&status, "untracked.txt"), Some(GitCode::Untracked));
        assert_eq!(code_of(&status, ".gitignore"), Some(GitCode::Untracked));
        assert_eq!(
            code_of(&status, "newdir/deeper/untracked.txt"),
            Some(GitCode::Untracked)
        );
        assert_eq!(code_of(&status, "newdir/"), None);
        assert_eq!(code_of(&status, "skip.ignored"), None);
        assert_eq!(status.entries.len(), 8, "{:?}", status.entries);

        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["entries"]["new.txt"], "R");
        assert_eq!(json["branch"], "main");
    }

    #[test]
    fn root_keeps_the_callers_spelling_and_works_from_subdirectories() {
        let (tmp, _repo) = repo_fixture();
        create_dir_all(tmp.path().join("a/b")).unwrap();
        let status = status(&tmp.path().join("a/b")).unwrap().unwrap();
        // On macOS the temp dir is under a symlink (`/var` -> `/private/var`).
        assert_eq!(status.root, tmp.path().to_string_lossy());
        assert!(status.entries.is_empty(), "{:?}", status.entries);
    }

    #[test]
    fn precedence_picks_the_strongest_letter() {
        let s = Status::INDEX_NEW | Status::WT_DELETED;
        assert_eq!(GitCode::from_status(s), Some(GitCode::Deleted));
        let s = Status::INDEX_NEW | Status::WT_MODIFIED;
        assert_eq!(GitCode::from_status(s), Some(GitCode::Added));
        let s = Status::INDEX_RENAMED | Status::WT_MODIFIED;
        assert_eq!(GitCode::from_status(s), Some(GitCode::Renamed));
        let s = Status::CONFLICTED | Status::WT_MODIFIED;
        assert_eq!(GitCode::from_status(s), Some(GitCode::Conflicted));
        assert_eq!(GitCode::from_status(Status::IGNORED), None);
        assert_eq!(GitCode::from_status(Status::CURRENT), None);
    }

    #[test]
    fn unborn_and_detached_heads() {
        let tmp = tempfile::tempdir().unwrap();
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("trunk");
        let repo = Repository::init_opts(tmp.path(), &opts).unwrap();
        let status = status(tmp.path()).unwrap().unwrap();
        assert_eq!(status.branch.as_deref(), Some("trunk"));

        write(tmp.path().join("f"), "f").unwrap();
        stage(&repo, &["f"], &[]);
        commit(&repo);
        let head = repo.head().unwrap().target().unwrap();
        repo.set_head_detached(head).unwrap();
        assert_eq!(super::status(tmp.path()).unwrap().unwrap().branch, None);
    }

    #[test]
    fn outside_a_repository_or_bare_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        // Guard against the temp dir itself being inside a repository.
        if Repository::discover(tmp.path()).is_ok() {
            return;
        }
        assert_eq!(status(tmp.path()).unwrap(), None);
        let bare = tmp.path().join("bare.git");
        Repository::init_bare(&bare).unwrap();
        assert_eq!(status(&bare).unwrap(), None);
    }
}
