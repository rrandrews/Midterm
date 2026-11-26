import type {
  ConflictStrategy,
  ScmBranch,
  ScmCommit,
  ScmCommitFile,
  ScmDiff,
  ScmDiffMode,
  ScmFileChange,
  ScmStash,
  ScmStatus,
} from "./scm";

/*
 * Stateful in-memory Git mock for `bun run dev` (browser preview) and Vitest
 * unit tests. Mirrors the Rust `scm_*` commands closely enough to exercise
 * staging, unstaging, discarding, commits, branches, stashes, and diffs.
 */

type MockState = {
  root: string;
  initialized: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: ScmFileChange[];
  unstaged: ScmFileChange[];
  untracked: ScmFileChange[];
  conflicted: ScmFileChange[];
  branches: ScmBranch[];
  commits: ScmCommit[];
  stashes: ScmStash[];
};

const now = () => Math.floor(Date.now() / 1000);

function initialState(root = "/Users/dev/project"): MockState {
  const t = now();
  return {
    root,
    initialized: true,
    branch: "main",
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    staged: [{ path: "src/app.ts", status: "M" }],
    unstaged: [
      { path: "src/components/Header.tsx", status: "M" },
      { path: "README.md", status: "M" },
    ],
    untracked: [{ path: "src/scm/notes.md", status: "U" }],
    conflicted: [],
    branches: [
      {
        name: "main",
        current: true,
        upstream: "origin/main",
        ahead: 1,
        behind: 0,
        commitHash: "a1b2c3d",
        commitSubject: "feat: add source control panel",
        commitDate: t - 3600,
      },
      {
        name: "feature/diff-viewer",
        current: false,
        ahead: 0,
        behind: 0,
        commitHash: "e4f5a6b",
        commitSubject: "wip: side-by-side split view",
        commitDate: t - 7200,
      },
      {
        name: "origin/main",
        current: false,
        remote: "origin",
        ahead: 0,
        behind: 0,
        commitHash: "9876543",
        commitSubject: "chore: release prep",
        commitDate: t - 86400,
      },
    ],
    commits: [
      {
        hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        shortHash: "a1b2c3d",
        parents: ["9876543210abcdef9876543210abcdef98765432"],
        author: "Developer",
        email: "dev@midterm.app",
        date: t - 3600,
        subject: "feat: add source control panel",
        body: "Adds staging, diffing, commits, branches, and stashes.",
        refs: [{ kind: "head", name: "main" }],
      },
      {
        hash: "9876543210abcdef9876543210abcdef98765432",
        shortHash: "9876543",
        parents: ["1111222233334444555566667777888899990000"],
        author: "Developer",
        email: "dev@midterm.app",
        date: t - 86400,
        subject: "chore: release prep",
        body: "",
        refs: [
          { kind: "remote", name: "origin/main" },
          { kind: "tag", name: "v0.9.0" },
        ],
      },
      {
        hash: "1111222233334444555566667777888899990000",
        shortHash: "1111222",
        parents: [],
        author: "Developer",
        email: "dev@midterm.app",
        date: t - 172800,
        subject: "Initial commit",
        body: "",
        refs: [],
      },
    ],
    stashes: [
      {
        index: 0,
        reference: "stash@{0}",
        oid: "feedface00000000000000000000000000000001",
        branch: "main",
        message: "WIP on main: quick experiment",
        date: t - 1800,
      },
    ],
  };
}

let state = initialState();

export function resetScmMock(root = "/Users/dev/project", initialized = true): void {
  state = initialState(root);
  state.initialized = initialized;
}

