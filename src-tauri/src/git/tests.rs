use std::fs;
use std::path::Path;

use crate::ssh::SshManager;

use super::commands::{
    scm_abort_inner, scm_apply_patch_inner, scm_branches_inner, scm_checkout_inner,
    scm_commit_files_inner, scm_commit_inner, scm_delete_branch_inner, scm_diff_inner,
    scm_discard_inner, scm_init_inner, scm_log_inner, scm_merge_inner, scm_resolve_conflict_inner,
    scm_stage_inner, scm_stash_apply_inner, scm_stash_drop_inner, scm_stash_push_inner,
    scm_stashes_inner, scm_status_inner, scm_undo_last_commit_inner, scm_unstage_inner,
};
use super::exec::{
    LOCAL_TIMEOUT, run_git_local, validate_hash, validate_ref_name, validate_rel_path,
    validate_remote_name,
};
use super::parse::{
    parse_branches_z, parse_commit_files, parse_log_z, parse_porcelain_v2_z, parse_stashes_z,
    parse_unified_diff, synthesize_untracked_diff,
};
use super::types::{
    ConflictStrategy, ScmChangeKind, ScmDiffLineKind, ScmDiffMode, ScmRefKind, ScmRepoState,
};

async fn git(dir: &Path, args: &[&str]) {
    let out = run_git_local(dir, args, None, false, LOCAL_TIMEOUT)
        .await
        .unwrap();
    assert_eq!(out.code, 0, "git {:?} failed: {}", args, out.stderr);
}

async fn make_repo() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git(d, &["init", "-b", "main"]).await;
    git(d, &["config", "user.name", "Midterm Tester"]).await;
    git(d, &["config", "user.email", "test@midterm.dev"]).await;
    git(d, &["config", "commit.gpgsign", "false"]).await;
    fs::write(d.join("README.md"), "# Demo\nline 2\nline 3\n").unwrap();
    fs::write(d.join("app.ts"), "export const v = 1;\nconsole.log(v);\n").unwrap();
    git(d, &["add", "-A"]).await;
    git(d, &["commit", "-m", "initial commit"]).await;
    tmp
}

#[test]
fn validators_reject_injection_and_traversal() {
    assert!(validate_ref_name("feature/scm-panel").is_ok());
    assert!(validate_ref_name("main").is_ok());
    for bad in ["", "-f", "--upload-pack=x", "../evil", "a..b", "a b", "foo.lock", "a//b", ".hidden"] {
        assert!(validate_ref_name(bad).is_err(), "should reject ref: {bad}");
    }

    assert!(validate_rel_path("src/main.rs").is_ok());
    assert!(validate_rel_path(".gitignore").is_ok());
    for bad in ["", "/etc/passwd", "../escape", "a/../b", ".git", ".GIT", ".git/config", "a/.GIT/x", "a\0b"] {
        assert!(validate_rel_path(bad).is_err(), "should reject path: {bad}");
    }

    assert!(validate_hash("deadbeef").is_ok());
    assert!(validate_hash("abc").is_err());
    assert!(validate_hash("--option").is_err());

    assert!(validate_remote_name("origin").is_ok());
    for bad in ["-u", "a/b", "host:repo.git", "ext::sh"] {
        assert!(validate_remote_name(bad).is_err(), "should reject remote: {bad}");
    }
}

