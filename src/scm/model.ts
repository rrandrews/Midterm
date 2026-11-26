import { confirm } from "../components/ui/ConfirmDialog";
import { joinPath, parentPath } from "../explorer/tree";
import { formatRemoteLocation, isRemotePath, parseLocation, remoteIdOf } from "../files/location";
import * as fs from "../ipc/fs";
import type { Watcher } from "../ipc/fs";
import * as scm from "../ipc/scm";
import type {
  ConflictStrategy,
  ScmBranch,
  ScmCommit,
  ScmCommitFile,
  ScmStash,
  ScmStatus,
} from "../ipc/scm";
import type { SshStatus } from "../ipc/ssh";
import { homeDirectory } from "../ipc/system";
import { pluginSettings } from "../plugins/settings";
import { refreshTabTitles } from "../plugins/tabTitles";
import { getConnection, hostLabelForLocation, subscribeConnections } from "../ssh/connections";
import { DEFAULT_SCM_WEIGHTS, type ScmPaneKey, type ScmPaneWeights } from "./layout";

/*
 * Per-pane Source Control model (outside React, keyed by pane id in
 * `src/scm/registry.ts`). Manages Git status, per-repo commit drafts,
 * branch list, commit history, stashes, filesystem watching, and SSH
 * reconnect recovery.
 */

export type ScmViewMode = "list" | "tree";

export type ScmSettingsPersist = {
  root: string;
  pinned: boolean;
  link: string | null;
  viewMode: ScmViewMode;
};

export type ScmSnapshot = {
  root: string;
  pinned: boolean;
  link: string | null;
  viewMode: ScmViewMode;
  status: ScmStatus | null;
  notARepo: boolean;
  loading: boolean;
  busyAction: string | null;
  error: string | null;
  notice: string | null;
  disconnectedError: boolean;
  commitMessage: string;
  amend: boolean;
  branches: ScmBranch[];
  commits: ScmCommit[];
  hasMoreCommits: boolean;
  loadingMoreCommits: boolean;
  stashes: ScmStash[];
  commitFiles: Readonly<Record<string, ScmCommitFile[]>>;
  /** Cached stash file lists keyed by immutable stash commit OID. */
  stashFiles: Readonly<Record<string, ScmCommitFile[]>>;
  collapsedSections: ReadonlySet<string>;
  collapsedDirs: ReadonlySet<string>;
  sectionWeights: ScmPaneWeights;
};

const WATCH_DEBOUNCE_MS = 280;
const VISIBILITY_POLL_MS = 4000;
const MAX_EXTRA_WATCH_DIRS = 32;
const NOTICE_MS = 4000;

const errMsg = (error: unknown) => (error instanceof Error ? error.message : String(error));

function isTransportDisconnectError(text: string): boolean {
  return (
    /^SSH connection '[^']+' is not active$/.test(text) ||
    /^SSH host '[^']+' is not connected$/.test(text) ||
    /^SSH helper is not running$/.test(text)
  );
}

/**
 * Location-aware root normalization: preserves `/` on both local `/` and
 * `ssh://<id>/`, and never strips meaningful whitespace from directory names.
 */
export function normalizeScmRoot(path: string): string {
  if (!path) return path;
  const parsed = parseLocation(path);
  if (!parsed) return path;
  const rawPosix = parsed.path;
  const cleanPosix = rawPosix.length > 1 ? rawPosix.replace(/\/+$/, "") || "/" : rawPosix;
  return parsed.kind === "remote" ? formatRemoteLocation(parsed.remoteId, cleanPosix) : cleanPosix;
}

/* Lightweight cross-pane repo change pub/sub so DiffView and SourceControlPane stay in sync. */
const repoListeners = new Map<string, Set<() => void>>();

export function subscribeRepoChange(repoRoot: string, listener: () => void): () => void {
  const key = normalizeScmRoot(repoRoot);
  let set = repoListeners.get(key);
  if (!set) {
    set = new Set();
    repoListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const cur = repoListeners.get(key);
    if (!cur) return;
    cur.delete(listener);
    if (cur.size === 0) repoListeners.delete(key);
  };
}

export function notifyRepoChange(repoRoot: string): void {
  const key = normalizeScmRoot(repoRoot);
  const set = repoListeners.get(key);
  if (!set) return;
  for (const listener of [...set]) listener();
}

function scmPluginOption<T>(key: string, fallback: T): T {
  const val = pluginSettings("source-control")[key];
  return (val === undefined ? fallback : val) as T;
}

type RepoDraft = { message: string; amend: boolean };

export class ScmModel {
  readonly paneId: string;
  private root: string;
  private pinned: boolean;
  private link: string | null;
  private viewMode: ScmViewMode;

