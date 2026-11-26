//! Tauri `scm_*` commands for the Source Control plugin.
//! All commands accept either local POSIX paths or `ssh://<remoteId>/<path>` URIs.

use std::collections::HashSet;
#[cfg(not(unix))]
use std::io::Read;
#[cfg(not(unix))]
use std::path::Component;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::ssh::SshManager;
use crate::ssh::location::Location;

use super::exec::{
    LOCAL_TIMEOUT, NETWORK_TIMEOUT, root_in_callers_terms, run_git, validate_hash,
    validate_ref_name, validate_rel_path, validate_remote_name,
};
use super::parse::{
    MAX_UNTRACKED_DIFF_BYTES, parse_branches_z, parse_commit_files, parse_log_z,
    parse_porcelain_v2_z, parse_stashes_z, parse_unified_diff, synthesize_untracked_diff,
};
use super::types::{
    ConflictStrategy, ScmBranch, ScmCommit, ScmCommitFile, ScmDiff, ScmDiffMode, ScmRepoState,
    ScmStash, ScmStatus,
};

struct RepoInfo {
    /// Work tree root as a `Location` (used for subsequent git commands).
    root_loc: Location,
    /// Work tree root string in caller's spelling.
    root_str: String,
    /// Absolute `.git` dir string (for watching).
    git_dir_str: String,
    /// Local path or remote posix path to `.git` dir.
    git_dir_loc: Location,
}

fn strip_single_newline(bytes: &[u8]) -> Result<String, String> {
    let without_nl = bytes
        .strip_suffix(b"\r\n")
        .or_else(|| bytes.strip_suffix(b"\n"))
        .unwrap_or(bytes);
    let s = std::str::from_utf8(without_nl)
        .map_err(|_| "repository path is not valid UTF-8".to_string())?;
    if s.is_empty() || s.contains(['\0', '\n', '\r']) {
        return Err("repository path contains unsupported characters".into());
    }
    Ok(s.to_string())
}

async fn resolve_repo(ssh: &SshManager, path: &str) -> Result<Option<RepoInfo>, String> {
    let loc = Location::parse(path)?;
    let (top_out, git_dir_out) = tokio::try_join!(
        run_git(
            ssh,
            &loc,
            &["rev-parse", "--show-toplevel"],
            None,
            true,
            LOCAL_TIMEOUT,
        ),
        run_git(
            ssh,
            &loc,
            &["rev-parse", "--absolute-git-dir"],
            None,
            true,
            LOCAL_TIMEOUT,
        ),
    )?;
    if top_out.code != 0 {
        let err_lc = top_out.stderr.to_ascii_lowercase();
        if err_lc.contains("not a git repository") || err_lc.contains("must be run in a work tree") {
            return Ok(None);
        }
        return Err(top_out.error_message("rev-parse"));
    }
    if git_dir_out.code != 0 {
        return Err(git_dir_out.error_message("rev-parse"));
    }
    if top_out.truncated || git_dir_out.truncated {
        return Err("repository path output exceeded size limit".into());
    }
    let workdir_raw = strip_single_newline(&top_out.stdout)?;
    let git_dir_raw = strip_single_newline(&git_dir_out.stdout)?;

    match &loc {
        Location::Local(caller) => {
            let workdir = PathBuf::from(&workdir_raw);
            let root_str = root_in_callers_terms(caller, &workdir);
            let git_dir_path = PathBuf::from(&git_dir_raw);
            Ok(Some(RepoInfo {
                root_loc: Location::Local(PathBuf::from(&root_str)),
                root_str,
                git_dir_str: git_dir_raw,
                git_dir_loc: Location::Local(git_dir_path),
            }))
        }
        Location::Remote { remote_id, .. } => {
            let root_str = Location::format_remote(remote_id, &workdir_raw);
            let git_dir_str = Location::format_remote(remote_id, &git_dir_raw);
            Ok(Some(RepoInfo {
                root_loc: Location::Remote {
                    remote_id: remote_id.clone(),
                    path: workdir_raw,
                },
                root_str,
                git_dir_str,
                git_dir_loc: Location::Remote {
                    remote_id: remote_id.clone(),
                    path: git_dir_raw,
                },
            }))
        }
    }
}

async fn require_repo(ssh: &SshManager, path: &str) -> Result<RepoInfo, String> {
    resolve_repo(ssh, path)
        .await?
        .ok_or_else(|| "Not inside a Git repository".to_string())
}

async fn detect_repo_state(ssh: &SshManager, git_dir: &Location) -> Result<ScmRepoState, String> {
    const MARKERS: &[(&str, ScmRepoState)] = &[
        ("rebase-merge", ScmRepoState::Rebasing),
        ("rebase-apply", ScmRepoState::Rebasing),
        ("MERGE_HEAD", ScmRepoState::Merging),
        ("CHERRY_PICK_HEAD", ScmRepoState::CherryPicking),
        ("REVERT_HEAD", ScmRepoState::Reverting),
        ("BISECT_LOG", ScmRepoState::Bisecting),
    ];
    match git_dir {
        Location::Local(dir) => {
            let dir = dir.clone();
            tokio::task::spawn_blocking(move || {
                for (file, state) in MARKERS {
                    match dir.join(file).try_exists() {
                        Ok(true) => return Ok(*state),
                        Ok(false) => {}
                        Err(e) => {
                            return Err(format!("cannot inspect git state marker {file}: {e}"));
                        }
                    }
                }
                Ok(ScmRepoState::Normal)
            })
            .await
            .map_err(|e| format!("background task failed: {e}"))?
        }
        Location::Remote { remote_id, path } => {
            let base = path.trim_end_matches('/');
            for (file, state) in MARKERS {
                let probe = format!("{base}/{file}");
                if ssh.stat(remote_id, &probe).await?.is_some() {
                    return Ok(*state);
                }
            }
            Ok(ScmRepoState::Normal)
        }
    }
}

enum HeadState {
    Commit,
    Unborn,
}

/// Distinguishes a real HEAD commit from an unborn branch while propagating
/// transport/git failures rather than masking them as unborn.
async fn inspect_head(ssh: &SshManager, root: &Location) -> Result<HeadState, String> {
    let out = run_git(
        ssh,
        root,
        &["rev-parse", "--verify", "HEAD"],
        None,
        true,
        LOCAL_TIMEOUT,
    )
    .await?;
    if out.code == 0 {
        return Ok(HeadState::Commit);
    }
    // Check if HEAD is a symbolic ref pointing to an unborn branch.
    let sym = run_git(
        ssh,
        root,
        &["symbolic-ref", "-q", "HEAD"],
        None,
        true,
        LOCAL_TIMEOUT,
    )
    .await?;
    if sym.code == 0 {
        Ok(HeadState::Unborn)
    } else {
        Err(out.error_message("rev-parse HEAD"))
    }
}