#[test]
fn parses_porcelain_v2_staged_unstaged_renamed_untracked_and_conflicts() {
    let raw = concat!(
        "# branch.oid 0123456789abcdef\0",
        "# branch.head main\0",
        "# branch.upstream origin/main\0",
        "# branch.ab +3 -1\0",
        "1 MM N... 100644 100644 100644 aaa bbb src/both.ts\0",
        "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts\0src/old.ts\0",
        "u UU N... 100644 100644 100644 100644 a b c conflict.txt\0",
        "? untracked.md\0",
    );
    let parsed = parse_porcelain_v2_z(raw.as_bytes());
    assert_eq!(parsed.branch.as_deref(), Some("main"));
    assert_eq!(parsed.head_oid.as_deref(), Some("0123456789abcdef"));
    assert_eq!(parsed.upstream.as_deref(), Some("origin/main"));
    assert_eq!(parsed.ahead, 3);
    assert_eq!(parsed.behind, 1);
    assert_eq!(parsed.staged.len(), 2);
    assert_eq!(parsed.staged[0].path, "src/both.ts");
    assert_eq!(parsed.staged[0].status, ScmChangeKind::Modified);
    assert_eq!(parsed.staged[1].path, "src/new.ts");
    assert_eq!(parsed.staged[1].orig_path.as_deref(), Some("src/old.ts"));
    assert_eq!(parsed.staged[1].status, ScmChangeKind::Renamed);
    assert_eq!(parsed.unstaged.len(), 1);
    assert_eq!(parsed.unstaged[0].path, "src/both.ts");
    assert_eq!(parsed.conflicted.len(), 1);
    assert_eq!(parsed.conflicted[0].conflict_code.as_deref(), Some("UU"));
    assert_eq!(parsed.untracked.len(), 1);
    assert_eq!(parsed.untracked[0].path, "untracked.md");
}

#[test]
fn parses_unified_diff_preserving_cr_and_untracked_diff() {
    let raw = concat!(
        "diff --git a/app.ts b/app.ts\n",
        "index 111..222 100644\n",
        "--- a/app.ts\n",
        "+++ b/app.ts\n",
        "@@ -1,2 +1,3 @@\n",
        "-export const v = 1;\r\n",
        "+export const v = 2;\n",
        " console.log(v);\n",
        "+console.log('done');\n",
        "\\ No newline at end of file\n",
    );
    let diff = parse_unified_diff("app.ts", raw.as_bytes(), false);
    assert!(!diff.binary);
    assert!(diff.patchable);
    assert_eq!(diff.hunks.len(), 1);
    assert_eq!(diff.hunks[0].lines.len(), 4);
    assert_eq!(diff.hunks[0].lines[0].kind, ScmDiffLineKind::Del);
    assert_eq!(diff.hunks[0].lines[0].content, "export const v = 1;\r");
    assert_eq!(diff.hunks[0].lines[1].content, "export const v = 2;");
    assert!(diff.hunks[0].lines[3].no_newline);

    // Quoted rename path decoding.
    let quoted_rename = concat!(
        "diff --git \"a/old\\tname.txt\" b/new.txt\n",
        "similarity index 100%\n",
        "rename from \"old\\tname.txt\"\n",
        "rename to new.txt\n",
    );
    let ren = parse_unified_diff("new.txt", quoted_rename.as_bytes(), false);
    assert_eq!(ren.old_path.as_deref(), Some("old\tname.txt"));

    // File-to-symlink type change emits two diff sections for the same path.
    let type_change = concat!(
        "diff --git a/link.txt b/link.txt\n",
        "deleted file mode 100644\n",
        "--- a/link.txt\n",
        "+++ /dev/null\n",
        "@@ -1 +0,0 @@\n",
        "-old content\n",
        "diff --git a/link.txt b/link.txt\n",
        "new file mode 120000\n",
        "--- /dev/null\n",
        "+++ b/link.txt\n",
        "@@ -0,0 +1 @@\n",
        "+target.txt\n",
    );
    let tc = parse_unified_diff("link.txt", type_change.as_bytes(), false);
    assert!(tc.type_changed);
    assert!(!tc.is_deleted);
    assert!(!tc.patchable);
    assert_eq!(tc.hunks.len(), 2);

    // Non-UTF-8 diff is marked non_utf8 and non-patchable.
    let bad_utf8 = b"diff --git a/x b/x\n@@ -1 +1 @@\n-\xff\xfe\n+ok\n";
    let nu = parse_unified_diff("x", bad_utf8, false);
    assert!(nu.non_utf8);
    assert!(!nu.patchable);

    let bin = parse_unified_diff("img.png", b"Binary files a/img.png and b/img.png differ\n", false);
    assert!(bin.binary);
    assert!(!bin.patchable);

    let untracked = synthesize_untracked_diff("new.txt", b"hello\nworld\n");
    assert!(untracked.is_new);
    assert!(untracked.patchable);
    assert_eq!(untracked.hunks[0].lines.len(), 2);
    assert!(!untracked.hunks[0].lines[1].no_newline);

    let untracked_bin = synthesize_untracked_diff("raw.bin", b"\x00\x01\x02");
    assert!(untracked_bin.binary);

    let many_newlines = vec![b'\n'; 12_000];
    let capped = synthesize_untracked_diff("huge.txt", &many_newlines);
    assert!(capped.too_large);
    assert!(capped.hunks.is_empty());
    assert!(!capped.patchable);
}