  private status: ScmStatus | null = null;
  private notARepo = false;
  private loading = false;
  private busyAction: string | null = null;
  private error: string | null = null;
  private notice: string | null = null;
  private disconnectedError = false;

  private commitMessage = "";
  private amend = false;
  private activeDraftRepo: string | null = null;
  private draftsByRepo = new Map<string, RepoDraft>();

  private branches: ScmBranch[] = [];
  private commits: ScmCommit[] = [];
  private hasMoreCommits = false;
  private loadingMoreCommits = false;
  private stashes: ScmStash[] = [];
  private commitFiles: Record<string, ScmCommitFile[]> = {};
  private stashFiles: Record<string, ScmCommitFile[]> = {};
  private collapsedSections = new Set<string>();
  private collapsedDirs = new Set<string>();
  private sectionWeights: ScmPaneWeights = { ...DEFAULT_SCM_WEIGHTS };

  private listeners = new Set<() => void>();
  private snap: ScmSnapshot;
  private onPersist: (settings: ScmSettingsPersist) => void;

  private attached = false;
  private disposed = false;
  private attachGen = 0;
  private refreshGen = 0;
  private historyGen = 0;
  private watcher: Watcher | null = null;
  private watcherStarting = false;
  private watchedDirs: string[] = [];
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubSsh: (() => void) | null = null;
  private unsubRepo: (() => void) | null = null;
  private onWindowFocus: (() => void) | null = null;
  private lastSshStatus: SshStatus | undefined;

  constructor(
    paneId: string,
    initial: Partial<ScmSettingsPersist>,
    onPersist: (settings: ScmSettingsPersist) => void,
  ) {
    this.paneId = paneId;
    this.root = normalizeScmRoot(initial.root || homeDirectory() || "/");
    this.pinned = initial.pinned ?? false;
    this.link = initial.link ?? null;
    this.viewMode = initial.viewMode ?? scmPluginOption<ScmViewMode>("defaultView", "list");
    this.onPersist = onPersist;
    this.snap = this.buildSnapshot();
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  get linkedPane(): string | null {
    return this.link;
  }

  get currentRoot(): string {
    return this.root;
  }

  /** Effective repo root if discovered, otherwise the pane's current directory. */
  get repoRoot(): string {
    return this.status?.root ?? this.root;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): ScmSnapshot => this.snap;

  private buildSnapshot(): ScmSnapshot {
    return {
      root: this.root,
      pinned: this.pinned,
      link: this.link,
      viewMode: this.viewMode,
      status: this.status,
      notARepo: this.notARepo,
      loading: this.loading,
      busyAction: this.busyAction,
      error: this.error,
      notice: this.notice,
      disconnectedError: this.disconnectedError,
      commitMessage: this.commitMessage,
      amend: this.amend,
      branches: this.branches,
      commits: this.commits,
      hasMoreCommits: this.hasMoreCommits,
      loadingMoreCommits: this.loadingMoreCommits,
      stashes: this.stashes,
      commitFiles: this.commitFiles,
      stashFiles: this.stashFiles,
      collapsedSections: new Set(this.collapsedSections),
      collapsedDirs: new Set(this.collapsedDirs),
      sectionWeights: { ...this.sectionWeights },
    };
  }

  private emit(): void {
    this.snap = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  private persist(): void {
    this.onPersist({
      root: this.root,
      pinned: this.pinned,
      link: this.link,
      viewMode: this.viewMode,
    });
  }

  private switchDraftRepo(nextRepo: string | null): void {
    const normalizedNext = nextRepo ? normalizeScmRoot(nextRepo) : null;
    if (this.activeDraftRepo === normalizedNext) return;
    if (this.activeDraftRepo) {
      this.draftsByRepo.set(this.activeDraftRepo, {
        message: this.commitMessage,
        amend: this.amend,
      });
    }
    this.activeDraftRepo = normalizedNext;
    const saved = normalizedNext ? this.draftsByRepo.get(normalizedNext) : undefined;
    this.commitMessage = saved?.message ?? "";
    this.amend = saved?.amend ?? false;
  }

  showError(message: string): void {
    this.error = message;
    this.emit();
  }

  clearError(): void {
    if (!this.error) return;
    this.error = null;
    this.emit();
  }

  showNotice(message: string): void {
    clearTimeout(this.noticeTimer);
    this.notice = message;
    this.emit();
    this.noticeTimer = setTimeout(() => {
      if (this.disposed) return;
      this.notice = null;
      this.emit();
    }, NOTICE_MS);
  }

  clearNotice(): void {
    clearTimeout(this.noticeTimer);
    if (!this.notice) return;
    this.notice = null;
    this.emit();
  }

  attach(): void {
    if (this.attached || this.disposed) return;
    this.attached = true;
    const gen = ++this.attachGen;
    this.startWatching(gen);
    this.bindSshSubscription();
    this.bindRepoSubscription();
    this.startVisibilityPolling();
    void this.refresh({ includeMeta: true });
  }

  detach(): void {
    this.attached = false;
    this.attachGen += 1;
    this.stopWatching();
    this.stopVisibilityPolling();
    this.unsubSsh?.();
    this.unsubSsh = null;
    this.unsubRepo?.();
    this.unsubRepo = null;
    clearTimeout(this.watchTimer);
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
    clearTimeout(this.noticeTimer);
    this.listeners.clear();
  }

  private startVisibilityPolling(): void {
    this.stopVisibilityPolling();
    if (typeof window !== "undefined") {
      this.onWindowFocus = () => {
        if (this.attached && !this.disposed && !this.busyAction && !this.disconnectedError) {
          this.scheduleRefresh(120);
        }
      };
      window.addEventListener("focus", this.onWindowFocus);
    }
    // Lightweight visibility-gated fallback catches working-tree edits inside nested
    // subdirectories without needing a recursive filesystem watch over large repos.
    this.pollTimer = setInterval(() => {
      if (!this.attached || this.disposed || this.busyAction || this.disconnectedError || !this.status) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void this.refresh({ includeMeta: false, silent: true, keepError: true });
    }, VISIBILITY_POLL_MS);
  }

  private stopVisibilityPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.onWindowFocus && typeof window !== "undefined") {
      window.removeEventListener("focus", this.onWindowFocus);
      this.onWindowFocus = null;
    }
  }