export async function scmStatus(path: string): Promise<ScmStatus | null> {
  if (!state.initialized) return null;
  const root = path || state.root;
  return {
    root,
    gitDir: `${root.replace(/\/+$/, "")}/.git`,
    branch: state.branch,
    headOid: state.commits[0]?.hash ?? null,
    upstream: state.upstream,
    ahead: state.ahead,
    behind: state.behind,
    state: state.conflicted.length > 0 ? "merging" : "normal",
    staged: state.staged.map((f) => ({ ...f })),
    unstaged: state.unstaged.map((f) => ({ ...f })),
    untracked: state.untracked.map((f) => ({ ...f })),
    conflicted: state.conflicted.map((f) => ({ ...f })),
  };
}

export async function scmDiff(
  _path: string,
  filePath: string,
  mode: ScmDiffMode,
  _options?: { commitHash?: string; oldPath?: string },
): Promise<ScmDiff> {
  if (mode === "untracked") {
    return {
      path: filePath,
      binary: false,
      tooLarge: false,
      patchable: true,
      isNew: true,
      isDeleted: false,
      hunks: [
        {
          header: "@@ -0,0 +1,3 @@",
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: "add", content: "# Notes", newLine: 1 },
            { kind: "add", content: "", newLine: 2 },
            { kind: "add", content: "Draft content for source control.", newLine: 3 },
          ],
        },
      ],
    };
  }
  return {
    path: filePath,
    binary: false,
    tooLarge: false,
    patchable: true,
    isNew: false,
    isDeleted: false,
    hunks: [
      {
        header: "@@ -1,4 +1,5 @@",
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 5,
        lines: [
          { kind: "context", content: "export function greet(name: string) {", oldLine: 1, newLine: 1 },
          { kind: "del", content: '  return "Hello " + name;', oldLine: 2 },
          { kind: "add", content: "  const clean = name.trim();", newLine: 2 },
          { kind: "add", content: "  return `Hello, ${clean}!`;", newLine: 3 },
          { kind: "context", content: "}", oldLine: 3, newLine: 4 },
        ],
      },
    ],
  };
}

export async function scmStage(_path: string, files: string[]): Promise<void> {
  const all = files.length === 0;
  const match = (p: string) => all || files.includes(p);
  const moveUnstaged = state.unstaged.filter((f) => match(f.path));
  const moveUntracked = state.untracked.filter((f) => match(f.path));
  state.unstaged = state.unstaged.filter((f) => !match(f.path));
  state.untracked = state.untracked.filter((f) => !match(f.path));
  for (const f of moveUnstaged) {
    if (!state.staged.some((s) => s.path === f.path)) state.staged.push(f);
  }
  for (const f of moveUntracked) {
    if (!state.staged.some((s) => s.path === f.path)) state.staged.push({ path: f.path, status: "A" });
  }
}

export async function scmUnstage(_path: string, files: string[]): Promise<void> {
  const all = files.length === 0;
  const match = (p: string) => all || files.includes(p);
  const moved = state.staged.filter((f) => match(f.path));
  state.staged = state.staged.filter((f) => !match(f.path));
  for (const f of moved) {
    if (f.status === "A") {
      if (!state.untracked.some((u) => u.path === f.path)) state.untracked.push({ path: f.path, status: "U" });
    } else if (!state.unstaged.some((u) => u.path === f.path)) {
      state.unstaged.push(f);
    }
  }
}

export async function scmDiscard(_path: string, files: string[], untracked: string[]): Promise<void> {
  state.unstaged = state.unstaged.filter((f) => !files.includes(f.path));
  state.untracked = state.untracked.filter((f) => !untracked.includes(f.path));
}

function patchTargetPath(patch: string): string | null {
  for (const line of patch.split("\n")) {
    const clean = line.replace(/\r$/, "");
    if (clean.startsWith("+++ b/")) return clean.slice(6);
    if (clean.startsWith("--- a/")) return clean.slice(6);
  }
  return null;
}

