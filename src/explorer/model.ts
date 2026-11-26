import {
  fallbackHostLabel,
  formatRemoteLocation,
  isRootLocation,
  parseLocation,
  remoteIdOf,
} from "../files/location";
import * as fs from "../ipc/fs";
import type { FsEntry, GitStatus, Watcher } from "../ipc/fs";
import type { SshStatus } from "../ipc/ssh";
import { homeDirectory } from "../ipc/system";
import { getConnection, hostLabelForLocation, subscribeConnections } from "../ssh/connections";
import {
  type GitBadges,
  type Listing,
  type Row,
  baseName,
  flattenTree,
  gitBadges,
  isWithin,
  joinPath,
  parentPath,
  relativePath,
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
  /** The pane (a terminal) whose directory the root follows, instead of the last focused one. */
  link: string | null;
  showHidden: boolean;
  expanded: string[];
};

export type Editing =
  | { type: "rename"; path: string }
  | { type: "create"; dir: string; kind: "file" | "dir" };

export type ExplorerSnapshot = {
  root: string;
  pinned: boolean;
  link: string | null;
  showHidden: boolean;
  rows: Row[];
  /** The cursor: the entry the keyboard acts on (and the last one clicked). */
  selected: string | null;
  /** Every selected entry (the cursor's too, unless ⌘-clicked off). */
  selection: ReadonlySet<string>;
  editing: Editing | null;
  badges: GitBadges;
  branch: string | null;
  /** Whether the root's own listing has arrived. */
  rootLoaded: boolean;
  /** Whether the root failed specifically due to an SSH transport disconnect (not a setup or fs error). */
  rootDisconnectedError: boolean;
  /** The last failed operation, shown briefly. */
  error: string | null;
};

/** The paths not inside another of them (a selected folder carries its selected contents). */
function topmost(paths: string[]): string[] {
  return paths.filter((path) => !paths.some((other) => other !== path && isWithin(path, other)));
}

/** Git status is looked up again this long after the last change. */
const GIT_REFRESH_MS = 400;
const ERROR_MS = 5000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Whether an error string from the SSH backend is a plain transport disconnect
 * with no extra stderr diagnostic (safe to collapse behind `DisconnectedBanner`
 * on an unloaded root).
 */
function isTransportDisconnectError(text: string): boolean {
  return (
    /^SSH connection '[^']+' is not active$/.test(text) ||
    /^SSH host '[^']+' is not connected$/.test(text) ||
    /^unknown SSH connection '[^']+'$/.test(text) ||
    text === "SSH connection is disconnected" ||
    text === "SSH connection closed" ||
    text === "SSH helper closed before replying" ||
    /^SSH write failed(?::|$)/.test(text) ||
    /^SSH operation '[^']+' timed out while sending request$/.test(text)
  );
}

/**
 * Whether an SSH error carries stderr from a closed multiplexed transport
 * (e.g. `SSH connection closed: client_loop: send disconnect` or a helper
 * traceback). Preserves an already-loaded tree on disconnect without hiding
 * the diagnostic on an unloaded root.
 */
function isClosedWithDiagnosticError(text: string): boolean {
  return text.startsWith("SSH connection closed: ");
}