  private bindSshSubscription(): void {
    this.unsubSsh?.();
    const rid = remoteIdOf(this.root);
    this.lastSshStatus = rid ? getConnection(rid)?.status : undefined;
    if (!rid) {
      this.unsubSsh = null;
      return;
    }
    this.unsubSsh = subscribeConnections(() => {
      const next = getConnection(rid)?.status;
      const prev = this.lastSshStatus;
      this.lastSshStatus = next;
      if (prev !== "connected" && next === "connected") {
        this.disconnectedError = false;
        this.error = null;
        void this.refresh({ includeMeta: true });
      }
    });
  }

  private bindRepoSubscription(): void {
    this.unsubRepo?.();
    if (!this.attached) return;
    this.unsubRepo = subscribeRepoChange(this.repoRoot, () => {
      this.scheduleRefresh(80);
    });
  }

  private startWatching(expectedGen: number): void {
    if (this.watcher || this.watcherStarting || !this.attached) return;
    this.watcherStarting = true;
    void fs
      .watch(() => {
        if (!this.attached || this.disposed) return;
        this.scheduleRefresh(WATCH_DEBOUNCE_MS);
      })
      .then((watcher) => {
        this.watcherStarting = false;
        if (!this.attached || this.disposed || expectedGen !== this.attachGen) {
          watcher.stop();
          return;
        }
        this.watcher = watcher;
        this.syncWatchedDirs();
      })
      .catch(() => {
        this.watcherStarting = false;
      });
  }

  private stopWatching(): void {
    this.watcherStarting = false;
    this.watcher?.stop();
    this.watcher = null;
    this.watchedDirs = [];
  }

  private syncWatchedDirs(): void {
    if (!this.watcher) return;
    const dirs: string[] = [];
    if (this.status) {
      dirs.push(this.status.root, this.status.gitDir, joinPath(this.status.gitDir, "refs/heads"));
      // Also watch immediate parent directories of currently modified files so edits
      // to nested files trigger instant refreshes without recursive repo watches.
      const extra = new Set<string>();
      const allChanges = [
        ...this.status.staged,
        ...this.status.unstaged,
        ...this.status.untracked,
        ...this.status.conflicted,
      ];
      for (const ch of allChanges) {
        if (extra.size >= MAX_EXTRA_WATCH_DIRS) break;
        const abs = joinPath(this.status.root, ch.path);
        const dir = parentPath(abs);
        if (dir && dir !== this.status.root) extra.add(dir);
      }
      dirs.push(...extra);
    } else if (this.root) {
      dirs.push(this.root);
    }
    const dedup = Array.from(new Set(dirs));
    if (dedup.length === this.watchedDirs.length && dedup.every((d, i) => d === this.watchedDirs[i])) {
      return;
    }
    this.watchedDirs = dedup;
    this.watcher.setDirs(dedup);
  }