#[cfg(unix)]
mod unix_confined {
    use std::ffi::{CString, OsStr};
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Component, Path};

    use super::MAX_UNTRACKED_DIFF_BYTES;

    fn cstr_from_os(s: &OsStr) -> Result<CString, String> {
        CString::new(s.as_bytes()).map_err(|_| "path contains NUL byte".to_string())
    }

    fn fstat_fd(fd: &OwnedFd) -> Result<libc::stat, std::io::Error> {
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd.as_raw_fd(), &mut st) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(st)
    }

    fn dev_ino(st: &libc::stat) -> (u64, u64) {
        (st.st_dev as u64, st.st_ino as u64)
    }

    pub enum LeafLookup {
        Found(OwnedFd, CString, libc::stat),
        NotFound,
    }

    /// Walks from `root` to the parent directory of `rel` using descriptor-relative
    /// `openat(..., O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)` so no ancestor can be
    /// swapped for a symlink after verification, and rejects any step aliasing `git_dir`.
    pub fn open_confined_parent(
        root: &Path,
        git_dir: &Path,
        rel: &str,
    ) -> Result<LeafLookup, String> {
        let git_id = std::fs::metadata(git_dir).ok().map(|m| (m.dev(), m.ino()));
        let comps: Vec<&OsStr> = Path::new(rel)
            .components()
            .map(|c| match c {
                Component::Normal(s) => Ok(s),
                _ => Err(format!("invalid repository path: {rel}")),
            })
            .collect::<Result<_, _>>()?;
        if comps.is_empty() {
            return Err(format!("invalid repository path: {rel}"));
        }

        let root_c = cstr_from_os(root.as_os_str())?;
        let dir_flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;
        let root_raw = unsafe { libc::open(root_c.as_ptr(), dir_flags) };
        if root_raw < 0 {
            return Err(format!(
                "cannot open repo root: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut cur_fd = unsafe { OwnedFd::from_raw_fd(root_raw) };

        for seg in &comps[..comps.len() - 1] {
            let seg_c = cstr_from_os(seg)?;
            let nxt_raw = unsafe {
                libc::openat(
                    cur_fd.as_raw_fd(),
                    seg_c.as_ptr(),
                    dir_flags | libc::O_NOFOLLOW,
                )
            };
            if nxt_raw < 0 {
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() == Some(libc::ENOENT) {
                    return Ok(LeafLookup::NotFound);
                }
                return Err(format!("cannot traverse ancestor for {rel}: {err}"));
            }
            cur_fd = unsafe { OwnedFd::from_raw_fd(nxt_raw) };
            let st = fstat_fd(&cur_fd)
                .map_err(|e| format!("cannot inspect ancestor for {rel}: {e}"))?;
            if git_id.is_some_and(|gid| dev_ino(&st) == gid) {
                return Err("refusing to traverse into git metadata directory".into());
            }
        }

        let leaf_c = cstr_from_os(comps[comps.len() - 1])?;
        let mut leaf_st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::fstatat(
                cur_fd.as_raw_fd(),
                leaf_c.as_ptr(),
                &mut leaf_st,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ENOENT) {
                return Ok(LeafLookup::NotFound);
            }
            return Err(format!("cannot inspect {rel}: {err}"));
        }
        if git_id.is_some_and(|gid| dev_ino(&leaf_st) == gid) {
            return Err("refusing to operate on git metadata directory".into());
        }
        Ok(LeafLookup::Found(cur_fd, leaf_c, leaf_st))
    }

    pub fn read_untracked(root: &Path, git_dir: &Path, rel: &str) -> Result<Vec<u8>, String> {
        let (dir_fd, leaf_c, leaf_st) = match open_confined_parent(root, git_dir, rel)? {
            LeafLookup::Found(fd, leaf, st) => (fd, leaf, st),
            LeafLookup::NotFound => return Err(format!("cannot inspect {rel}: No such file or directory")),
        };
        let ftype = leaf_st.st_mode & libc::S_IFMT;
        if ftype == libc::S_IFLNK {
            let mut buf = vec![0u8; 4096];
            let n = unsafe {
                libc::readlinkat(
                    dir_fd.as_raw_fd(),
                    leaf_c.as_ptr(),
                    buf.as_mut_ptr() as *mut libc::c_char,
                    buf.len(),
                )
            };
            if n < 0 {
                return Err(format!(
                    "cannot read symlink {rel}: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let target = String::from_utf8_lossy(&buf[..n as usize]);
            return Ok(format!("symlink -> {target}\n").into_bytes());
        }
        if ftype != libc::S_IFREG {
            return Err(format!("{rel} is not a regular file"));
        }
        let raw = unsafe {
            libc::openat(
                dir_fd.as_raw_fd(),
                leaf_c.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if raw < 0 {
            return Err(format!(
                "cannot open {rel}: {}",
                std::io::Error::last_os_error()
            ));
        }
        let file = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(raw) });
        let fmeta = file
            .metadata()
            .map_err(|e| format!("cannot inspect {rel}: {e}"))?;
        if !fmeta.is_file() {
            return Err(format!("{rel} is not a regular file"));
        }
        let mut buf = Vec::new();
        file.take((MAX_UNTRACKED_DIFF_BYTES + 1) as u64)
            .read_to_end(&mut buf)
            .map_err(|e| format!("cannot read {rel}: {e}"))?;
        Ok(buf)
    }

    /// Atomically claims each verified untracked file via `renameat` into a private
    /// `0700` staging directory under `root` before passing only the claimed private
    /// paths to the pathname-based Trash API.
    pub fn trash_untracked(root: &Path, git_dir: &Path, eligible: &[String]) -> Result<(), String> {
        let staging = tempfile::Builder::new()
            .prefix(".midterm-discard-")
            .tempdir_in(root)
            .map_err(|e| format!("cannot create discard staging directory: {e}"))?;
        let staging_c = cstr_from_os(staging.path().as_os_str())?;
        let dir_flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let stg_raw = unsafe { libc::open(staging_c.as_ptr(), dir_flags) };
        if stg_raw < 0 {
            return Err(format!(
                "cannot open discard staging directory: {}",
                std::io::Error::last_os_error()
            ));
        }
        let staging_fd = unsafe { OwnedFd::from_raw_fd(stg_raw) };

        let mut claimed: Vec<(String, OwnedFd, OwnedFd, CString)> = Vec::with_capacity(eligible.len());
        for (idx, rel) in eligible.iter().enumerate() {
            let (dir_fd, leaf_c, leaf_st) = match open_confined_parent(root, git_dir, rel)? {
                LeafLookup::Found(fd, leaf, st) => (fd, leaf, st),
                LeafLookup::NotFound => continue,
            };
            if (leaf_st.st_mode & libc::S_IFMT) == libc::S_IFDIR {
                return Err(format!(
                    "refusing to delete directory as untracked file: {rel}"
                ));
            }
            let slot_name = idx.to_string();
            let slot_c = CString::new(slot_name.as_str()).map_err(|_| "invalid slot name")?;
            if unsafe { libc::mkdirat(staging_fd.as_raw_fd(), slot_c.as_ptr(), 0o700) } != 0 {
                return Err(format!(
                    "cannot prepare staging slot for {rel}: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let slot_raw =
                unsafe { libc::openat(staging_fd.as_raw_fd(), slot_c.as_ptr(), dir_flags) };
            if slot_raw < 0 {
                return Err(format!(
                    "cannot open staging slot for {rel}: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let slot_fd = unsafe { OwnedFd::from_raw_fd(slot_raw) };
            if unsafe {
                libc::renameat(
                    dir_fd.as_raw_fd(),
                    leaf_c.as_ptr(),
                    slot_fd.as_raw_fd(),
                    leaf_c.as_ptr(),
                )
            } != 0
            {
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() == Some(libc::ENOENT) {
                    continue;
                }
                return Err(format!("cannot claim untracked file {rel}: {err}"));
            }
            let leaf_os = OsStr::from_bytes(leaf_c.as_bytes());
            let staged_path = staging.path().join(&slot_name).join(leaf_os);
            claimed.push((
                staged_path.to_string_lossy().into_owned(),
                dir_fd,
                slot_fd,
                leaf_c,
            ));
        }

        if claimed.is_empty() {
            return Ok(());
        }
        let paths: Vec<String> = claimed.iter().map(|(p, _, _, _)| p.clone()).collect();
        if let Err(err) = crate::fs::ops::trash(&paths) {
            // Best-effort restore any files that were not trashed.
            for (_, dir_fd, slot_fd, leaf_c) in &claimed {
                let _ = unsafe {
                    libc::renameat(
                        slot_fd.as_raw_fd(),
                        leaf_c.as_ptr(),
                        dir_fd.as_raw_fd(),
                        leaf_c.as_ptr(),
                    )
                };
            }
            return Err(err);
        }
        Ok(())
    }
}

#[cfg(not(unix))]
fn verify_confined_local_path(root: &Path, git_dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve repo root: {e}"))?;
    let git_canon = git_dir.canonicalize().ok();
    let comps: Vec<&std::ffi::OsStr> = Path::new(rel)
        .components()
        .map(|c| match c {
            Component::Normal(s) => Ok(s),
            _ => Err(format!("invalid repository path: {rel}")),
        })
        .collect::<Result<_, _>>()?;
    if comps.is_empty() {
        return Err(format!("invalid repository path: {rel}"));
    }
    let mut cur = root_canon.clone();
    for seg in &comps[..comps.len() - 1] {
        cur.push(seg);
        let meta = std::fs::symlink_metadata(&cur)
            .map_err(|e| format!("cannot inspect ancestor for {rel}: {e}"))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(format!("refusing to traverse symlinked ancestor for {rel}"));
        }
        let cur_canon = cur
            .canonicalize()
            .map_err(|e| format!("cannot resolve ancestor for {rel}: {e}"))?;
        if !cur_canon.starts_with(&root_canon) {
            return Err(format!("refusing path outside repository: {rel}"));
        }
        if let Some(ref gc) = git_canon
            && cur_canon.starts_with(gc)
        {
            return Err("refusing to traverse into git metadata directory".into());
        }
    }
    cur.push(comps[comps.len() - 1]);
    Ok(cur)
}

/// Reads an untracked local file or symlink safely without traversing symlinks
/// or entering `git_dir`, bounded to `MAX_UNTRACKED_DIFF_BYTES + 1`.
fn read_confined_local_untracked(root: &Path, git_dir: &Path, rel: &str) -> Result<Vec<u8>, String> {
    #[cfg(unix)]
    {
        unix_confined::read_untracked(root, git_dir, rel)
    }
    #[cfg(not(unix))]
    {
        let full = verify_confined_local_path(root, git_dir, rel)?;
        let meta = std::fs::symlink_metadata(&full)
            .map_err(|e| format!("cannot inspect {rel}: {e}"))?;
        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&full)
                .map_err(|e| format!("cannot read symlink {rel}: {e}"))?;
            return Ok(format!("symlink -> {}\n", target.display()).into_bytes());
        }
        if !meta.file_type().is_file() {
            return Err(format!("{rel} is not a regular file"));
        }
        let file = std::fs::File::open(&full).map_err(|e| format!("cannot open {rel}: {e}"))?;
        let mut buf = Vec::new();
        file.take((MAX_UNTRACKED_DIFF_BYTES + 1) as u64)
            .read_to_end(&mut buf)
            .map_err(|e| format!("cannot read {rel}: {e}"))?;
        Ok(buf)
    }
}

fn trash_confined_local_untracked(
    root: &Path,
    git_dir: &Path,
    eligible: &[String],
) -> Result<(), String> {
    #[cfg(unix)]
    {
        unix_confined::trash_untracked(root, git_dir, eligible)
    }
    #[cfg(not(unix))]
    {
        let mut abs = Vec::with_capacity(eligible.len());
        for rel in eligible {
            let full = verify_confined_local_path(root, git_dir, rel)?;
            let Ok(meta) = std::fs::symlink_metadata(&full) else {
                continue;
            };
            if meta.file_type().is_dir() {
                return Err(format!(
                    "refusing to delete directory as untracked file: {rel}"
                ));
            }
            abs.push(full.to_string_lossy().into_owned());
        }
        if !abs.is_empty() {
            crate::fs::ops::trash(&abs)?;
        }
        Ok(())
    }
}

/// Full Source Control status for the repository containing `path`, or `null`
/// if `path` is outside a work tree.
#[tauri::command]
pub async fn scm_status(
    ssh: State<'_, SshManager>,
    path: String,
) -> Result<Option<ScmStatus>, String> {
    scm_status_inner(&ssh, &path).await
}

pub(crate) async fn scm_status_inner(
    ssh: &SshManager,
    path: &str,
) -> Result<Option<ScmStatus>, String> {
    let Some(repo) = resolve_repo(ssh, path).await? else {
        return Ok(None);
    };
    let out = run_git(
        ssh,
        &repo.root_loc,
        &["status", "--porcelain=v2", "--branch", "-uall", "-z"],
        None,
        true,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_stdout_complete("status")?;
    let parsed = parse_porcelain_v2_z(&out);
    let state = detect_repo_state(ssh, &repo.git_dir_loc).await?;
    Ok(Some(ScmStatus {
        root: repo.root_str,
        git_dir: repo.git_dir_str,
        branch: parsed.branch,
        head_oid: parsed.head_oid,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        state,
        staged: parsed.staged,
        unstaged: parsed.unstaged,
        untracked: parsed.untracked,
        conflicted: parsed.conflicted,
    }))
}

/// Diff for a single file (unstaged, staged, untracked, commit, or stash).
#[tauri::command]
pub async fn scm_diff(
    ssh: State<'_, SshManager>,
    path: String,
    file_path: String,
    mode: ScmDiffMode,
    commit_hash: Option<String>,
    old_path: Option<String>,
) -> Result<ScmDiff, String> {
    scm_diff_inner(
        &ssh,
        &path,
        &file_path,
        mode,
        commit_hash.as_deref(),
        old_path.as_deref(),
    )
    .await
}

pub(crate) async fn scm_diff_inner(
    ssh: &SshManager,
    path: &str,
    file_path: &str,
    mode: ScmDiffMode,
    commit_hash: Option<&str>,
    old_path: Option<&str>,
) -> Result<ScmDiff, String> {
    let repo = require_repo(ssh, path).await?;
    validate_rel_path(file_path)?;
    if let Some(old) = old_path {
        validate_rel_path(old)?;
    }

    match mode {
        ScmDiffMode::Unstaged => {
            let out = run_git(
                ssh,
                &repo.root_loc,
                &[
                    "diff",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "-U3",
                    "--",
                    file_path,
                ],
                None,
                true,
                LOCAL_TIMEOUT,
            )
            .await?;
            let truncated = out.truncated;
            let bytes = out.ok_stdout("diff")?;
            Ok(parse_unified_diff(file_path, &bytes, truncated))
        }
        ScmDiffMode::Staged => {
            let mut args = vec![
                "diff",
                "--cached",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "-M",
                "-U3",
                "--",
            ];
            if let Some(old) = old_path {
                args.push(old);
            }
            args.push(file_path);
            let out = run_git(ssh, &repo.root_loc, &args, None, true, LOCAL_TIMEOUT).await?;
            let truncated = out.truncated;
            let bytes = out.ok_stdout("diff --cached")?;
            Ok(parse_unified_diff(file_path, &bytes, truncated))
        }
        ScmDiffMode::Untracked => {
            let bytes = match (&repo.root_loc, &repo.git_dir_loc) {
                (Location::Local(root), Location::Local(git_dir)) => {
                    let root = root.clone();
                    let git_dir = git_dir.clone();
                    let rel = file_path.to_string();
                    tokio::task::spawn_blocking(move || {
                        read_confined_local_untracked(&root, &git_dir, &rel)
                    })
                    .await
                    .map_err(|e| format!("background task failed: {e}"))??
                }
                (
                    Location::Remote { remote_id, path: root_p },
                    Location::Remote { path: git_dir_p, .. },
                ) => {
                    ssh.git_read_untracked(
                        remote_id,
                        root_p,
                        git_dir_p,
                        file_path,
                        MAX_UNTRACKED_DIFF_BYTES,
                    )
                    .await?
                }
                _ => return Err("internal error: mismatched repo/git_dir locations".into()),
            };
            Ok(synthesize_untracked_diff(file_path, &bytes))
        }
        ScmDiffMode::Commit => {
            let hash = commit_hash.ok_or_else(|| "commitHash is required".to_string())?;
            validate_hash(hash)?;
            // `-m --first-parent` matches `scm_commit_files_inner` for merge commits
            // while still showing full diffs for regular and root commits.
            let mut args = vec![
                "show",
                "--format=",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "-M",
                "-m",
                "--first-parent",
                "-U3",
                hash,
                "--",
            ];
            if let Some(old) = old_path {
                args.push(old);
            }
            args.push(file_path);
            let out = run_git(ssh, &repo.root_loc, &args, None, true, LOCAL_TIMEOUT).await?;
            let truncated = out.truncated;
            let bytes = out.ok_stdout("show")?;
            Ok(parse_unified_diff(file_path, &bytes, truncated))
        }
        ScmDiffMode::Stash => {
            let stash_ref = commit_hash.unwrap_or("stash@{0}");
            validate_stash_ref(stash_ref)?;
            let parent_ref = format!("{stash_ref}^1");
            let mut args = vec![
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "-M",
                "-U3",
                &parent_ref,
                stash_ref,
                "--",
            ];
            if let Some(old) = old_path {
                args.push(old);
            }
            args.push(file_path);
            let out = run_git(ssh, &repo.root_loc, &args, None, true, LOCAL_TIMEOUT).await?;
            let truncated = out.truncated;
            let bytes = out.ok_stdout("stash diff")?;
            if !bytes.is_empty() {
                return Ok(parse_unified_diff(file_path, &bytes, truncated));
            }
            // Untracked files saved in a stash live on its 3rd parent (`stash@{N}^3`).
            let untracked_parent = format!("{stash_ref}^3");
            let has_u = run_git(
                ssh,
                &repo.root_loc,
                &["rev-parse", "--verify", "-q", &untracked_parent],
                None,
                true,
                LOCAL_TIMEOUT,
            )
            .await
            .is_ok_and(|o| o.code == 0);
            if has_u {
                let u_out = run_git(
                    ssh,
                    &repo.root_loc,
                    &[
                        "show",
                        "--format=",
                        "--no-color",
                        "--no-ext-diff",
                        "--no-textconv",
                        "-U3",
                        &untracked_parent,
                        "--",
                        file_path,
                    ],
                    None,
                    true,
                    LOCAL_TIMEOUT,
                )
                .await?;
                let u_trunc = u_out.truncated;
                let u_bytes = u_out.ok_stdout("stash untracked diff")?;
                return Ok(parse_unified_diff(file_path, &u_bytes, u_trunc));
            }
            Ok(parse_unified_diff(file_path, &bytes, truncated))
        }
    }
}

fn validate_stash_ref(r: &str) -> Result<(), String> {
    let ok = r
        .strip_prefix("stash@{")
        .and_then(|s| s.strip_suffix('}'))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    if ok {
        Ok(())
    } else {
        Err(format!("invalid stash reference: {r}"))
    }
}

/// Stages specific relative paths, or all changes when `files` is empty.
#[tauri::command]
pub async fn scm_stage(
    ssh: State<'_, SshManager>,
    path: String,
    files: Vec<String>,
) -> Result<(), String> {
    scm_stage_inner(&ssh, &path, &files).await
}

pub(crate) async fn scm_stage_inner(
    ssh: &SshManager,
    path: &str,
    files: &[String],
) -> Result<(), String> {
    let repo = require_repo(ssh, path).await?;
    if files.is_empty() {
        run_git(ssh, &repo.root_loc, &["add", "-A"], None, false, LOCAL_TIMEOUT)
            .await?
            .ok_stdout("add")?;
        return Ok(());
    }
    for f in files {
        validate_rel_path(f)?;
    }
    let mut args = vec!["add", "-A", "--"];
    for f in files {
        args.push(f.as_str());
    }
    run_git(ssh, &repo.root_loc, &args, None, false, LOCAL_TIMEOUT)
        .await?
        .ok_stdout("add")?;
    Ok(())
}

/// Unstages specific relative paths, or all staged changes when `files` is empty.
/// Preserves `MERGE_HEAD` during merges and handles modified index entries on
/// unborn branches cleanly without touching working-tree files.
#[tauri::command]
pub async fn scm_unstage(
    ssh: State<'_, SshManager>,
    path: String,
    files: Vec<String>,
) -> Result<(), String> {
    scm_unstage_inner(&ssh, &path, &files).await
}

pub(crate) async fn scm_unstage_inner(
    ssh: &SshManager,
    path: &str,
    files: &[String],
) -> Result<(), String> {
    let repo = require_repo(ssh, path).await?;
    for f in files {
        validate_rel_path(f)?;
    }
    match inspect_head(ssh, &repo.root_loc).await? {
        HeadState::Commit => {
            // Always supply a pathspec (`.` for Unstage All) so Git does an
            // index-only reset and never clears MERGE_HEAD during a merge.
            let mut args = vec!["reset", "-q", "HEAD", "--"];
            if files.is_empty() {
                args.push(".");
            } else {
                for f in files {
                    args.push(f.as_str());
                }
            }
            run_git(ssh, &repo.root_loc, &args, None, false, LOCAL_TIMEOUT)
                .await?
                .ok_stdout("reset")?;
        }
        HeadState::Unborn => {
            // `--cached -f` removes only index entries (even if edited again in
            // the working tree) and never deletes working-tree files.
            let mut args = vec!["rm", "--cached", "-r", "-f", "-q", "--"];
            if files.is_empty() {
                args.push(".");
            } else {
                for f in files {
                    args.push(f.as_str());
                }
            }
            run_git(ssh, &repo.root_loc, &args, None, false, LOCAL_TIMEOUT)
                .await?
                .ok_stdout("rm --cached")?;
        }
    }
    Ok(())
}

/// Discards working tree changes for tracked `files` and removes `untracked`
/// files after re-verifying they are still untracked (moving local untracked
/// files to Trash; unlinking confined remote untracked files).
#[tauri::command]
pub async fn scm_discard(
    ssh: State<'_, SshManager>,
    path: String,
    files: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), String> {
    scm_discard_inner(&ssh, &path, &files, &untracked).await
}

pub(crate) async fn scm_discard_inner(
    ssh: &SshManager,
    path: &str,
    files: &[String],
    untracked: &[String],
) -> Result<(), String> {
    let repo = require_repo(ssh, path).await?;
    for f in files {
        validate_rel_path(f)?;
    }
    for u in untracked {
        validate_rel_path(u)?;
    }
    if !files.is_empty() {
        let mut args = vec!["checkout", "--"];
        for f in files {
            args.push(f.as_str());
        }
        run_git(ssh, &repo.root_loc, &args, None, false, LOCAL_TIMEOUT)
            .await?
            .ok_stdout("checkout")?;
    }
    if !untracked.is_empty() {
        // Re-verify each path is STILL untracked right now before removing anything.
        let mut st_args = vec!["status", "--porcelain=v2", "-uall", "-z", "--"];
        for u in untracked {
            st_args.push(u.as_str());
        }
        let st_bytes = run_git(ssh, &repo.root_loc, &st_args, None, true, LOCAL_TIMEOUT)
            .await?
            .ok_stdout_complete("status")?;
        let current_untracked: HashSet<String> = parse_porcelain_v2_z(&st_bytes)
            .untracked
            .into_iter()
            .map(|c| c.path)
            .collect();
        let eligible: Vec<String> = untracked
            .iter()
            .filter(|u| current_untracked.contains(u.as_str()))
            .cloned()
            .collect();
        if eligible.is_empty() {
            return Ok(());
        }

        match (&repo.root_loc, &repo.git_dir_loc) {
            (Location::Local(root), Location::Local(git_dir)) => {
                let root = root.clone();
                let git_dir = git_dir.clone();
                tokio::task::spawn_blocking(move || {
                    trash_confined_local_untracked(&root, &git_dir, &eligible)
                })
                .await
                .map_err(|e| format!("background task failed: {e}"))??;
            }
            (
                Location::Remote { remote_id, path: root_p },
                Location::Remote { path: git_dir_p, .. },
            ) => {
                ssh.git_remove_untracked(remote_id, root_p, git_dir_p, &eligible)
                    .await?;
            }
            _ => return Err("internal error: mismatched repo/git_dir locations".into()),
        }
    }
    Ok(())
}

/// Applies a unified diff patch for hunk-level staging (`cached = true`),
/// unstaging (`cached = true, reverse = true`), or reverting (`cached = false, reverse = true`).
#[tauri::command]
pub async fn scm_apply_patch(
    ssh: State<'_, SshManager>,
    path: String,
    patch: String,
    cached: bool,
    reverse: bool,
) -> Result<(), String> {
    scm_apply_patch_inner(&ssh, &path, &patch, cached, reverse).await
}

pub(crate) async fn scm_apply_patch_inner(
    ssh: &SshManager,
    path: &str,
    patch: &str,
    cached: bool,
    reverse: bool,
) -> Result<(), String> {
    let repo = require_repo(ssh, path).await?;
    if patch.trim().is_empty() {
        return Err("empty patch".into());
    }
    let mut args = vec!["apply", "--unidiff-zero", "--recount"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("-R");
    }
    args.push("-");
    run_git(
        ssh,
        &repo.root_loc,
        &args,
        Some(patch.as_bytes()),
        false,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_stdout("apply")?;
    Ok(())
}

/// Creates a commit with `message` (piped over stdin via `-F -`).
/// Returns the new commit's short hash.
#[tauri::command]
pub async fn scm_commit(
    ssh: State<'_, SshManager>,
    path: String,
    message: String,
    amend: bool,
    stage_all: bool,
) -> Result<String, String> {
    scm_commit_inner(&ssh, &path, &message, amend, stage_all).await
}

pub(crate) async fn scm_commit_inner(
    ssh: &SshManager,
    path: &str,
    message: &str,
    amend: bool,
    stage_all: bool,
) -> Result<String, String> {
    let repo = require_repo(ssh, path).await?;
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty".into());
    }
    if stage_all {
        run_git(ssh, &repo.root_loc, &["add", "-A"], None, false, LOCAL_TIMEOUT)
            .await?
            .ok_stdout("add")?;
    }
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    run_git(
        ssh,
        &repo.root_loc,
        &args,
        Some(message.as_bytes()),
        false,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_stdout("commit")?;
    let hash = run_git(
        ssh,
        &repo.root_loc,
        &["rev-parse", "--short", "HEAD"],
        None,
        true,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_text("rev-parse")?;
    Ok(hash)
}

/// Soft-resets the last commit (`git reset --soft HEAD~1`, or safely removes
/// an attached branch ref with expected old OID only when the commit object
/// itself has zero parent headers), returning its commit message.
#[tauri::command]
pub async fn scm_undo_last_commit(
    ssh: State<'_, SshManager>,
    path: String,
) -> Result<String, String> {
    scm_undo_last_commit_inner(&ssh, &path).await
}

pub(crate) async fn scm_undo_last_commit_inner(
    ssh: &SshManager,
    path: &str,
) -> Result<String, String> {
    let repo = require_repo(ssh, path).await?;
    // Capture the exact HEAD OID and optional symbolic branch ref up front so
    // every inspection and the final compare-and-swap operate on the same commit.
    let head_oid = strip_single_newline(
        &run_git(
            ssh,
            &repo.root_loc,
            &["rev-parse", "--verify", "HEAD"],
            None,
            true,
            LOCAL_TIMEOUT,
        )
        .await?
        .ok_stdout_complete("rev-parse HEAD")?,
    )?;
    validate_hash(&head_oid)?;

    let sym = run_git(
        ssh,
        &repo.root_loc,
        &["symbolic-ref", "-q", "HEAD"],
        None,
        true,
        LOCAL_TIMEOUT,
    )
    .await?;
    let branch_ref = if sym.code == 0 {
        Some(strip_single_newline(&sym.stdout)?)
    } else {
        None
    };

    let msg = run_git(
        ssh,
        &repo.root_loc,
        &["log", "-1", "--format=%B", &head_oid],
        None,
        true,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_text("log")?;

    // Inspect the exact commit object's parent header lines (safe in shallow clones!).
    let raw_obj = run_git(
        ssh,
        &repo.root_loc,
        &["cat-file", "-p", &head_oid],
        None,
        true,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_stdout_complete("cat-file")?;
    let obj_text = String::from_utf8_lossy(&raw_obj);
    let first_parent = obj_text
        .lines()
        .take_while(|line| !line.is_empty())
        .find_map(|line| line.strip_prefix("parent "))
        .map(str::trim)
        .map(str::to_string);

    if let Some(parent_oid) = first_parent {
        validate_hash(&parent_oid)?;
        let reason = format!("reset: moving to {parent_oid}");
        if let Some(ref b_ref) = branch_ref {
            run_git(
                ssh,
                &repo.root_loc,
                &["update-ref", "-m", &reason, b_ref, &parent_oid, &head_oid],
                None,
                false,
                LOCAL_TIMEOUT,
            )
            .await?
            .ok_stdout("update-ref")?;
        } else {
            run_git(
                ssh,
                &repo.root_loc,
                &[
                    "update-ref",
                    "--no-deref",
                    "-m",
                    &reason,
                    "HEAD",
                    &parent_oid,
                    &head_oid,
                ],
                None,
                false,
                LOCAL_TIMEOUT,
            )
            .await?
            .ok_stdout("update-ref")?;
        }
    } else {
        let Some(ref b_ref) = branch_ref else {
            return Err("Cannot undo root commit while HEAD is detached".into());
        };
        run_git(
            ssh,
            &repo.root_loc,
            &["update-ref", "-d", b_ref, &head_oid],
            None,
            false,
            LOCAL_TIMEOUT,
        )
        .await?
        .ok_stdout("update-ref")?;
    }
    Ok(msg)
}

/// Lists local and remote branches with tracking counts and latest commit info.
#[tauri::command]
pub async fn scm_branches(
    ssh: State<'_, SshManager>,
    path: String,
) -> Result<Vec<ScmBranch>, String> {
    scm_branches_inner(&ssh, &path).await
}

pub(crate) async fn scm_branches_inner(
    ssh: &SshManager,
    path: &str,
) -> Result<Vec<ScmBranch>, String> {
    let repo = require_repo(ssh, path).await?;
    let out = run_git(
        ssh,
        &repo.root_loc,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(HEAD)%00%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)%00%(subject)%00%(committerdate:unix)%00",
            "refs/heads",
            "refs/remotes",
        ],
        None,
        true,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_stdout_complete("for-each-ref")?;
    Ok(parse_branches_z(&out))
}

/// Switches to an existing branch/commit, or creates and switches to a new branch.
/// Uses trailing `--` so git never interprets a missing branch name as a file checkout.
#[tauri::command]
pub async fn scm_checkout(
    ssh: State<'_, SshManager>,
    path: String,
    ref_name: String,
    create: bool,
    start_point: Option<String>,
) -> Result<(), String> {
    scm_checkout_inner(&ssh, &path, &ref_name, create, start_point.as_deref()).await
}

pub(crate) async fn scm_checkout_inner(
    ssh: &SshManager,
    path: &str,
    ref_name: &str,
    create: bool,
    start_point: Option<&str>,
) -> Result<(), String> {
    let repo = require_repo(ssh, path).await?;
    validate_ref_name(ref_name)?;
    if let Some(sp) = start_point {
        validate_ref_name(sp)?;
    }
    let mut args = vec!["checkout"];
    if create {
        args.push("-b");
        args.push(ref_name);
        if let Some(sp) = start_point {
            args.push(sp);
        }
        args.push("--");
    } else {
        let is_remote = run_git(
            ssh,
            &repo.root_loc,
            &["show-ref", "--verify", "-q", &format!("refs/remotes/{ref_name}")],
            None,
            true,
            LOCAL_TIMEOUT,
        )
        .await
        .is_ok_and(|o| o.code == 0);
        if is_remote {
            let local_guess = ref_name.split_once('/').map(|(_, b)| b).unwrap_or(ref_name);
            validate_ref_name(local_guess)?;
            let local_exists = run_git(
                ssh,
                &repo.root_loc,
                &["show-ref", "--verify", "-q", &format!("refs/heads/{local_guess}")],
                None,
                true,
                LOCAL_TIMEOUT,
            )
            .await
            .is_ok_and(|o| o.code == 0);
            if local_exists {
                args.push(local_guess);
            } else {
                args.push("--track");
                args.push(ref_name);
            }
            args.push("--");
        } else {
            args.push(ref_name);
            args.push("--");
        }
    }
    run_git(ssh, &repo.root_loc, &args, None, false, LOCAL_TIMEOUT)
        .await?
        .ok_stdout("checkout")?;
    Ok(())
}

/// Deletes a local branch (`-d`, or `-D` when `force = true`).
#[tauri::command]
pub async fn scm_delete_branch(
    ssh: State<'_, SshManager>,
    path: String,
    name: String,
    force: bool,
) -> Result<(), String> {
    scm_delete_branch_inner(&ssh, &path, &name, force).await
}

pub(crate) async fn scm_delete_branch_inner(
    ssh: &SshManager,
    path: &str,
    name: &str,
    force: bool,
) -> Result<(), String> {
    let repo = require_repo(ssh, path).await?;
    validate_ref_name(name)?;
    let flag = if force { "-D" } else { "-d" };
    run_git(
        ssh,
        &repo.root_loc,
        &["branch", flag, "--", name],
        None,
        false,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_stdout("branch")?;
    Ok(())
}

/// Renames a local branch (`git branch -m <old> <new>`).
#[tauri::command]
pub async fn scm_rename_branch(
    ssh: State<'_, SshManager>,
    path: String,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let repo = require_repo(&ssh, &path).await?;
    validate_ref_name(&old_name)?;
    validate_ref_name(&new_name)?;
    run_git(
        &ssh,
        &repo.root_loc,
        &["branch", "-m", "--", &old_name, &new_name],
        None,
        false,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_stdout("branch -m")?;
    Ok(())
}

/// Merges `branch` into the current branch.
#[tauri::command]
pub async fn scm_merge(
    ssh: State<'_, SshManager>,
    path: String,
    branch: String,
) -> Result<String, String> {
    scm_merge_inner(&ssh, &path, &branch).await
}

pub(crate) async fn scm_merge_inner(
    ssh: &SshManager,
    path: &str,
    branch: &str,
) -> Result<String, String> {
    let repo = require_repo(ssh, path).await?;
    validate_ref_name(branch)?;
    run_git(
        ssh,
        &repo.root_loc,
        &["merge", "--", branch],
        None,
        false,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_text("merge")
}

/// Aborts an in-progress merge, rebase, cherry-pick, or revert.
#[tauri::command]
pub async fn scm_abort(ssh: State<'_, SshManager>, path: String) -> Result<(), String> {
    scm_abort_inner(&ssh, &path).await
}

pub(crate) async fn scm_abort_inner(ssh: &SshManager, path: &str) -> Result<(), String> {
    let repo = require_repo(ssh, path).await?;
    let state = detect_repo_state(ssh, &repo.git_dir_loc).await?;
    let args: &[&str] = match state {
        ScmRepoState::Merging => &["merge", "--abort"],
        ScmRepoState::Rebasing => &["rebase", "--abort"],
        ScmRepoState::CherryPicking => &["cherry-pick", "--abort"],
        ScmRepoState::Reverting => &["revert", "--abort"],
        ScmRepoState::Bisecting => &["bisect", "reset"],
        ScmRepoState::Normal => return Ok(()),
    };
    run_git(ssh, &repo.root_loc, args, None, false, LOCAL_TIMEOUT)
        .await?
        .ok_stdout("abort")?;
    Ok(())
}

/// Fetches from configured remotes (`--all`, optionally `--prune`).
#[tauri::command]
pub async fn scm_fetch(
    ssh: State<'_, SshManager>,
    path: String,
    remote: Option<String>,
    prune: bool,
) -> Result<String, String> {
    let repo = require_repo(&ssh, &path).await?;
    let mut args = vec!["fetch"];
    if prune {
        args.push("--prune");
    }
    if let Some(ref r) = remote {
        validate_remote_name(r)?;
        // Only fetch from a remote explicitly configured in this repository.
        let configured = run_git(&ssh, &repo.root_loc, &["remote"], None, true, LOCAL_TIMEOUT)
            .await?
            .ok_stdout_complete("remote")?;
        let configured_text = String::from_utf8_lossy(&configured);
        if !configured_text.lines().any(|line| line.trim() == r.as_str()) {
            return Err(format!("Remote '{r}' is not configured in this repository"));
        }
        args.push(r.as_str());
    } else {
        args.push("--all");
    }
    run_git(&ssh, &repo.root_loc, &args, None, false, NETWORK_TIMEOUT)
        .await?
        .ok_text("fetch")
}

/// Pulls from upstream (merge or `--rebase`).
#[tauri::command]
pub async fn scm_pull(
    ssh: State<'_, SshManager>,
    path: String,
    rebase: bool,
) -> Result<String, String> {
    let repo = require_repo(&ssh, &path).await?;
    let args: &[&str] = if rebase {
        &["pull", "--rebase"]
    } else {
        &["pull"]
    };
    run_git(&ssh, &repo.root_loc, args, None, false, NETWORK_TIMEOUT)
        .await?
        .ok_text("pull")
}

/// Pushes current branch to upstream (or sets upstream on `origin` when
/// `set_upstream` is true).
#[tauri::command]
pub async fn scm_push(
    ssh: State<'_, SshManager>,
    path: String,
    set_upstream: bool,
    force_with_lease: bool,
) -> Result<String, String> {
    let repo = require_repo(&ssh, &path).await?;
    let mut args = vec!["push"];
    if force_with_lease {
        args.push("--force-with-lease");
    }
    let branch_owned: String;
    if set_upstream {
        let cur = run_git(
            &ssh,
            &repo.root_loc,
            &["symbolic-ref", "--short", "HEAD"],
            None,
            true,
            LOCAL_TIMEOUT,
        )
        .await?
        .ok_text("symbolic-ref")?;
        validate_ref_name(&cur)?;
        branch_owned = cur;
        let remotes_raw = run_git(&ssh, &repo.root_loc, &["remote"], None, true, LOCAL_TIMEOUT)
            .await?
            .ok_text("remote")?;
        let remotes: Vec<&str> = remotes_raw
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        let remote = if remotes.contains(&"origin") {
            "origin"
        } else {
            remotes
                .first()
                .copied()
                .ok_or_else(|| "No git remote configured".to_string())?
        };
        validate_remote_name(remote)?;
        args.push("-u");
        args.push(remote);
        args.push(branch_owned.as_str());
        return run_git(&ssh, &repo.root_loc, &args, None, false, NETWORK_TIMEOUT)
            .await?
            .ok_text("push");
    }
    run_git(&ssh, &repo.root_loc, &args, None, false, NETWORK_TIMEOUT)
        .await?
        .ok_text("push")
}

/// Commit history with parent hashes and full-namespace ref decorations.
#[tauri::command]
pub async fn scm_log(
    ssh: State<'_, SshManager>,
    path: String,
    limit: usize,
    skip: usize,
    all: bool,
) -> Result<Vec<ScmCommit>, String> {
    scm_log_inner(&ssh, &path, limit, skip, all).await
}

pub(crate) async fn scm_log_inner(
    ssh: &SshManager,
    path: &str,
    limit: usize,
    skip: usize,
    all: bool,
) -> Result<Vec<ScmCommit>, String> {
    let repo = require_repo(ssh, path).await?;
    if !all && matches!(inspect_head(ssh, &repo.root_loc).await?, HeadState::Unborn) {
        return Ok(Vec::new());
    }
    let capped = limit.clamp(1, 500);
    let max_arg = format!("--max-count={capped}");
    let skip_arg = format!("--skip={skip}");
    let mut args = vec![
        "log",
        "--topo-order",
        "--decorate=full",
        &max_arg,
        &skip_arg,
        "--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b%x00%D%x00",
    ];
    if all {
        args.push("--all");
    }
    let out = run_git(ssh, &repo.root_loc, &args, None, true, LOCAL_TIMEOUT).await?;
    if out.code != 0 && all && out.stderr.contains("does not have any commits yet") {
        return Ok(Vec::new());
    }
    let bytes = out.ok_stdout_complete("log")?;
    Ok(parse_log_z(&bytes))
}

/// Changed files with line stats for a specific commit hash.
#[tauri::command]
pub async fn scm_commit_files(
    ssh: State<'_, SshManager>,
    path: String,
    hash: String,
) -> Result<Vec<ScmCommitFile>, String> {
    scm_commit_files_inner(&ssh, &path, &hash).await
}

pub(crate) async fn scm_commit_files_inner(
    ssh: &SshManager,
    path: &str,
    hash: &str,
) -> Result<Vec<ScmCommitFile>, String> {
    let repo = require_repo(ssh, path).await?;
    validate_hash(hash)?;
    let ns_args = ["show", "--format=", "--name-status", "-z", "-M", "-m", "--first-parent", hash];
    let num_args = ["show", "--format=", "--numstat", "-z", "-M", "-m", "--first-parent", hash];
    let (ns_out, num_out) = tokio::try_join!(
        run_git(ssh, &repo.root_loc, &ns_args, None, true, LOCAL_TIMEOUT),
        run_git(ssh, &repo.root_loc, &num_args, None, true, LOCAL_TIMEOUT),
    )?;
    let ns_bytes = ns_out.ok_stdout_complete("show --name-status")?;
    let num_bytes = num_out.ok_stdout_complete("show --numstat")?;
    Ok(parse_commit_files(&ns_bytes, &num_bytes))
}

/// Lists all stashes.
#[tauri::command]
pub async fn scm_stashes(
    ssh: State<'_, SshManager>,
    path: String,
) -> Result<Vec<ScmStash>, String> {
    scm_stashes_inner(&ssh, &path).await
}

pub(crate) async fn scm_stashes_inner(
    ssh: &SshManager,
    path: &str,
) -> Result<Vec<ScmStash>, String> {
    let repo = require_repo(ssh, path).await?;
    let out = run_git(
        ssh,
        &repo.root_loc,
        &["stash", "list", "--format=%gd%x00%at%x00%gs%x00"],
        None,
        true,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_stdout_complete("stash list")?;
    Ok(parse_stashes_z(&out))
}

/// Lists files changed in a stash entry (`stash@{index}`).
#[tauri::command]
pub async fn scm_stash_files(
    ssh: State<'_, SshManager>,
    path: String,
    index: usize,
) -> Result<Vec<ScmCommitFile>, String> {
    let repo = require_repo(&ssh, &path).await?;
    let stash_ref = format!("stash@{{{index}}}");
    let ns_args = ["stash", "show", "--include-untracked", "--name-status", "-z", &stash_ref];
    let num_args = ["stash", "show", "--include-untracked", "--numstat", "-z", &stash_ref];
    let (ns_out, num_out) = tokio::try_join!(
        run_git(&ssh, &repo.root_loc, &ns_args, None, true, LOCAL_TIMEOUT),
        run_git(&ssh, &repo.root_loc, &num_args, None, true, LOCAL_TIMEOUT),
    )?;
    let ns_bytes = ns_out.ok_stdout_complete("stash show")?;
    let num_bytes = num_out.ok_stdout_complete("stash show")?;
    Ok(parse_commit_files(&ns_bytes, &num_bytes))
}

/// Creates a new stash.
#[tauri::command]
pub async fn scm_stash_push(
    ssh: State<'_, SshManager>,
    path: String,
    message: Option<String>,
    include_untracked: bool,
    staged_only: bool,
) -> Result<(), String> {
    scm_stash_push_inner(&ssh, &path, message.as_deref(), include_untracked, staged_only).await
}

pub(crate) async fn scm_stash_push_inner(
    ssh: &SshManager,
    path: &str,
    message: Option<&str>,
    include_untracked: bool,
    staged_only: bool,
) -> Result<(), String> {
    let repo = require_repo(ssh, path).await?;
    let mut args = vec!["stash", "push"];
    if include_untracked && !staged_only {
        args.push("--include-untracked");
    }
    if staged_only {
        args.push("--staged");
    }
    if let Some(msg) = message.map(str::trim).filter(|m| !m.is_empty()) {
        args.push("-m");
        args.push(msg);
    }
    run_git(ssh, &repo.root_loc, &args, None, false, LOCAL_TIMEOUT)
        .await?
        .ok_stdout("stash push")?;
    Ok(())
}

/// Applies or pops `stash@{index}`.
#[tauri::command]
pub async fn scm_stash_apply(
    ssh: State<'_, SshManager>,
    path: String,
    index: usize,
    pop: bool,
) -> Result<(), String> {
    scm_stash_apply_inner(&ssh, &path, index, pop).await
}

pub(crate) async fn scm_stash_apply_inner(
    ssh: &SshManager,
    path: &str,
    index: usize,
    pop: bool,
) -> Result<(), String> {
    let repo = require_repo(ssh, path).await?;
    let stash_ref = format!("stash@{{{index}}}");
    let sub = if pop { "pop" } else { "apply" };
    run_git(
        ssh,
        &repo.root_loc,
        &["stash", sub, &stash_ref],
        None,
        false,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_stdout(sub)?;
    Ok(())
}

/// Drops `stash@{index}`.
#[tauri::command]
pub async fn scm_stash_drop(
    ssh: State<'_, SshManager>,
    path: String,
    index: usize,
) -> Result<(), String> {
    scm_stash_drop_inner(&ssh, &path, index).await
}

pub(crate) async fn scm_stash_drop_inner(
    ssh: &SshManager,
    path: &str,
    index: usize,
) -> Result<(), String> {
    let repo = require_repo(ssh, path).await?;
    let stash_ref = format!("stash@{{{index}}}");
    run_git(
        ssh,
        &repo.root_loc,
        &["stash", "drop", &stash_ref],
        None,
        false,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_stdout("stash drop")?;
    Ok(())
}

/// Initializes a new Git repository at `path`.
#[tauri::command]
pub async fn scm_init(ssh: State<'_, SshManager>, path: String) -> Result<(), String> {
    scm_init_inner(&ssh, &path).await
}

pub(crate) async fn scm_init_inner(ssh: &SshManager, path: &str) -> Result<(), String> {
    let loc = Location::parse(path)?;
    if let Location::Local(ref p) = loc
        && !Path::new(p).is_dir()
    {
        return Err(format!("{} is not a directory", p.display()));
    }
    run_git(ssh, &loc, &["init"], None, false, LOCAL_TIMEOUT)
        .await?
        .ok_stdout("init")?;
    Ok(())
}

/// Resolves a merge conflict by picking `--ours` or `--theirs` (handling
/// modify/delete conflicts where the chosen side deleted the file!).
#[tauri::command]
pub async fn scm_resolve_conflict(
    ssh: State<'_, SshManager>,
    path: String,
    file_path: String,
    strategy: ConflictStrategy,
) -> Result<(), String> {
    scm_resolve_conflict_inner(&ssh, &path, &file_path, strategy).await
}

pub(crate) async fn scm_resolve_conflict_inner(
    ssh: &SshManager,
    path: &str,
    file_path: &str,
    strategy: ConflictStrategy,
) -> Result<(), String> {
    let repo = require_repo(ssh, path).await?;
    validate_rel_path(file_path)?;

    // Check which unmerged index stages exist (`2` = ours, `3` = theirs).
    let unmerged = run_git(
        ssh,
        &repo.root_loc,
        &["ls-files", "-u", "-z", "--", file_path],
        None,
        true,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_stdout_complete("ls-files -u")?;
    let wanted_stage = match strategy {
        ConflictStrategy::Ours => "2",
        ConflictStrategy::Theirs => "3",
    };
    let stages: Vec<String> = unmerged
        .split(|&b| b == 0)
        .filter(|tok| !tok.is_empty())
        .filter_map(|tok| {
            // Format: "<mode> <oid> <stage>\t<path>"
            // Require exact path equality so passing a directory never matches descendant conflicts.
            let s = std::str::from_utf8(tok).ok()?;
            let (hdr, entry_path) = s.split_once('\t')?;
            if entry_path != file_path {
                return None;
            }
            hdr.split_whitespace().nth(2).map(str::to_string)
        })
        .collect();
    if stages.is_empty() {
        return Err(format!("{file_path} has no unresolved merge conflict"));
    }
    let has_chosen_side = stages.iter().any(|st| st == wanted_stage);

    if !has_chosen_side {
        // The chosen side deleted the file: stage its deletion cleanly.
        run_git(
            ssh,
            &repo.root_loc,
            &["rm", "-f", "--", file_path],
            None,
            false,
            LOCAL_TIMEOUT,
        )
        .await?
        .ok_stdout("rm")?;
        return Ok(());
    }

    let flag = match strategy {
        ConflictStrategy::Ours => "--ours",
        ConflictStrategy::Theirs => "--theirs",
    };
    run_git(
        ssh,
        &repo.root_loc,
        &["checkout", flag, "--", file_path],
        None,
        false,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_stdout("checkout")?;
    run_git(
        ssh,
        &repo.root_loc,
        &["add", "--", file_path],
        None,
        false,
        LOCAL_TIMEOUT,
    )
    .await?
    .ok_stdout("add")?;
    Ok(())
}