export async function scmApplyPatch(_path: string, patch: string, cached: boolean, reverse: boolean): Promise<void> {
  const target = patchTargetPath(patch);
  if (cached && !reverse) {
    const idx = target ? state.unstaged.findIndex((f) => f.path === target) : 0;
    if (idx >= 0 && idx < state.unstaged.length) {
      const [item] = state.unstaged.splice(idx, 1);
      if (!state.staged.some((s) => s.path === item.path)) state.staged.push(item);
    }
  } else if (cached && reverse) {
    const idx = target ? state.staged.findIndex((f) => f.path === target) : 0;
    if (idx >= 0 && idx < state.staged.length) {
      const [item] = state.staged.splice(idx, 1);
      if (!state.unstaged.some((u) => u.path === item.path)) state.unstaged.push(item);
    }
  } else if (!cached && reverse) {
    const idx = target ? state.unstaged.findIndex((f) => f.path === target) : 0;
    if (idx >= 0 && idx < state.unstaged.length) {
      state.unstaged.splice(idx, 1);
    }
  }
}

export async function scmCommit(
  _path: string,
  message: string,
  options?: { amend?: boolean; stageAll?: boolean },
): Promise<string> {
  if (!message.trim()) throw new Error("Commit message cannot be empty");
  if (options?.stageAll) await scmStage("", []);
  if (!options?.amend && state.staged.length === 0) throw new Error("Nothing to commit");
  const lines = message.trim().split("\n");
  const subject = lines[0];
  const body = lines.slice(1).join("\n").trim();
  const shortHash = Math.random().toString(16).slice(2, 9).padEnd(7, "0");
  const hash = shortHash.repeat(6).slice(0, 40);
  if (options?.amend && state.commits.length > 0) {
    state.commits[0] = { ...state.commits[0], hash, shortHash, subject, body, date: now() };
  } else {
    const parent = state.commits[0]?.hash;
    for (const c of state.commits) c.refs = c.refs.filter((r) => r.kind !== "head");
    state.commits.unshift({
      hash,
      shortHash,
      parents: parent ? [parent] : [],
      author: "Developer",
      email: "dev@midterm.app",
      date: now(),
      subject,
      body,
      refs: [{ kind: "head", name: state.branch }],
    });
    state.ahead += 1;
  }
  state.staged = [];
  return shortHash;
}

export async function scmUndoLastCommit(_path: string): Promise<string> {
  const top = state.commits.shift();
  if (!top) throw new Error("No commits to undo");
  if (state.commits[0]) state.commits[0].refs.unshift({ kind: "head", name: state.branch });
  state.ahead = Math.max(0, state.ahead - 1);
  return top.body ? `${top.subject}\n\n${top.body}` : top.subject;
}

export async function scmBranches(_path: string): Promise<ScmBranch[]> {
  return state.branches.map((b) => ({ ...b }));
}

export async function scmCheckout(
  _path: string,
  refName: string,
  options?: { create?: boolean; startPoint?: string },
): Promise<void> {
  if (options?.create) {
    state.branches.forEach((b) => (b.current = false));
    state.branches.unshift({
      name: refName,
      current: true,
      ahead: 0,
      behind: 0,
      commitHash: state.commits[0]?.shortHash ?? "0000000",
      commitSubject: state.commits[0]?.subject ?? "",
      commitDate: now(),
    });
    state.branch = refName;
    state.upstream = null;
    state.ahead = 0;
    state.behind = 0;
    return;
  }
  const found = state.branches.find((b) => b.name === refName);
  if (!found) throw new Error(`Branch not found: ${refName}`);
  state.branches.forEach((b) => (b.current = b.name === refName));
  state.branch = refName;
  state.upstream = found.upstream ?? null;
  state.ahead = found.ahead;
  state.behind = found.behind;
}

export async function scmDeleteBranch(_path: string, name: string, _force: boolean): Promise<void> {
  if (name === state.branch) throw new Error("Cannot delete the currently checked out branch");
  state.branches = state.branches.filter((b) => b.name !== name);
}