  private scheduleRefresh(delayMs: number): void {
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      if (!this.attached || this.disposed) return;
      void this.refresh({ includeMeta: true, silent: true, keepError: true });
    }, delayMs);
  }

  setRoot(nextRaw: string): void {
    const next = normalizeScmRoot(nextRaw);
    if (!next || next === this.root) return;
    this.root = next;
    this.loadingMoreCommits = false;
    this.historyGen += 1;
    // Note: keep `status` & draft until `refresh` resolves whether `next` is a subdirectory
    // of the SAME repository or a genuinely different repository.
    this.notARepo = false;
    this.disconnectedError = false;
    this.error = null;
    this.persist();
    this.emit();
    if (this.attached) {
      this.bindSshSubscription();
      this.bindRepoSubscription();
      this.syncWatchedDirs();
      void this.refresh({ includeMeta: true });
    }
  }

  setPinned(pinned: boolean): void {
    if (this.pinned === pinned && (!pinned || this.link === null)) return;
    this.pinned = pinned;
    if (pinned) this.link = null;
    this.persist();
    this.emit();
  }

  setLink(paneId: string | null): void {
    if (this.link === paneId && !this.pinned) return;
    this.link = paneId;
    this.pinned = false;
    this.persist();
    this.emit();
  }

  setViewMode(mode: ScmViewMode): void {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    this.persist();
    this.emit();
  }

  setCommitMessage(message: string): void {
    if (this.commitMessage === message) return;
    this.commitMessage = message;
    this.emit();
  }

  setAmend(amend: boolean): void {
    if (this.amend === amend) return;
    this.amend = amend;
    this.emit();

    // Prefill from actual HEAD commit (not `commits[0]`, which comes from `--all`).
    if (amend && !this.commitMessage.trim() && this.status?.headOid) {
      const targetRepo = this.status.root;
      const headOid = this.status.headOid;
      const localMatch = this.commits.find((c) => c.hash === headOid);
      if (localMatch) {
        this.commitMessage = localMatch.body ? `${localMatch.subject}\n\n${localMatch.body}` : localMatch.subject;
        this.emit();
        return;
      }
      void scm
        .scmLog(targetRepo, { limit: 1, skip: 0, all: false })
        .then((headCommits) => {
          if (this.disposed || !this.amend || this.commitMessage.trim() || this.status?.root !== targetRepo) return;
          const head = headCommits[0];
          if (!head) return;
          this.commitMessage = head.body ? `${head.subject}\n\n${head.body}` : head.subject;
          this.emit();
        })
        .catch(() => {});
    }
  }

  toggleSection(id: string): void {
    if (this.collapsedSections.has(id)) this.collapsedSections.delete(id);
    else this.collapsedSections.add(id);
    this.emit();
  }

  /** Applies an interactive sash resize across the Changes / Graph / Stashes accordion. */
  setSectionLayout(collapsedPanes: ReadonlySet<string>, weights: ScmPaneWeights): void {
    const keys: readonly ScmPaneKey[] = ["changes", "graph", "stashes"];
    for (const key of keys) {
      if (collapsedPanes.has(key)) this.collapsedSections.add(key);
      else this.collapsedSections.delete(key);
    }
    this.sectionWeights = { ...weights };
    this.emit();
  }

  toggleDir(path: string): void {
    if (this.collapsedDirs.has(path)) this.collapsedDirs.delete(path);
    else this.collapsedDirs.add(path);
    this.emit();
  }

  async refresh(opts?: { includeMeta?: boolean; silent?: boolean; keepError?: boolean }): Promise<void> {
    if (this.disposed) return;
    const gen = ++this.refreshGen;
    const targetRoot = this.root;
    if (!opts?.silent) {
      this.loading = true;
      this.emit();
    }

    try {
      const status = await scm.scmStatus(targetRoot);
      if (this.disposed || gen !== this.refreshGen) return;

      this.loading = false;
      this.disconnectedError = false;
      if (!status) {
        const hadBranch = this.status?.branch ?? null;
        this.status = null;
        this.notARepo = true;
        this.switchDraftRepo(null);
        this.branches = [];
        this.commits = [];
        this.hasMoreCommits = false;
        this.loadingMoreCommits = false;
        this.historyGen += 1;
        this.stashes = [];
        this.commitFiles = {};
        this.stashFiles = {};
        this.collapsedDirs.clear();
        if (!opts?.keepError) this.error = null;
        this.syncWatchedDirs();
        if (hadBranch !== null) refreshTabTitles();
        this.emit();
        return;
      }

      const prevRoot = this.status?.root ?? null;
      const prevHead = this.status?.headOid ?? null;
      const prevBranch = this.status?.branch ?? null;
      const repoChanged = prevRoot !== status.root;

      if (repoChanged) {
        this.switchDraftRepo(status.root);
        this.branches = [];
        this.commits = [];
        this.hasMoreCommits = false;
        this.loadingMoreCommits = false;
        this.historyGen += 1;
        this.stashes = [];
        this.commitFiles = {};
        this.stashFiles = {};
        this.collapsedDirs.clear();
      } else if (this.activeDraftRepo === null) {
        this.activeDraftRepo = normalizeScmRoot(status.root);
      }

      this.status = status;
      this.notARepo = false;
      if (!opts?.keepError) this.error = null;
      this.syncWatchedDirs();
      if (repoChanged) this.bindRepoSubscription();
      if (prevBranch !== status.branch) refreshTabTitles();
      this.emit();

      const shouldFetchMeta =
        opts?.includeMeta ||
        repoChanged ||
        prevHead !== status.headOid ||
        prevBranch !== status.branch ||
        this.branches.length === 0;

      if (shouldFetchMeta) {
        const defaultLimit = scmPluginOption<number>("historyLimit", 40);
        // Preserve already-paginated commit rows when refreshing the same repo.
        const pageLimit = repoChanged ? defaultLimit : Math.max(defaultLimit, this.commits.length);
        const [branches, commits, stashes] = await Promise.all([
          scm.scmBranches(status.root).catch(() => this.branches),
          scm.scmLog(status.root, { limit: pageLimit + 1, skip: 0, all: true }).catch(() => this.commits),
          scm.scmStashes(status.root).catch(() => this.stashes),
        ]);
        if (this.disposed || gen !== this.refreshGen) return;
        this.branches = branches;
        this.hasMoreCommits = commits.length > pageLimit;
        this.commits = this.hasMoreCommits ? commits.slice(0, pageLimit) : commits;
        this.stashes = stashes;
        // Retain cached file lists for stashes whose OIDs still exist.
        const liveOids = new Set(stashes.map((s) => s.oid));
        const retained: Record<string, ScmCommitFile[]> = {};
        for (const [oid, files] of Object.entries(this.stashFiles)) {
          if (liveOids.has(oid)) retained[oid] = files;
        }
        this.stashFiles = retained;
        this.emit();
      }
    } catch (error) {
      if (this.disposed || gen !== this.refreshGen) return;
      const text = errMsg(error);
      this.loading = false;
      if (isRemotePath(targetRoot) && isTransportDisconnectError(text)) {
        this.disconnectedError = true;
        this.error = null;
      } else {
        this.disconnectedError = false;
        this.error = text;
      }
      this.emit();
    }
  }

  private async runMutation<T>(
    label: string,
    targetRoot: string,
    fn: (root: string) => Promise<T>,
  ): Promise<T | undefined> {
    if (this.busyAction || this.disposed) return undefined;
    if (normalizeScmRoot(this.repoRoot) !== normalizeScmRoot(targetRoot)) {
      this.showError("Repository changed before action ran — please retry.");
      return undefined;
    }
    this.busyAction = label;
    this.error = null;
    this.emit();
    try {
      const result = await fn(targetRoot);
      if (this.disposed) return result;
      this.busyAction = null;
      this.emit();
      await this.refresh({ includeMeta: true, silent: true });
      notifyRepoChange(targetRoot);
      return result;
    } catch (error) {
      if (!this.disposed) {
        this.busyAction = null;
        this.error = errMsg(error);
        this.emit();
        // Refresh partial Git state (e.g. merge conflicts) WITHOUT clearing the error banner.
        await this.refresh({ includeMeta: true, silent: true, keepError: true });
        notifyRepoChange(targetRoot);
      }
      return undefined;
    }
  }

  async stage(files: string[]): Promise<void> {
    if (files.length === 0) return;
    await this.runMutation("Staging…", this.repoRoot, (root) => scm.scmStage(root, files));
  }

  async stageAll(): Promise<void> {
    await this.runMutation("Staging all…", this.repoRoot, (root) => scm.scmStage(root, []));
  }

  async unstage(files: string[]): Promise<void> {
    if (files.length === 0) return;
    await this.runMutation("Unstaging…", this.repoRoot, (root) => scm.scmUnstage(root, files));
  }

  async unstageAll(): Promise<void> {
    await this.runMutation("Unstaging all…", this.repoRoot, (root) => scm.scmUnstage(root, []));
  }

  async discard(tracked: string[], untracked: string[]): Promise<void> {
    const total = tracked.length + untracked.length;
    if (total === 0) return;
    const targetRoot = this.repoRoot;
    const remote = isRemotePath(targetRoot);
    const what = total === 1 ? `“${tracked[0] ?? untracked[0]}”` : `${total} files`;
    let msg: string;
    if (untracked.length > 0 && remote) {
      const host = hostLabelForLocation(targetRoot) ?? "the remote host";
      msg = `This will revert tracked changes and permanently delete ${untracked.length} untracked file${untracked.length === 1 ? "" : "s"} on ${host}. This cannot be undone.`;
    } else if (untracked.length > 0 && tracked.length === 0) {
      msg = `Untracked ${untracked.length === 1 ? "file" : "files"} will be moved to the Trash.`;
    } else if (untracked.length > 0) {
      msg = "Tracked changes will be reverted (cannot be undone) and untracked files will be moved to the Trash.";
    } else {
      msg = "This will permanently revert unstaged edits in the working tree. This cannot be undone.";
    }
    const ok = await confirm({
      title: `Discard changes in ${what}?`,
      message: msg,
      action: "Discard changes",
    });
    if (!ok) return;
    await this.runMutation("Discarding…", targetRoot, (root) => scm.scmDiscard(root, tracked, untracked));
  }

  async discardAll(): Promise<void> {
    if (!this.status) return;
    const tracked = this.status.unstaged.map((f) => f.path);
    const untracked = this.status.untracked.map((f) => f.path);
    await this.discard(tracked, untracked);
  }

  async commit(options?: { push?: boolean; sync?: boolean; amend?: boolean }): Promise<void> {
    const submittedRaw = this.commitMessage;
    const msg = submittedRaw.trim();
    if (!msg) {
      this.showError("Enter a commit message first.");
      return;
    }
    const targetRoot = this.repoRoot;
    const hadUpstream = Boolean(this.status?.upstream);
    const amend = options?.amend ?? this.amend;
    const conflictedCount = this.status?.conflicted.length ?? 0;
    const stagedCount = this.status?.staged.length ?? 0;
    const unstagedTotal = (this.status?.unstaged.length ?? 0) + (this.status?.untracked.length ?? 0);

    if (conflictedCount > 0) {
      this.showError(
        `Resolve ${conflictedCount} merge conflict${conflictedCount === 1 ? "" : "s"} before committing.`,
      );
      return;
    }

    let stageAll = false;
    if (!amend && stagedCount === 0) {
      if (unstagedTotal === 0) {
        this.showError("There are no changes to commit.");
        return;
      }
      if (scmPluginOption<boolean>("smartCommit", false)) {
        stageAll = true;
      } else {
        const ok = await confirm({
          title: "No staged changes to commit",
          message: `Stage all ${unstagedTotal} modified/untracked file${unstagedTotal === 1 ? "" : "s"} and commit?`,
          action: "Stage all & commit",
        });
        if (!ok) return;
        stageAll = true;
      }
    }

    const label = options?.sync
      ? "Committing & syncing…"
      : options?.push
        ? "Committing & pushing…"
        : amend
          ? "Amending commit…"
          : "Committing…";

    const hash = await this.runMutation(label, targetRoot, async (root) => {
      const committedHash = await scm.scmCommit(root, msg, { amend, stageAll });
      if (options?.sync) {
        if (hadUpstream) {
          await scm.scmPull(root, false);
          await scm.scmPush(root, { setUpstream: false });
        } else {
          await scm.scmPush(root, { setUpstream: true });
        }
      } else if (options?.push) {
        await scm.scmPush(root, { setUpstream: !hadUpstream });
      }
      return committedHash;
    });
    if (!hash) return;

    // Clear the draft only if the user hasn't switched repos or started writing a new message.
    if (normalizeScmRoot(this.repoRoot) === normalizeScmRoot(targetRoot) && this.commitMessage === submittedRaw) {
      this.commitMessage = "";
      this.amend = false;
      this.emit();
    }

    if (options?.sync) {
      this.showNotice(hadUpstream ? `Committed ${hash} and synced` : `Committed ${hash} and published branch`);
    } else if (options?.push) {
      this.showNotice(`Committed ${hash} and pushed`);
    } else {
      this.showNotice(amend ? `Amended commit ${hash}` : `Committed ${hash}`);
    }
  }

  async undoLastCommit(): Promise<void> {
    const targetRoot = this.repoRoot;
    const restored = await this.runMutation("Undoing last commit…", targetRoot, (root) =>
      scm.scmUndoLastCommit(root),
    );
    if (restored === undefined) return;
    if (restored.trim() && normalizeScmRoot(this.repoRoot) === normalizeScmRoot(targetRoot)) {
      this.commitMessage = restored;
      this.emit();
    }
    this.showNotice("Undid last commit (changes kept staged)");
  }

  async checkout(refName: string, options?: { create?: boolean; startPoint?: string }): Promise<boolean> {
    const res = await this.runMutation(
      options?.create ? `Creating ${refName}…` : `Switching to ${refName}…`,
      this.repoRoot,
      async (root) => {
        await scm.scmCheckout(root, refName, options);
        return true;
      },
    );
    if (res) {
      this.showNotice(options?.create ? `Created and switched to ${refName}` : `Switched to ${refName}`);
      return true;
    }
    return false;
  }

  async deleteBranch(name: string, force = false, boundRoot?: string): Promise<boolean> {
    const targetRoot = boundRoot ?? this.repoRoot;
    if (!force) {
      const ok = await confirm({
        title: `Delete branch “${name}”?`,
        message: "If the branch has unmerged commits, Git will refuse unless force-deleted.",
        action: "Delete branch",
      });
      if (!ok) return false;
    }
    if (this.busyAction || this.disposed) return false;
    if (normalizeScmRoot(this.repoRoot) !== normalizeScmRoot(targetRoot)) {
      this.showError("Repository changed before deleting branch — please retry.");
      return false;
    }
    this.busyAction = `Deleting ${name}…`;
    this.error = null;
    this.emit();
    try {
      await scm.scmDeleteBranch(targetRoot, name, force);
      this.busyAction = null;
      this.emit();
      await this.refresh({ includeMeta: true, silent: true });
      notifyRepoChange(targetRoot);
      this.showNotice(`Deleted branch ${name}`);
      return true;
    } catch (error) {
      this.busyAction = null;
      const text = errMsg(error);
      this.emit();
      if (!force && /not fully merged/i.test(text)) {
        const forceOk = await confirm({
          title: `Branch “${name}” is not fully merged`,
          message: "Force-delete this branch anyway? Unmerged commits will only remain in the reflog.",
          action: "Force delete",
        });
        if (forceOk) return this.deleteBranch(name, true, targetRoot);
        return false;
      }
      this.showError(text);
      return false;
    }
  }

  async renameBranch(oldName: string, newName: string): Promise<boolean> {
    const res = await this.runMutation(`Renaming ${oldName}…`, this.repoRoot, async (root) => {
      await scm.scmRenameBranch(root, oldName, newName);
      return true;
    });
    if (res) {
      this.showNotice(`Renamed ${oldName} → ${newName}`);
      return true;
    }
    return false;
  }

  async mergeBranch(branch: string): Promise<void> {
    const out = await this.runMutation(`Merging ${branch}…`, this.repoRoot, (root) => scm.scmMerge(root, branch));
    if (out !== undefined) {
      this.showNotice(out.split("\n")[0] || `Merged ${branch}`);
    }
  }

  async abortOperation(): Promise<void> {
    const targetRoot = this.repoRoot;
    const state = this.status?.state;
    if (!state || state === "normal") return;
    const ok = await confirm({
      title: `Abort ${state}?`,
      message: "This will abort the in-progress Git operation and reset conflicted files.",
      action: `Abort ${state}`,
    });
    if (!ok) return;
    const res = await this.runMutation(`Aborting ${state}…`, targetRoot, async (root) => {
      await scm.scmAbort(root);
      return true;
    });
    if (res) this.showNotice(`Aborted ${state}`);
  }

  async fetch(prune = false): Promise<void> {
    const res = await this.runMutation(prune ? "Fetching (prune)…" : "Fetching…", this.repoRoot, (root) =>
      scm.scmFetch(root, { prune }),
    );
    if (res !== undefined) this.showNotice("Fetched from remotes");
  }

  async pull(rebase = false): Promise<void> {
    const res = await this.runMutation(rebase ? "Pulling (rebase)…" : "Pulling…", this.repoRoot, (root) =>
      scm.scmPull(root, rebase),
    );
    if (res !== undefined) this.showNotice(res.split("\n")[0] || "Pulled latest changes");
  }

  async push(options?: { forceWithLease?: boolean; setUpstream?: boolean }): Promise<void> {
    const targetRoot = this.repoRoot;
    const hadUpstream = Boolean(this.status?.upstream);
    if (options?.forceWithLease) {
      const ok = await confirm({
        title: "Force push (with lease)?",
        message: "This rewrites history on the remote branch if no unexpected commits arrived.",
        action: "Force push",
      });
      if (!ok) return;
    }
    const setUpstream = options?.setUpstream ?? !hadUpstream;
    const label = setUpstream && !hadUpstream ? "Publishing branch…" : "Pushing…";
    const res = await this.runMutation(label, targetRoot, (root) =>
      scm.scmPush(root, { forceWithLease: options?.forceWithLease, setUpstream }),
    );
    if (res !== undefined) {
      this.showNotice(setUpstream && !hadUpstream ? "Published branch" : "Pushed to remote");
    }
  }

  async sync(): Promise<void> {
    const targetRoot = this.repoRoot;
    const hasUpstream = Boolean(this.status?.upstream);
    if (scmPluginOption<boolean>("confirmSync", false)) {
      const ok = await confirm({
        title: "Sync changes?",
        message: "This action will pull and push commits from and to the configured upstream branch.",
        action: "Sync",
      });
      if (!ok) return;
    }
    const res = await this.runMutation(
      hasUpstream ? "Syncing…" : "Publishing branch…",
      targetRoot,
      async (root) => {
        if (hasUpstream) {
          await scm.scmPull(root, false);
          await scm.scmPush(root, { setUpstream: false });
        } else {
          await scm.scmPush(root, { setUpstream: true });
        }
        return true;
      },
    );
    if (res) this.showNotice(hasUpstream ? "Synced with remote" : "Published branch");
  }

  async stashPush(
    message?: string,
    options?: { includeUntracked?: boolean; stagedOnly?: boolean },
  ): Promise<boolean> {
    const res = await this.runMutation("Stashing…", this.repoRoot, async (root) => {
      await scm.scmStashPush(root, {
        message: message?.trim() || undefined,
        includeUntracked: options?.includeUntracked,
        stagedOnly: options?.stagedOnly,
      });
      return true;
    });
    if (res) {
      this.showNotice("Saved changes to stash");
      return true;
    }
    return false;
  }

  async stashApply(index: number, pop = false): Promise<void> {
    const res = await this.runMutation(pop ? "Popping stash…" : "Applying stash…", this.repoRoot, async (root) => {
      await scm.scmStashApply(root, index, pop);
      return true;
    });
    if (res) this.showNotice(pop ? `Popped stash@{${index}}` : `Applied stash@{${index}}`);
  }

  async stashDrop(stash: ScmStash): Promise<void> {
    const targetRoot = this.repoRoot;
    const ok = await confirm({
      title: `Drop ${stash.reference}?`,
      message: `This permanently removes “${stash.message}”.`,
      action: "Drop stash",
    });
    if (!ok) return;
    const res = await this.runMutation("Dropping stash…", targetRoot, async (root) => {
      await scm.scmStashDrop(root, stash.index, stash.oid);
      return true;
    });
    if (res) this.showNotice(`Dropped ${stash.reference}`);
  }

  async initRepo(): Promise<void> {
    const targetRoot = this.root;
    const res = await this.runMutation("Initializing Git repository…", targetRoot, async (root) => {
      await scm.scmInit(root);
      return true;
    });
    if (res) this.showNotice("Initialized Git repository");
  }

  async resolveConflict(filePath: string, strategy: ConflictStrategy): Promise<void> {
    const label = strategy === "ours" ? "Accepting current…" : "Accepting incoming…";
    await this.runMutation(label, this.repoRoot, (root) => scm.scmResolveConflict(root, filePath, strategy));
  }

  async loadMoreCommits(): Promise<void> {
    if (this.loadingMoreCommits || !this.hasMoreCommits || !this.status) return;
    const root = this.status.root;
    const gen = this.historyGen;
    const limit = scmPluginOption<number>("historyLimit", 40);
    const skip = this.commits.length;
    this.loadingMoreCommits = true;
    this.emit();
    try {
      const more = await scm.scmLog(root, { limit: limit + 1, skip, all: true });
      if (this.disposed || gen !== this.historyGen || this.status?.root !== root) return;
      this.hasMoreCommits = more.length > limit;
      const chunk = this.hasMoreCommits ? more.slice(0, limit) : more;
      const seen = new Set(this.commits.map((c) => c.hash));
      this.commits = [...this.commits, ...chunk.filter((c) => !seen.has(c.hash))];
      this.loadingMoreCommits = false;
      this.emit();
    } catch (error) {
      if (!this.disposed && gen === this.historyGen) {
        this.loadingMoreCommits = false;
        this.error = errMsg(error);
        this.emit();
      }
    }
  }

  async loadCommitFiles(hash: string): Promise<ScmCommitFile[]> {
    if (this.commitFiles[hash]) return this.commitFiles[hash];
    const targetRoot = this.repoRoot;
    const files = await scm.scmCommitFiles(targetRoot, hash);
    if (!this.disposed && normalizeScmRoot(this.repoRoot) === normalizeScmRoot(targetRoot)) {
      this.commitFiles = { ...this.commitFiles, [hash]: files };
      this.emit();
    }
    return files;
  }

  async loadStashFiles(stash: ScmStash): Promise<ScmCommitFile[]> {
    if (this.stashFiles[stash.oid]) return this.stashFiles[stash.oid];
    const targetRoot = this.repoRoot;
    const files = await scm.scmStashFiles(targetRoot, stash.index);
    if (
      !this.disposed &&
      normalizeScmRoot(this.repoRoot) === normalizeScmRoot(targetRoot) &&
      this.stashes.some((s) => s.oid === stash.oid)
    ) {
      this.stashFiles = { ...this.stashFiles, [stash.oid]: files };
      this.emit();
    }
    return files;
  }
}
