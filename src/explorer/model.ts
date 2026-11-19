import * as fs from "../ipc/fs";
import type { FsEntry, GitStatus, Watcher } from "../ipc/fs";
import { homeDirectory } from "../ipc/system";
import {
  type GitBadges,
  type Listing,
  type Row,
  flattenTree,
  gitBadges,
  isWithin,
  joinPath,
  parentPath,
  rowId,
  validName,
} from "./tree";

/*
 * One explorer pane's state: its root, which directories are open, what is
 * in them, the selection and git status. Lives outside React (keyed by pane
 * id in explorers.ts), like terminal sessions, so a remount loses nothing.
 * The pane component subscribes to `snapshot`.
 */

/** What the explorer remembers between runs (stored in the pane's data). */
export type ExplorerSettings = {
  root: string;
  pinned: boolean;
  showHidden: boolean;
  expanded: string[];
};

export type Editing =
  | { type: "rename"; path: string }
  | { type: "create"; dir: string; kind: "file" | "dir" };

export type ExplorerSnapshot = {
  root: string;
  pinned: boolean;
  showHidden: boolean;
  rows: Row[];
  selected: string | null;
  editing: Editing | null;
  badges: GitBadges;
  branch: string | null;
  /** Whether the root's own listing has arrived. */
  rootLoaded: boolean;
  /** The last failed operation, shown briefly. */
  error: string | null;
};