/** Strips redundant trailing slashes without collapsing `..` (preserves symlink semantics). */
function stripTrailingSlashes(raw: string): string {
  const parsed = parseLocation(raw);
  if (!parsed) return raw;
  if (parsed.kind === "remote") return formatRemoteLocation(parsed.remoteId, parsed.path);
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

export class ExplorerModel {
  private root: string;
  private pinned: boolean;
  private link: string | null;
  private showHidden: boolean;
  private readonly expanded: Set<string>;
  private readonly listings = new Map<string, Listing>();
  /** Last loaded entries per directory, preserved across remote disconnects (and filtered by `showHidden`). */
  private readonly lastLoaded = new Map<string, FsEntry[]>();
  /** Directories whose last read failed specifically due to an SSH transport disconnect. */
  private readonly transportErrors = new Set<string>();
  /** Bumped per directory on each load, so a slow, stale response is dropped. */
  private readonly loadTokens = new Map<string, number>();
  private selected: string | null = null;
  private selection = new Set<string>();
  /** Where a ⇧-click range starts. */
  private anchor: string | null = null;
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
  private lastRemoteStatus: SshStatus | null = null;
  private readonly unsubSsh: () => void;

  private readonly listeners = new Set<() => void>();
  private current: ExplorerSnapshot;

  constructor(
    readonly paneId: string,
    initial: Partial<ExplorerSettings>,
    /** Called when a remembered setting changes. */
    private readonly persist: (settings: ExplorerSettings) => void,
  ) {
    this.root = stripTrailingSlashes(initial.root ?? homeDirectory() ?? "/");
    this.pinned = initial.pinned ?? false;
    this.link = initial.link ?? null;
    this.showHidden = initial.showHidden ?? false;
    this.expanded = new Set((initial.expanded ?? []).map(stripTrailingSlashes));
    this.lastRemoteStatus = this.currentRemoteStatus();
    this.current = this.buildSnapshot();
    this.unsubSsh = subscribeConnections(() => this.handleSshChange());
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
      link: this.link,
      showHidden: this.showHidden,
      rows: flattenTree({ root: this.root, expanded: this.expanded, listings: this.listings, creating }),
      selected: this.selected,
      selection: new Set(this.selection),
      editing: this.editing,
      badges: gitBadges(this.git),
      branch: this.git?.branch ?? null,
      rootLoaded: this.listings.get(this.root)?.state === "loaded",
      rootDisconnectedError:
        this.listings.get(this.root)?.state === "error" && this.transportErrors.has(this.root),
      error: this.error,
    };
  }

  private save(): void {
    this.persist({
      root: this.root,
      pinned: this.pinned,
      link: this.link,
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
    this.unsubSsh();
    this.stopWatching();
    clearTimeout(this.gitTimer);
    clearTimeout(this.errorTimer);
    this.listeners.clear();
  }

  private currentRemoteStatus(): SshStatus | null {
    const rid = remoteIdOf(this.root);
    return rid ? (getConnection(rid)?.status ?? "disconnected") : null;
  }

  private isRemoteDisconnected(path: string): string | null {
    const rid = remoteIdOf(path);
    if (!rid) return null;
    const conn = getConnection(rid);
    return !conn || conn.status === "disconnected" ? rid : null;
  }

  private cachedEntriesFor(dir: string): FsEntry[] | undefined {
    const entries = this.lastLoaded.get(dir);
    if (!entries) return undefined;
    return this.showHidden ? entries : entries.filter((entry) => !entry.hidden && !entry.ignored);
  }

  private handleSshChange(): void {
    if (this.disposed) return;
    const status = this.currentRemoteStatus();
    const prev = this.lastRemoteStatus;
    this.lastRemoteStatus = status;
    if (status === "connected" && prev !== "connected" && this.isAttached) {
      this.reloadAll();
    } else if (status === "disconnected" && prev !== "disconnected") {
      // Restore cached listings only for directories whose error was an in-flight transport disconnect.
      let changed = false;
      for (const [dir, listing] of this.listings) {
        if (listing.state !== "error" || !this.transportErrors.has(dir)) continue;
        const cached = this.cachedEntriesFor(dir);
        if (cached) {
          this.listings.set(dir, { state: "loaded", entries: cached });
          this.transportErrors.delete(dir);
          changed = true;
        } else {
          const rid = remoteIdOf(dir);
          if (rid) {
            const friendly = `Not connected to ${hostLabelForLocation(dir) ?? fallbackHostLabel(rid)}`;
            if (listing.message !== friendly) {
              this.listings.set(dir, { state: "error", message: friendly });
              changed = true;
            }
          }
        }
      }
      if (changed) this.emit();
    }
  }

  // --- Root and options ---

  get rootPath(): string {
    return this.root;
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  /** The pane the root follows, if linked to one. */
  get linkedPane(): string | null {
    return this.link;
  }

  setRoot(path: string): void {
    const normalized = stripTrailingSlashes(path);
    if (normalized === this.root) return;
    this.root = normalized;
    this.lastRemoteStatus = this.currentRemoteStatus();
    this.editing = null;
    this.listings.clear();
    this.lastLoaded.clear();
    this.transportErrors.clear();
    this.git = null;
    this.save();
    if (this.isAttached) this.reloadAll();
    this.emit();
  }

  /** Pinning stays in the folder, and ends a link to a terminal. */
  setPinned(pinned: boolean): void {
    if (pinned === this.pinned && (!pinned || this.link === null)) return;
    this.pinned = pinned;
    if (pinned) this.link = null;
    this.save();
    this.emit();
  }

  /** Follows `paneId`'s directory (unpinning), or, with `null`, the last focused terminal again. */
  setLink(paneId: string | null): void {
    if (paneId === this.link && !this.pinned) return;
    this.link = paneId;
    this.pinned = false;
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
    // A cursor hidden inside the collapsed directory moves up to it; hidden entries are deselected.
    if (this.selected && this.selected !== path && isWithin(this.selected, path)) {
      this.selected = path;
      this.selection.add(path);
    }
    for (const selected of this.selection) if (selected !== path && isWithin(selected, path)) this.selection.delete(selected);
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
    for (const selected of this.selection) if (parentPath(selected) !== this.root) this.selection.delete(selected);
    this.afterExpansionChange();
  }

  private afterExpansionChange(): void {
    this.save();
    this.updateWatchedDirs();
    this.emit();
  }

  /**
   * Shows `path` in the tree and selects it: its directories are expanded,
   * and a path outside the root pins the explorer to the path's folder.
   */
  reveal(path: string): void {
    const target = stripTrailingSlashes(path);
    if (target !== this.root && !isWithin(target, this.root)) {
      this.setPinned(true);
      this.setRoot(parentPath(target));
    }
    for (let dir = parentPath(target); dir !== this.root && isWithin(dir, this.root); ) {
      if (!this.expanded.has(dir)) {
        this.expanded.add(dir);
        void this.load(dir);
      }
      const next = parentPath(dir);
      if (next === dir) break;
      dir = next;
    }
    this.afterExpansionChange();
    this.select(target);
  }

  // --- Selection and editing ---

  /** Selects only `path` (nothing for `null`), which becomes the cursor and the range anchor. */
  select(path: string | null): void {
    if (path === this.selected && this.selection.size === (path ? 1 : 0) && (!path || this.selection.has(path))) return;
    this.selected = path;
    this.anchor = path;
    this.selection = new Set(path ? [path] : []);
    this.emit();
  }

  /** ⌘-click: adds `path` to the selection or takes it out. */
  toggleSelected(path: string): void {
    if (this.selection.has(path)) this.selection.delete(path);
    else this.selection.add(path);
    this.selected = path;
    this.anchor = path;
    this.emit();
  }

  /**
   * ⇧-click or ⇧-arrow: selects the entries from the anchor to `path`, as
   * shown; `add` keeps what else was selected (⇧⌘-click).
   */
  selectRange(path: string, add = false): void {
    const ids = this.current.rows.flatMap((row) => (row.type === "entry" ? [row.entry.path] : []));
    const to = ids.indexOf(path);
    if (to === -1) return;
    let from = this.anchor ? ids.indexOf(this.anchor) : -1;
    if (from === -1) {
      from = to;
      this.anchor = path;
    }
    const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
    this.selection = new Set(add ? [...this.selection, ...range] : range);
    this.selected = path;
    this.emit();
  }

  /** Selects every entry shown. */
  selectAll(): void {
    const ids = this.current.rows.flatMap((row) => (row.type === "entry" ? [row.entry.path] : []));
    this.selection = new Set(ids);
    if (!this.selected && ids.length) this.selected = ids[0];
    this.emit();
  }

  /**
   * The selected entries that are shown, in tree order, without any inside
   * another selected directory (they go along with it); the cursor alone
   * if nothing is selected.
   */
  selectedPaths(): string[] {
    const shown = this.current.rows.flatMap((row) =>
      row.type === "entry" && this.selection.has(row.entry.path) ? [row.entry.path] : [],
    );
    if (shown.length > 0) return topmost(shown);
    // The cursor counts only while it is a row shown here (not, say, left behind by a move elsewhere).
    const cursor = this.selected;
    return cursor && this.current.rows.some((row) => row.type === "entry" && row.entry.path === cursor) ? [cursor] : [];
  }

  /** Where new entries and pasted ones go: the cursor if it is a folder, else the cursor's folder, else the root. */
  targetDir(): string {
    const row = this.selected ? this.current.rows.find((candidate) => rowId(candidate) === this.selected) : undefined;
    if (row?.type !== "entry") return this.root;
    return row.entry.kind === "dir" ? row.entry.path : parentPath(row.entry.path);
  }

  /** Starts renaming an entry in place. */
  startRename(path: string): void {
    this.select(path);
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
    this.invalidateCached([parentPath(from)]);
    this.remap(from, to);
    this.updateWatchedDirs();
    await this.load(parentPath(from));
    return { from, to };
  }

  /** Drops cached offline listings for directories whose contents just changed. */
  private invalidateCached(dirs: Iterable<string>): void {
    for (const dir of dirs) this.lastLoaded.delete(dir);
  }

  /** Cancels in-flight reads and drops cached entries for a path that moved or disappeared. */
  private evictSubtree(path: string): void {
    this.loadTokens.set(path, (this.loadTokens.get(path) ?? 0) + 1);
    this.listings.delete(path);
    this.lastLoaded.delete(path);
    this.transportErrors.delete(path);
  }

  /** After `from` moved to `to`: open directories and the selection inside it follow. */
  private remap(from: string, to: string): void {
    const moved = (path: string) => {
      if (!isWithin(path, from)) return path;
      const rel = relativePath(path, from);
      return rel ? joinPath(to, rel) : to;
    };
    const tracked = new Set([...this.lastLoaded.keys(), ...this.listings.keys(), ...this.loadTokens.keys()]);
    for (const path of tracked) {
      if (isWithin(path, from)) this.evictSubtree(path);
    }
    for (const path of [...this.expanded]) {
      if (isWithin(path, from)) {
        this.expanded.delete(path);
        this.expanded.add(moved(path));
      }
    }
    if (this.selected) this.selected = moved(this.selected);
    if (this.anchor) this.anchor = moved(this.anchor);
    this.selection = new Set([...this.selection].map(moved));
    this.save();
    // Moved open directories are new paths: load them (and they get watched).
    for (const path of this.expanded) if (isWithin(path, to)) void this.load(path);
  }

  /**
   * Moves or copies entries into `dir` (copies get a free name, as in
   * Finder). Moves that go nowhere are skipped; a folder cannot go into
   * itself. Selects what arrived; resolves to the moves made, for open
   * files to follow.
   */
  async transfer(
    paths: string[],
    dir: string,
    mode: "move" | "copy",
  ): Promise<{ moves: { from: string; to: string }[]; failed: string[] }> {
    const moves: { from: string; to: string }[] = [];
    const failed: string[] = [];
    const arrived: string[] = [];
    const errors: string[] = [];
    const touched = new Set([dir]);
    for (const path of topmost(paths)) {
      if (isWithin(dir, path)) {
        errors.push(`“${baseName(path)}” cannot go inside itself.`);
        failed.push(path);
        continue;
      }
      if (mode === "move" && parentPath(path) === dir) continue;
      try {
        if (mode === "copy") {
          arrived.push(await fs.copyInto(path, dir));
        } else {
          const to = joinPath(dir, baseName(path));
          await fs.rename(path, to);
          moves.push({ from: path, to });
          arrived.push(to);
          touched.add(parentPath(path));
          this.remap(path, to);
        }
      } catch (error) {
        errors.push(`Could not ${mode} “${baseName(path)}”: ${message(error)}`);
        failed.push(path);
      }
    }
    if (errors.length) this.fail(errors.length === 1 ? errors[0] : `${errors[0]} (and ${errors.length - 1} more)`);
    if (arrived.length === 0) return { moves, failed };
    // Show what arrived: open the folder it went to, and select it.
    if (dir !== this.root && isWithin(dir, this.root) && !this.expanded.has(dir)) {
      this.expanded.add(dir);
      this.save();
    }
    this.invalidateCached(touched);
    this.updateWatchedDirs();
    await Promise.all([...touched].filter((path) => path === this.root || this.expanded.has(path)).map((path) => this.load(path)));
    // Select what arrived, if it arrived in this tree (a drop into another explorer leaves this one's selection).
    const here = arrived.filter((path) => isWithin(path, this.root));
    if (here.length) {
      this.selection = new Set(here);
      this.selected = here[here.length - 1];
      this.anchor = this.selected;
    }
    this.emit();
    return { moves, failed };
  }

  /** Copies of entries next to them ("a copy.txt"). */
  async duplicate(paths: string[]): Promise<void> {
    const errors: string[] = [];
    const arrived: string[] = [];
    for (const path of topmost(paths)) {
      try {
        arrived.push(await fs.copyInto(path, parentPath(path)));
      } catch (error) {
        errors.push(`Could not duplicate “${baseName(path)}”: ${message(error)}`);
      }
    }
    if (errors.length) this.fail(errors[0]);
    const parents = [...new Set(arrived.map(parentPath))];
    this.invalidateCached(parents);
    await Promise.all(parents.map((dir) => this.load(dir)));
    if (arrived.length) {
      this.selection = new Set(arrived);
      this.selected = arrived[arrived.length - 1];
      this.anchor = this.selected;
      this.emit();
    }
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
    this.anchor = path;
    this.selection = new Set([path]);
    this.invalidateCached([editing.dir]);
    await this.load(editing.dir);
    return { path, kind: editing.kind };
  }

  /** Moves local entries to the Trash (the caller asks first). */
  async trash(paths: string[]): Promise<boolean> {
    try {
      await fs.trash(paths);
    } catch (error) {
      this.fail(`Could not move to the Trash: ${message(error)}`);
      return false;
    }
    await this.afterRemoval(paths);
    return true;
  }

  /** Permanently deletes remote SSH entries (the caller confirms explicitly first). */
  async deletePermanent(paths: string[]): Promise<boolean> {
    try {
      await fs.deletePermanent(paths);
    } catch (error) {
      this.fail(`Could not delete: ${message(error)}`);
      return false;
    }
    await this.afterRemoval(paths);
    return true;
  }

  private async afterRemoval(paths: string[]): Promise<void> {
    // The selection moves to whatever takes the removed rows' place.
    const entriesBefore = this.current.rows.filter((row) => row.type === "entry");
    const firstGone = entriesBefore.findIndex((row) => row.type === "entry" && paths.some((path) => isWithin(row.entry.path, path)));
    const parents = [...new Set(paths.map(parentPath))];
    this.invalidateCached(parents);
    const tracked = new Set([...this.lastLoaded.keys(), ...this.listings.keys(), ...this.loadTokens.keys()]);
    for (const dir of tracked) {
      if (paths.some((path) => isWithin(dir, path))) this.evictSubtree(dir);
    }
    await Promise.all(parents.map((dir) => this.load(dir)));
    const gone = (candidate: string) => paths.some((path) => isWithin(candidate, path));
    for (const selected of this.selection) if (gone(selected)) this.selection.delete(selected);
    if (this.selected && gone(this.selected)) {
      const entries = this.current.rows.filter((row) => row.type === "entry");
      const next = entries[Math.max(0, Math.min(firstGone, entries.length - 1))];
      this.select(next?.type === "entry" ? next.entry.path : null);
    } else this.emit();
  }

  /** Reloads every directory on screen and the git status. */
  refresh(): void {
    this.reloadAll();
  }

  /** Shows a transient error message in the explorer footer. */
  showError(text: string): void {
    this.fail(text);
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
      const entries = await fs.listDir(dir, { showHidden: this.showHidden });
      if (this.disposed || this.loadTokens.get(dir) !== token) return;
      this.transportErrors.delete(dir);
      this.lastLoaded.set(dir, entries);
      listing = { state: "loaded", entries };
    } catch (error) {
      if (this.disposed || this.loadTokens.get(dir) !== token) return;
      const raw = message(error);
      const remoteId = remoteIdOf(dir);
      const plainDisconnect = remoteId !== null && isTransportDisconnectError(raw);
      const closedWithDiag = remoteId !== null && isClosedWithDiagnosticError(raw);
      if (plainDisconnect) {
        this.transportErrors.add(dir);
        if (this.isRemoteDisconnected(dir)) {
          const cached = this.cachedEntriesFor(dir);
          if (cached) {
            this.transportErrors.delete(dir);
            this.listings.set(dir, { state: "loaded", entries: cached });
            this.emit();
            return;
          }
          listing = {
            state: "error",
            message: `Not connected to ${hostLabelForLocation(dir) ?? fallbackHostLabel(remoteId)}`,
          };
        } else {
          listing = { state: "error", message: raw };
        }
      } else if (closedWithDiag && this.lastLoaded.has(dir)) {
        // Keep the cached listing across transport loss while surfacing the stderr diagnostic.
        this.transportErrors.add(dir);
        this.fail(raw);
        if (this.isRemoteDisconnected(dir)) {
          const cached = this.cachedEntriesFor(dir);
          if (cached) {
            this.transportErrors.delete(dir);
            this.listings.set(dir, { state: "loaded", entries: cached });
            this.emit();
            return;
          }
        }
        listing = { state: "error", message: raw };
      } else {
        this.transportErrors.delete(dir);
        this.lastLoaded.delete(dir);
        listing = { state: "error", message: raw };
      }
    }
    this.listings.set(dir, listing);
    if (listing.state === "loaded") this.forgetVanished(dir, listing.entries);
    this.emit();
  }

  /** Directories that disappeared from `dir` are no longer open (or cached). */
  private forgetVanished(dir: string, entries: FsEntry[]): void {
    const present = new Set(entries.filter((entry) => entry.kind === "dir").map((entry) => entry.path));
    let changed = false;
    const prefix = isRootLocation(dir) ? dir : `${dir}/`;
    const isVanished = (path: string) => {
      if (path === dir || !path.startsWith(prefix)) return false;
      const child = joinPath(dir, path.slice(prefix.length).split("/")[0]);
      return !present.has(child);
    };
    for (const path of [...this.expanded]) {
      if (isVanished(path)) {
        this.expanded.delete(path);
        this.evictSubtree(path);
        changed = true;
      }
    }
    // Also evict collapsed cached subtrees and invalidate in-flight reads whose ancestor disappeared.
    const tracked = new Set([...this.lastLoaded.keys(), ...this.listings.keys(), ...this.loadTokens.keys()]);
    for (const path of tracked) {
      if (isVanished(path)) this.evictSubtree(path);
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
        // Changes between the first listing and the watch starting would
        // otherwise go unseen.
        this.reloadAll();
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