#[test]
fn parses_branches_log_full_decorations_commit_files_and_stashes() {
    // Include a branch whose short refname is disambiguated as `heads/v1` due to a tag named `v1`.
    let b_raw = b"*\0refs/heads/main\0main\0origin/main\0[ahead 2, behind 1]\0abc1234\0Initial\01700000000\0\n \0refs/heads/v1\0heads/v1\0\0\0abc1234\0Initial\01700000000\0\n \0refs/remotes/origin/HEAD\0origin/HEAD\0\0\0abc1234\0Initial\01700000000\0";
    let branches = parse_branches_z(b_raw);
    assert_eq!(branches.len(), 2);
    assert!(branches[0].current);
    assert_eq!(branches[0].name, "main");
    assert_eq!(branches[0].ahead, 2);
    assert_eq!(branches[0].behind, 1);
    assert_eq!(branches[1].name, "v1");

    let log_raw = b"1111111111\01111111\00000000000\0Ada\0ada@dev\01700000010\0feat: hi\0body\x1fline\0HEAD -> refs/heads/main, refs/heads/feature/login, refs/remotes/origin/main, tag: refs/tags/v1.0\0";
    let commits = parse_log_z(log_raw);
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].body, "body\x1fline");
    assert_eq!(commits[0].refs.len(), 4);
    assert_eq!(commits[0].refs[0].kind, ScmRefKind::Head);
    assert_eq!(commits[0].refs[0].name, "main");
    assert_eq!(commits[0].refs[1].kind, ScmRefKind::Branch);
    assert_eq!(commits[0].refs[1].name, "feature/login");
    assert_eq!(commits[0].refs[2].kind, ScmRefKind::Remote);
    assert_eq!(commits[0].refs[2].name, "origin/main");
    assert_eq!(commits[0].refs[3].kind, ScmRefKind::Tag);
    assert_eq!(commits[0].refs[3].name, "v1.0");

    let ns = b"A\0new.ts\0R100\0old.ts\0renamed.ts\0";
    let num = b"10\t0\tnew.ts\02\t1\t\0old.ts\0renamed.ts\0";
    let files = parse_commit_files(ns, num);
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].additions, Some(10));
    assert_eq!(files[1].orig_path.as_deref(), Some("old.ts"));
    assert_eq!(files[1].deletions, Some(1));

    let stashes = parse_stashes_z(b"stash@{0}\0deadbeef12345678\01700000099\0WIP on main: abc1234 work in progress\0");
    assert_eq!(stashes.len(), 1);
    assert_eq!(stashes[0].oid, "deadbeef12345678");
    assert_eq!(stashes[0].branch.as_deref(), Some("main"));
    assert_eq!(stashes[0].index, 0);
}