/** Git status is looked up again this long after the last change. */
const GIT_REFRESH_MS = 400;
const ERROR_MS = 5000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class ExplorerModel {
  private root: string;
  private pinned: boolean;
  private showHidden: boolean;
  private readonly expanded: Set<string>;
  private readonly listings = new Map<string, Listing>();
  /** Bumped per directory on each load, so a slow, stale response is dropped. */
  private readonly loadTokens = new Map<string, number>();
  private selected: string | null = null;
  private editing: Editing | null = null;
  private git: GitStatus | null = null;
  private gitToken = 0;
  private gitTimer: ReturnType<typeof setTimeout> | undefined;
  private error: string | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | undefined;

  private watcher: Watcher | null = null;
  private watcherPending = false;
  private attachCount = 0;
  private disposed = false;

  private readonly listeners = new Set<() => void>();
  private current: ExplorerSnapshot;

  constructor(
    readonly paneId: string,
    initial: Partial<ExplorerSettings>,
    /** Called when a remembered setting changes. */
    private readonly persist: (settings: ExplorerSettings) => void,
  ) {
    this.root = initial.root ?? homeDirectory() ?? "/";
    this.pinned = initial.pinned ?? false;
    this.showHidden = initial.showHidden ?? false;
    this.expanded = new Set(initial.expanded ?? []);
    this.current = this.buildSnapshot();
  }

  // --- Subscription (for useSyncExternalStore) ---

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): ExplorerSnapshot => this.current;

  private emit(): void {
    this.current = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): ExplorerSnapshot {
    const creating = this.editing?.type === "create" ? this.editing : null;
    return {
      root: this.root,
      pinned: this.pinned,
      showHidden: this.showHidden,
      rows: flattenTree({ root: this.root, expanded: this.expanded, listings: this.listings, creating }),
      selected: this.selected,
      editing: this.editing,
      badges: gitBadges(this.git),
      branch: this.git?.branch ?? null,
      rootLoaded: this.listings.get(this.root)?.state === "loaded",
      error: this.error,
    };
  }

  private save(): void {
    this.persist({
      root: this.root,
      pinned: this.pinned,
      showHidden: this.showHidden,
      expanded: [...this.expanded],
    });
  }

  // --- On screen ---

  /** The pane is showing: watch for changes and catch up on any missed. */
  attach(): void {
    if (this.disposed) return;
    this.attachCount++;
    if (this.attachCount > 1) return;
    this.reloadAll();
    this.startWatching();
  }

  /** The pane is off screen: stop watching. Its state is kept. */
  detach(): void {
    this.attachCount = Math.max(0, this.attachCount - 1);
    if (this.attachCount === 0) this.stopWatching();
  }

  get isAttached(): boolean {
    return this.attachCount > 0;
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatching();
    clearTimeout(this.gitTimer);
    clearTimeout(this.errorTimer);
    this.listeners.clear();
  }

  // --- Root and options ---

  get rootPath(): string {
    return this.root;
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  setRoot(path: string): void {
    if (path === this.root) return;
    this.root = path;
    this.editing = null;
    this.listings.clear();
    this.git = null;
    this.save();
    if (this.isAttached) this.reloadAll();
    this.emit();
  }

  setPinned(pinned: boolean): void {
    if (pinned === this.pinned) return;
    this.pinned = pinned;
    this.save();
    this.emit();
  }

  setShowHidden(showHidden: boolean): void {
    if (showHidden === this.showHidden) return;
    this.showHidden = showHidden;
    this.save();
    this.reloadAll();
    this.emit();
  }

  // --- Expanding ---

  isExpanded(path: string): boolean {
    return this.expanded.has(path);
  }

  expand(path: string): void {
    if (this.expanded.has(path)) return;
    this.expanded.add(path);
    // Even if cached: it was not watched while collapsed.
    void this.load(path);
    this.afterExpansionChange();
  }

  collapse(path: string): void {
    if (!this.expanded.delete(path)) return;
    // A selection hidden inside the collapsed directory moves up to it.
    if (this.selected && this.selected !== path && isWithin(this.selected, path)) this.selected = path;
    this.afterExpansionChange();
  }

  toggle(path: string): void {
    if (this.expanded.has(path)) this.collapse(path);
    else this.expand(path);
  }

  collapseAll(): void {
    if (this.expanded.size === 0) return;
    this.expanded.clear();
    if (this.selected && parentPath(this.selected) !== this.root) this.selected = null;
    this.afterExpansionChange();
  }

  private afterExpansionChange(): void {
    this.save();
    this.updateWatchedDirs();
    this.emit();
  }

  // --- Selection and editing ---

  select(path: string | null): void {
    if (path === this.selected) return;
    this.selected = path;
    this.emit();
  }

  /** Starts renaming an entry in place. */
  startRename(path: string): void {
    this.selected = path;
    this.editing = { type: "rename", path };
    this.emit();
  }

  /** Starts naming a new file or directory in `dir` (opening it if needed). */
  startCreate(dir: string, kind: "file" | "dir"): void {
    if (dir !== this.root) this.expand(dir);
    this.editing = { type: "create", dir, kind };
    this.emit();
  }

  cancelEdit(): void {
    if (!this.editing) return;
    this.editing = null;
    this.emit();
  }

  /** Finishes a rename; resolves to the new path, or `null` if nothing was renamed. */
  async commitRename(name: string): Promise<{ from: string; to: string } | null> {
    const editing = this.editing;
    this.editing = null;
    this.emit();
    if (editing?.type !== "rename") return null;
    const valid = validName(name);
    const from = editing.path;
    if (!valid) {
      if (name.trim()) this.fail(`“${name.trim()}” is not a valid name.`);
      return null;
    }
    const to = joinPath(parentPath(from), valid);
    if (to === from) return null;
    try {
      await fs.rename(from, to);
    } catch (error) {
      this.fail(`Could not rename: ${message(error)}`);
      return null;
    }
    // Open directories inside the renamed one stay open under the new name.
    for (const path of [...this.expanded]) {
      if (isWithin(path, from)) {
        this.expanded.delete(path);
        this.expanded.add(to + path.slice(from.length));
      }
    }
    if (this.selected && isWithin(this.selected, from)) this.selected = to + this.selected.slice(from.length);
    this.save();
    await this.load(parentPath(from));
    return { from, to };
  }

  /** Finishes creating; resolves to the new entry's path, or `null` if nothing was created. */
  async commitCreate(name: string): Promise<{ path: string; kind: "file" | "dir" } | null> {
    const editing = this.editing;
    this.editing = null;
    this.emit();
    if (editing?.type !== "create") return null;
    const valid = validName(name);
    if (!valid) {
      if (name.trim()) this.fail(`“${name.trim()}” is not a valid name.`);
      return null;
    }
    const path = joinPath(editing.dir, valid);
    try {
      await fs.create(path, editing.kind);
    } catch (error) {
      this.fail(`Could not create “${valid}”: ${message(error)}`);
      return null;
    }
    this.selected = path;
    await this.load(editing.dir);
    return { path, kind: editing.kind };
  }

  /** Moves entries to the Trash (the caller asks first). */
  async trash(paths: string[]): Promise<boolean> {
    try {
      await fs.trash(paths);
    } catch (error) {
      this.fail(`Could not move to the Trash: ${message(error)}`);
      return false;
    }
    // The selection moves to whatever takes the trashed row's place.
    const index = this.current.rows.findIndex((row) => rowId(row) === this.selected);
    await Promise.all([...new Set(paths.map(parentPath))].map((dir) => this.load(dir)));
    if (this.selected && paths.some((path) => isWithin(this.selected ?? "", path))) {
      const entries = this.current.rows.filter((row) => row.type === "entry");
      const next = entries[Math.max(0, Math.min(index, entries.length - 1))];
      this.select(next?.type === "entry" ? next.entry.path : null);
    }
    return true;
  }

  /** Reloads every directory on screen and the git status. */
  refresh(): void {
    this.reloadAll();
  }

  private fail(text: string): void {
    this.error = text;
    clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => {
      this.error = null;
      this.emit();
    }, ERROR_MS);
    this.emit();
  }

  // --- Loading ---

  /** Directories whose contents are shown (or would be, once loaded). */
  private visibleDirs(): string[] {
    return [this.root, ...[...this.expanded].filter((path) => path !== this.root && isWithin(path, this.root))];
  }

  private reloadAll(): void {
    for (const dir of this.visibleDirs()) void this.load(dir);
    this.scheduleGitRefresh(0);
    this.updateWatchedDirs();
  }

  private async load(dir: string): Promise<void> {
    const token = (this.loadTokens.get(dir) ?? 0) + 1;
    this.loadTokens.set(dir, token);
    // Keep showing what we had while reloading; only a first load shows a placeholder.
    if (!this.listings.has(dir)) {
      this.listings.set(dir, { state: "loading" });
      this.emit();
    }
    let listing: Listing;
    try {
      listing = { state: "loaded", entries: await fs.listDir(dir, { showHidden: this.showHidden }) };
    } catch (error) {
      listing = { state: "error", message: message(error) };
    }
    if (this.disposed || this.loadTokens.get(dir) !== token) return;
    this.listings.set(dir, listing);
    if (listing.state === "loaded") this.forgetVanished(dir, listing.entries);
    this.emit();
  }

  /** Directories that disappeared from `dir` are no longer open (or cached). */
  private forgetVanished(dir: string, entries: FsEntry[]): void {
    const present = new Set(entries.filter((entry) => entry.kind === "dir").map((entry) => entry.path));
    let changed = false;
    for (const path of [...this.expanded]) {
      const child = path.startsWith(`${dir}/`) ? joinPath(dir, path.slice(dir.length + 1).split("/")[0]) : null;
      if (child && !present.has(child)) {
        this.expanded.delete(path);
        this.listings.delete(path);
        changed = true;
      }
    }
    if (changed) {
      this.save();
      this.updateWatchedDirs();
    }
  }

  // --- Git ---

  private scheduleGitRefresh(delay = GIT_REFRESH_MS): void {
    clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(() => void this.refreshGit(), delay);
  }

  private async refreshGit(): Promise<void> {
    const token = ++this.gitToken;
    const root = this.root;
    let status: GitStatus | null;
    try {
      status = await fs.gitStatus(root);
    } catch (error) {
      console.warn("git status failed:", error);
      status = null;
    }
    if (this.disposed || token !== this.gitToken || root !== this.root) return;
    const repoChanged = status?.root !== this.git?.root;
    this.git = status;
    if (repoChanged) this.updateWatchedDirs();
    this.emit();
  }

  // --- Watching ---

  private startWatching(): void {
    if (this.watcher || this.watcherPending) return;
    this.watcherPending = true;
    fs.watch(({ dirs }) => {
      for (const dir of dirs) {
        if (this.git && dir === joinPath(this.git.root, ".git")) continue;
        if (this.listings.has(dir)) void this.load(dir);
      }
      // Any change in the tree, or in .git (index, HEAD), can change the status.
      this.scheduleGitRefresh();
    }).then(
      (watcher) => {
        this.watcherPending = false;
        if (this.disposed || !this.isAttached) {
          watcher.stop();
          return;
        }
        this.watcher = watcher;
        this.updateWatchedDirs();
      },
      (error: unknown) => {
        this.watcherPending = false;
        console.warn("Watching files failed:", error);
      },
    );
  }

  private stopWatching(): void {
    this.watcher?.stop();
    this.watcher = null;
  }

  private updateWatchedDirs(): void {
    if (!this.watcher) return;
    const dirs = this.visibleDirs();
    if (this.git) dirs.push(joinPath(this.git.root, ".git"));
    this.watcher.setDirs(dirs);
  }
}
