import { invoke, isTauri } from "@tauri-apps/api/core";
import * as mock from "./scmMock";

/*
 * Typed wrapper around the Rust Source Control commands (`src-tauri/src/git`).
 * All repo paths are absolute local paths or `ssh://<remoteId>/<path>` URIs.
 * Outside Tauri (`bun run dev` in a browser or unit tests) calls delegate to
 * the stateful in-memory mock (`scmMock.ts`).
 */

export type ScmRepoState =
  | "normal"
  | "merging"
  | "rebasing"
  | "cherry-picking"
  | "reverting"
  | "bisecting";

export type ScmChangeKind = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "!";

export type ScmFileChange = {
  path: string;
  origPath?: string;
  status: ScmChangeKind;
  conflictCode?: string;
};

export type ScmStatus = {
  root: string;
  gitDir: string;
  branch: string | null;
  headOid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  state: ScmRepoState;
  staged: ScmFileChange[];
  unstaged: ScmFileChange[];
  untracked: ScmFileChange[];
  conflicted: ScmFileChange[];
};

export type ScmDiffLineKind = "context" | "add" | "del";

export type ScmDiffLine = {
  kind: ScmDiffLineKind;
  content: string;
  oldLine?: number;
  newLine?: number;
  noNewline?: boolean;
};

export type ScmDiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ScmDiffLine[];
};

export type ScmDiff = {
  path: string;
  oldPath?: string;
  binary: boolean;
  tooLarge: boolean;
  nonUtf8?: boolean;
  typeChanged?: boolean;
  patchable: boolean;
  isNew: boolean;
  isDeleted: boolean;
  hunks: ScmDiffHunk[];
};

export type ScmBranch = {
  name: string;
  current: boolean;
  remote?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  commitHash: string;
  commitSubject: string;
  commitDate: number;
};

export type ScmRefKind = "head" | "branch" | "remote" | "tag";

export type ScmRef = {
  kind: ScmRefKind;
  name: string;
};

export type ScmCommit = {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  subject: string;
  body: string;
  refs: ScmRef[];
};

export type ScmCommitFile = {
  path: string;
  origPath?: string;
  status: ScmChangeKind;
  additions?: number;
  deletions?: number;
  binary: boolean;
};

export type ScmStash = {
  index: number;
  reference: string;
  oid: string;
  branch?: string;
  message: string;
  date: number;
};

export type ScmDiffMode = "unstaged" | "staged" | "untracked" | "commit" | "stash";
export type ConflictStrategy = "ours" | "theirs";

export function scmStatus(path: string): Promise<ScmStatus | null> {
  if (!isTauri()) return mock.scmStatus(path);
  return invoke<ScmStatus | null>("scm_status", { path });
}

export function scmDiff(
  path: string,
  filePath: string,
  mode: ScmDiffMode,
  options?: { commitHash?: string; oldPath?: string },
): Promise<ScmDiff> {
  if (!isTauri()) return mock.scmDiff(path, filePath, mode, options);
  return invoke<ScmDiff>("scm_diff", {
    path,
    filePath,
    mode,
    commitHash: options?.commitHash ?? null,
    oldPath: options?.oldPath ?? null,
  });
}

export function scmStage(path: string, files: string[] = []): Promise<void> {
  if (!isTauri()) return mock.scmStage(path, files);
  return invoke("scm_stage", { path, files });
}

export function scmUnstage(path: string, files: string[] = []): Promise<void> {
  if (!isTauri()) return mock.scmUnstage(path, files);
  return invoke("scm_unstage", { path, files });
}

export function scmDiscard(path: string, files: string[], untracked: string[] = []): Promise<void> {
  if (!isTauri()) return mock.scmDiscard(path, files, untracked);
  return invoke("scm_discard", { path, files, untracked });
}

export function scmApplyPatch(path: string, patch: string, cached: boolean, reverse: boolean): Promise<void> {
  if (!isTauri()) return mock.scmApplyPatch(path, patch, cached, reverse);
  return invoke("scm_apply_patch", { path, patch, cached, reverse });
}

export function scmCommit(
  path: string,
  message: string,
  options?: { amend?: boolean; stageAll?: boolean },
): Promise<string> {
  const amend = options?.amend ?? false;
  const stageAll = options?.stageAll ?? false;
  if (!isTauri()) return mock.scmCommit(path, message, { amend, stageAll });
  return invoke<string>("scm_commit", { path, message, amend, stageAll });
}

export function scmUndoLastCommit(path: string): Promise<string> {
  if (!isTauri()) return mock.scmUndoLastCommit(path);
  return invoke<string>("scm_undo_last_commit", { path });
}

export function scmBranches(path: string): Promise<ScmBranch[]> {
  if (!isTauri()) return mock.scmBranches(path);
  return invoke<ScmBranch[]>("scm_branches", { path });
}