#[tokio::test]
async fn end_to_end_scm_workflow_on_real_repo() {
    let ssh = SshManager::default();
    let tmp = make_repo().await;
    let root = tmp.path().to_string_lossy().to_string();

    // 1. Modify, add untracked, check status & diffs.
    fs::write(tmp.path().join("app.ts"), "export const v = 2;\nconsole.log(v);\n").unwrap();
    fs::write(tmp.path().join("notes.txt"), "draft\n").unwrap();

    let st = scm_status_inner(&ssh, &root).await.unwrap().unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert_eq!(st.state, ScmRepoState::Normal);
    assert_eq!(st.unstaged.len(), 1);
    assert_eq!(st.untracked.len(), 1);
    assert!(st.staged.is_empty());

    let diff = scm_diff_inner(&ssh, &root, "app.ts", ScmDiffMode::Unstaged, None, None)
        .await
        .unwrap();
    assert_eq!(diff.hunks.len(), 1);

    let untracked_diff = scm_diff_inner(&ssh, &root, "notes.txt", ScmDiffMode::Untracked, None, None)
        .await
        .unwrap();
    assert!(untracked_diff.is_new);
    assert_eq!(untracked_diff.hunks[0].lines[0].content, "draft");

    // 2. Stage hunk via patch, verify staged diff, then unstage.
    let patch = "--- a/app.ts\n+++ b/app.ts\n@@ -1,1 +1,1 @@\n-export const v = 1;\n+export const v = 2;\n";
    scm_apply_patch_inner(&ssh, &root, patch, true, false)
        .await
        .unwrap();
    let st = scm_status_inner(&ssh, &root).await.unwrap().unwrap();
    assert_eq!(st.staged.len(), 1);
    assert!(st.unstaged.is_empty());

    scm_unstage_inner(&ssh, &root, &["app.ts".to_string()])
        .await
        .unwrap();
    let st = scm_status_inner(&ssh, &root).await.unwrap().unwrap();
    assert!(st.staged.is_empty());
    assert_eq!(st.unstaged.len(), 1);

    // Checkout of a missing branch name matching a tracked filename must NOT overwrite the file!
    assert!(scm_checkout_inner(&ssh, &root, "app.ts", false, None).await.is_err());
    assert_eq!(
        fs::read_to_string(tmp.path().join("app.ts")).unwrap(),
        "export const v = 2;\nconsole.log(v);\n"
    );

    // 3. Stage all, commit, inspect log & commit files, then undo commit.
    scm_stage_inner(&ssh, &root, &[]).await.unwrap();
    let short_hash = scm_commit_inner(&ssh, &root, "feat: bump v to 2", false, false)
        .await
        .unwrap();
    assert!(short_hash.len() >= 4);

    let commits = scm_log_inner(&ssh, &root, 10, 0, false).await.unwrap();
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].subject, "feat: bump v to 2");

    let cfiles = scm_commit_files_inner(&ssh, &root, &commits[0].hash)
        .await
        .unwrap();
    assert_eq!(cfiles.len(), 2);

    let undone_msg = scm_undo_last_commit_inner(&ssh, &root).await.unwrap();
    assert_eq!(undone_msg, "feat: bump v to 2");
    let st = scm_status_inner(&ssh, &root).await.unwrap().unwrap();
    assert_eq!(st.staged.len(), 2);

    scm_commit_inner(&ssh, &root, "feat: bump v to 2", false, false)
        .await
        .unwrap();

    // 4. Stash push, list, per-file stash diff, apply, drop.
    fs::write(tmp.path().join("app.ts"), "export const v = 3;\nconsole.log(v);\n").unwrap();
    scm_stash_push_inner(&ssh, &root, Some("wip v3"), false, false)
        .await
        .unwrap();
    let stashes = scm_stashes_inner(&ssh, &root).await.unwrap();
    assert_eq!(stashes.len(), 1);
    assert_eq!(stashes[0].message, "wip v3");
    let stash_diff = scm_diff_inner(&ssh, &root, "app.ts", ScmDiffMode::Stash, Some("stash@{0}"), None)
        .await
        .unwrap();
    assert_eq!(stash_diff.hunks.len(), 1);
    scm_stash_apply_inner(&ssh, &root, 0, false).await.unwrap();
    // Drop with mismatched OID must be refused.
    assert!(scm_stash_drop_inner(&ssh, &root, 0, Some("0000000000000000000000000000000000000000")).await.is_err());
    scm_stash_drop_inner(&ssh, &root, 0, Some(&stashes[0].oid)).await.unwrap();
    assert!(scm_stashes_inner(&ssh, &root).await.unwrap().is_empty());
    scm_discard_inner(&ssh, &root, &["app.ts".to_string()], &[])
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(tmp.path().join("app.ts")).unwrap(),
        "export const v = 2;\nconsole.log(v);\n"
    );

    // 5. Branches, merge conflict, Unstage All preserves MERGE_HEAD, abort, and conflict resolution.
    scm_checkout_inner(&ssh, &root, "feature", true, None)
        .await
        .unwrap();
    fs::write(tmp.path().join("app.ts"), "export const v = 99;\nconsole.log(v);\n").unwrap();
    scm_commit_inner(&ssh, &root, "feature change", false, true)
        .await
        .unwrap();

    scm_checkout_inner(&ssh, &root, "main", false, None)
        .await
        .unwrap();
    fs::write(tmp.path().join("app.ts"), "export const v = 42;\nconsole.log(v);\n").unwrap();
    scm_commit_inner(&ssh, &root, "main change", false, true)
        .await
        .unwrap();

    let branches = scm_branches_inner(&ssh, &root).await.unwrap();
    assert_eq!(branches.len(), 2);

    assert!(scm_merge_inner(&ssh, &root, "feature").await.is_err());
    let conflict_st = scm_status_inner(&ssh, &root).await.unwrap().unwrap();
    assert_eq!(conflict_st.state, ScmRepoState::Merging);
    assert_eq!(conflict_st.conflicted.len(), 1);

    // Unstage All during merge must NOT clear MERGE_HEAD.
    scm_unstage_inner(&ssh, &root, &[]).await.unwrap();
    assert_eq!(
        scm_status_inner(&ssh, &root).await.unwrap().unwrap().state,
        ScmRepoState::Merging
    );

    scm_abort_inner(&ssh, &root).await.unwrap();
    assert_eq!(
        scm_status_inner(&ssh, &root).await.unwrap().unwrap().state,
        ScmRepoState::Normal
    );
    // Discard the conflict-marker residue left in worktree after unstaging before abort.
    scm_discard_inner(&ssh, &root, &["app.ts".to_string()], &[])
        .await
        .unwrap();

    // Resolving a non-conflicted file must error and NEVER delete the file.
    assert!(scm_resolve_conflict_inner(&ssh, &root, "app.ts", ConflictStrategy::Theirs)
        .await
        .is_err());
    assert!(tmp.path().join("app.ts").exists());

    // Merge again and resolve with --theirs, then check first-parent merge commit diff.
    assert!(scm_merge_inner(&ssh, &root, "feature").await.is_err());
    assert_eq!(
        scm_status_inner(&ssh, &root).await.unwrap().unwrap().state,
        ScmRepoState::Merging
    );
    scm_resolve_conflict_inner(&ssh, &root, "app.ts", ConflictStrategy::Theirs)
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(tmp.path().join("app.ts")).unwrap(),
        "export const v = 99;\nconsole.log(v);\n"
    );
    scm_commit_inner(&ssh, &root, "merge feature", false, false)
        .await
        .unwrap();
    let merge_commits = scm_log_inner(&ssh, &root, 1, 0, false).await.unwrap();
    let merge_diff = scm_diff_inner(
        &ssh,
        &root,
        "app.ts",
        ScmDiffMode::Commit,
        Some(&merge_commits[0].hash),
        None,
    )
    .await
    .unwrap();
    assert_eq!(merge_diff.hunks.len(), 1);
    scm_delete_branch_inner(&ssh, &root, "feature", false)
        .await
        .unwrap();

    // 6. Initialize fresh repo & unstage modified-after-staging entry on unborn HEAD.
    let fresh = tempfile::tempdir().unwrap();
    let fresh_root = fresh.path().to_string_lossy().to_string();
    assert!(scm_status_inner(&ssh, &fresh_root).await.unwrap().is_none());
    scm_init_inner(&ssh, &fresh_root).await.unwrap();
    fs::write(fresh.path().join("hello.txt"), "hi\n").unwrap();
    scm_stage_inner(&ssh, &fresh_root, &["hello.txt".to_string()])
        .await
        .unwrap();
    // Edit again in worktree so index != worktree on unborn HEAD.
    fs::write(fresh.path().join("hello.txt"), "hi again\n").unwrap();
    scm_unstage_inner(&ssh, &fresh_root, &["hello.txt".to_string()])
        .await
        .unwrap();
    assert!(
        scm_status_inner(&ssh, &fresh_root)
            .await
            .unwrap()
            .unwrap()
            .staged
            .is_empty()
    );
    // Working file must stay intact!
    assert_eq!(
        fs::read_to_string(fresh.path().join("hello.txt")).unwrap(),
        "hi again\n"
    );
    assert!(scm_log_inner(&ssh, &fresh_root, 10, 0, false).await.unwrap().is_empty());
}