export async function scmRenameBranch(_path: string, oldName: string, newName: string): Promise<void> {
  const b = state.branches.find((x) => x.name === oldName);
  if (!b) throw new Error(`Branch not found: ${oldName}`);
  b.name = newName;
  if (state.branch === oldName) state.branch = newName;
}

export async function scmMerge(_path: string, branch: string): Promise<string> {
  return `Merged ${branch} into ${state.branch}`;
}

export async function scmAbort(_path: string): Promise<void> {
  state.conflicted = [];
}

export async function scmFetch(_path: string, _options?: { remote?: string; prune?: boolean }): Promise<string> {
  return "Fetched remotes";
}

export async function scmPull(_path: string, _rebase: boolean): Promise<string> {
  state.behind = 0;
  return "Already up to date.";
}

export async function scmPush(
  _path: string,
  options?: { forceWithLease?: boolean; setUpstream?: boolean; remote?: string },
): Promise<string> {
  state.ahead = 0;
  if (options?.setUpstream) state.upstream = `${options.remote ?? "origin"}/${state.branch}`;
  return "Pushed to remote";
}

export async function scmLog(
  _path: string,
  options?: { limit?: number; skip?: number; all?: boolean },
): Promise<ScmCommit[]> {
  const skip = options?.skip ?? 0;
  const limit = options?.limit ?? 50;
  return state.commits.slice(skip, skip + limit).map((c) => ({ ...c, refs: [...c.refs], parents: [...c.parents] }));
}

export async function scmCommitFiles(_path: string, _hash: string): Promise<ScmCommitFile[]> {
  return [
    { path: "src/scm/SourceControlPane.tsx", status: "A", additions: 210, deletions: 0, binary: false },
    { path: "src/plugins/builtin/index.ts", status: "M", additions: 2, deletions: 0, binary: false },
  ];
}

export async function scmStashes(_path: string): Promise<ScmStash[]> {
  return state.stashes.map((s) => ({ ...s }));
}

export async function scmStashFiles(_path: string, _index: number): Promise<ScmCommitFile[]> {
  return [{ path: "src/components/Header.tsx", status: "M", additions: 4, deletions: 2, binary: false }];
}

export async function scmStashPush(
  _path: string,
  options?: { message?: string; includeUntracked?: boolean; stagedOnly?: boolean },
): Promise<void> {
  const oid = `feedface${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}`;
  state.stashes.unshift({
    index: 0,
    reference: "stash@{0}",
    oid,
    branch: state.branch,
    message: options?.message?.trim() || `WIP on ${state.branch}`,
    date: now(),
  });
  state.stashes.forEach((s, i) => {
    s.index = i;
    s.reference = `stash@{${i}}`;
  });
  if (options?.stagedOnly) {
    state.staged = [];
  } else {
    state.unstaged = [];
    state.staged = [];
    if (options?.includeUntracked) state.untracked = [];
  }
}

export async function scmStashApply(_path: string, index: number, pop: boolean): Promise<void> {
  if (pop) state.stashes.splice(index, 1);
  state.stashes.forEach((s, i) => {
    s.index = i;
    s.reference = `stash@{${i}}`;
  });
}

export async function scmStashDrop(_path: string, index: number, expectedOid?: string): Promise<void> {
  if (expectedOid && state.stashes[index]?.oid !== expectedOid) {
    throw new Error("Stash list changed before drop — please refresh and retry");
  }
  state.stashes.splice(index, 1);
  state.stashes.forEach((s, i) => {
    s.index = i;
    s.reference = `stash@{${i}}`;
  });
}

export async function scmInit(path: string): Promise<void> {
  state.root = path;
  state.initialized = true;
}

export async function scmResolveConflict(_path: string, filePath: string, _strategy: ConflictStrategy): Promise<void> {
  state.conflicted = state.conflicted.filter((c) => c.path !== filePath);
  if (!state.staged.some((s) => s.path === filePath)) {
    state.staged.push({ path: filePath, status: "M" });
  }
}