export function scmCheckout(
  path: string,
  refName: string,
  options?: { create?: boolean; startPoint?: string },
): Promise<void> {
  const create = options?.create ?? false;
  const startPoint = options?.startPoint ?? null;
  if (!isTauri()) return mock.scmCheckout(path, refName, { create, startPoint: startPoint ?? undefined });
  return invoke("scm_checkout", { path, refName, create, startPoint });
}

export function scmDeleteBranch(path: string, name: string, force = false): Promise<void> {
  if (!isTauri()) return mock.scmDeleteBranch(path, name, force);
  return invoke("scm_delete_branch", { path, name, force });
}

export function scmRenameBranch(path: string, oldName: string, newName: string): Promise<void> {
  if (!isTauri()) return mock.scmRenameBranch(path, oldName, newName);
  return invoke("scm_rename_branch", { path, oldName, newName });
}

export function scmMerge(path: string, branch: string): Promise<string> {
  if (!isTauri()) return mock.scmMerge(path, branch);
  return invoke<string>("scm_merge", { path, branch });
}

export function scmAbort(path: string): Promise<void> {
  if (!isTauri()) return mock.scmAbort(path);
  return invoke("scm_abort", { path });
}

export function scmFetch(path: string, options?: { remote?: string; prune?: boolean }): Promise<string> {
  const remote = options?.remote ?? null;
  const prune = options?.prune ?? false;
  if (!isTauri()) return mock.scmFetch(path, { remote: remote ?? undefined, prune });
  return invoke<string>("scm_fetch", { path, remote, prune });
}

export function scmPull(path: string, rebase = false): Promise<string> {
  if (!isTauri()) return mock.scmPull(path, rebase);
  return invoke<string>("scm_pull", { path, rebase });
}

export function scmPush(
  path: string,
  options?: { forceWithLease?: boolean; setUpstream?: boolean; remote?: string },
): Promise<string> {
  const forceWithLease = options?.forceWithLease ?? false;
  const setUpstream = options?.setUpstream ?? false;
  const remote = options?.remote ?? null;
  if (!isTauri()) return mock.scmPush(path, { forceWithLease, setUpstream, remote: remote ?? undefined });
  return invoke<string>("scm_push", { path, forceWithLease, setUpstream, remote });
}

export function scmLog(path: string, options?: { limit?: number; skip?: number; all?: boolean }): Promise<ScmCommit[]> {
  const limit = options?.limit ?? 50;
  const skip = options?.skip ?? 0;
  const all = options?.all ?? true;
  if (!isTauri()) return mock.scmLog(path, { limit, skip, all });
  return invoke<ScmCommit[]>("scm_log", { path, limit, skip, all });
}

export function scmCommitFiles(path: string, hash: string): Promise<ScmCommitFile[]> {
  if (!isTauri()) return mock.scmCommitFiles(path, hash);
  return invoke<ScmCommitFile[]>("scm_commit_files", { path, hash });
}

export function scmStashes(path: string): Promise<ScmStash[]> {
  if (!isTauri()) return mock.scmStashes(path);
  return invoke<ScmStash[]>("scm_stashes", { path });
}

export function scmStashFiles(path: string, index: number): Promise<ScmCommitFile[]> {
  if (!isTauri()) return mock.scmStashFiles(path, index);
  return invoke<ScmCommitFile[]>("scm_stash_files", { path, index });
}

export function scmStashPush(
  path: string,
  options?: { message?: string; includeUntracked?: boolean; stagedOnly?: boolean },
): Promise<void> {
  const message = options?.message ?? null;
  const includeUntracked = options?.includeUntracked ?? false;
  const stagedOnly = options?.stagedOnly ?? false;
  if (!isTauri()) return mock.scmStashPush(path, { message: message ?? undefined, includeUntracked, stagedOnly });
  return invoke("scm_stash_push", { path, message, includeUntracked, stagedOnly });
}

export function scmStashApply(path: string, index: number, pop = false): Promise<void> {
  if (!isTauri()) return mock.scmStashApply(path, index, pop);
  return invoke("scm_stash_apply", { path, index, pop });
}

export function scmStashDrop(path: string, index: number, expectedOid?: string): Promise<void> {
  if (!isTauri()) return mock.scmStashDrop(path, index, expectedOid);
  return invoke("scm_stash_drop", { path, index, expectedOid: expectedOid ?? null });
}

export function scmInit(path: string): Promise<void> {
  if (!isTauri()) return mock.scmInit(path);
  return invoke("scm_init", { path });
}

export function scmResolveConflict(path: string, filePath: string, strategy: ConflictStrategy): Promise<void> {
  if (!isTauri()) return mock.scmResolveConflict(path, filePath, strategy);
  return invoke("scm_resolve_conflict", { path, filePath, strategy });
}
