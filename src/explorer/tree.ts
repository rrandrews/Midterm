import { formatRemoteLocation, isRootLocation, parseLocation, posixPathOf } from "../files/location";
import type { FsEntry, GitCode, GitStatus } from "../ipc/fs";

/*
 * Pure helpers for the explorer: paths, the visible rows of the tree, git
 * badges. Supports both local paths (`/abs/...`) and remote SSH URIs
 * (`ssh://<remoteId>/<posixPath>`). No I/O, no React; unit-tested in tree.test.ts.
 */

function canonicalPath(raw: string): { remoteId: string | null; path: string } | null {
  const parsed = parseLocation(raw);
  if (!parsed) return null;
  const trimmed = parsed.path.replace(/\/+$/, "");
  return {
    remoteId: parsed.kind === "remote" ? parsed.remoteId : null,
    path: trimmed.length === 0 ? "/" : trimmed,
  };
}

export function joinPath(dir: string, name: string): string {
  const cleanName = name.replace(/^\/+/, "");
  if (!cleanName) return dir;
  const parsed = parseLocation(dir);
  if (parsed?.kind === "remote") {
    return formatRemoteLocation(parsed.remoteId, parsed.path === "/" ? `/${cleanName}` : `${parsed.path}/${cleanName}`);
  }
  return dir.endsWith("/") ? `${dir}${cleanName}` : `${dir}/${cleanName}`;
}

export function parentPath(path: string): string {
  const parsed = parseLocation(path);
  if (parsed?.kind === "remote") {
    const posix = parsed.path;
    const index = posix.lastIndexOf("/");
    const parent = index <= 0 ? "/" : posix.slice(0, index);
    return formatRemoteLocation(parsed.remoteId, parent);
  }
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

export function baseName(path: string): string {
  const posix = posixPathOf(path);
  if (posix === "/") return "/";
  const trimmed = posix.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

/** Whether `path` is `dir` or inside it (always false across different hosts). */
export function isWithin(path: string, dir: string): boolean {
  const p = canonicalPath(path);
  const d = canonicalPath(dir);
  if (!p || !d || p.remoteId !== d.remoteId) return false;
  if (d.path === "/") return true;
  return p.path === d.path || p.path.startsWith(`${d.path}/`);
}

/** `path` relative to `dir` (which must contain it); `""` for `dir` itself. */
export function relativePath(path: string, dir: string): string {
  const p = canonicalPath(path);
  const d = canonicalPath(dir);
  if (!p || !d || p.remoteId !== d.remoteId) return "";
  if (p.path === d.path) return "";
  if (d.path === "/") return p.path.slice(1);
  return p.path.startsWith(`${d.path}/`) ? p.path.slice(d.path.length + 1) : "";
}

/**
 * A path for display, with the matching host's home directory shortened to `~`.
 * Never leaks the internal `ssh://<remoteId>` authority prefix, and never
 * applies a local `home` to a remote path.
 */
export function displayPath(path: string, home: string | undefined): string {
  const parsed = parseLocation(path);
  if (!parsed) return path;
  if (home && isWithin(path, home)) {
    const rel = relativePath(path, home);
    return rel ? `~/${rel}` : "~";
  }
  return parsed.path;
}

/** A name the user typed for a new or renamed entry: one path component. */
export function validName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("/")) return null;
  return trimmed;
}

/** What is known about one directory's contents. */
export type Listing =
  | { state: "loading" }
  | { state: "loaded"; entries: FsEntry[] }
  | { state: "error"; message: string };

export type Row =
  | { type: "entry"; entry: FsEntry; depth: number; expanded: boolean }
  /** Placeholder while a directory loads, or the reason it could not be read. */
  | { type: "status"; dir: string; depth: number; text: string }
  /** The name field for an entry being created in `dir`. */
  | { type: "create"; dir: string; kind: "file" | "dir"; depth: number };

/** Id of a row, for keys and selection. Entries use their path. */
export function rowId(row: Row): string {
  if (row.type === "entry") return row.entry.path;
  return `${row.type}:${row.dir}`;
}

export type FlattenInput = {
  root: string;
  expanded: ReadonlySet<string>;
  listings: ReadonlyMap<string, Listing>;
  /** A new entry being named, shown first in its directory. */
  creating?: { dir: string; kind: "file" | "dir" } | null;
};

/** The rows of the tree as shown: the root's entries, and the contents of each expanded directory below it. */
export function flattenTree({ root, expanded, listings, creating }: FlattenInput): Row[] {
  const rows: Row[] = [];
  const visit = (dir: string, depth: number) => {
    if (creating?.dir === dir) rows.push({ type: "create", dir, kind: creating.kind, depth });
    const listing = listings.get(dir);
    if (!listing || listing.state === "loading") {
      // The root shows nothing while loading; a subdirectory, a placeholder.
      if (dir !== root) rows.push({ type: "status", dir, depth, text: "Loading…" });
      return;
    }
    if (listing.state === "error") {
      rows.push({ type: "status", dir, depth, text: listing.message });
      return;
    }
    for (const entry of listing.entries) {
      const open = entry.kind === "dir" && expanded.has(entry.path);
      rows.push({ type: "entry", entry, depth, expanded: open });
      if (open) visit(entry.path, depth + 1);
    }
  };
  visit(root, 0);
  return rows;
}

/** How much each status matters when a directory sums up its contents. */
const WEIGHT: Record<GitCode, number> = { C: 6, D: 5, M: 4, R: 3, A: 2, U: 1 };

export type GitBadges = {
  /** The status of a file, or the most significant status inside a directory. */
  get: (path: string) => GitCode | undefined;
};

/** Badges for absolute paths from a status: files as reported, directories rolled up. */
export function gitBadges(status: GitStatus | null): GitBadges {
  const badges = new Map<string, GitCode>();
  if (status) {
    for (const [relative, code] of Object.entries(status.entries)) {
      const file = joinPath(status.root, relative);
      badges.set(file, code);
      for (let dir = parentPath(file); isWithin(dir, status.root); dir = parentPath(dir)) {
        const current = badges.get(dir);
        if (current && WEIGHT[current] >= WEIGHT[code]) break;
        badges.set(dir, code);
        if (dir === status.root || isRootLocation(dir)) break;
      }
    }
  }
  return { get: (path) => badges.get(path) };
}

/**
 * Type-ahead: the index of the next row (after `from`, wrapping, `from`
 * itself last) whose name starts with `prefix`, ignoring case; -1 if none.
 * A prefix of one repeated letter ("aaa") cycles through names starting
 * with that letter, as in Finder.
 */
export function findByPrefix(rows: Row[], from: number, prefix: string, sameKeyRepeated: boolean): number {
  const wanted = (sameKeyRepeated ? prefix[0] : prefix).toLowerCase();
  // A longer prefix still matching the current row keeps it selected.
  const start = sameKeyRepeated || prefix.length === 1 ? from + 1 : from;
  for (let step = 0; step < rows.length; step++) {
    const index = (start + step + rows.length) % rows.length;
    const row = rows[index];
    if (row.type === "entry" && row.entry.name.toLowerCase().startsWith(wanted)) return index;
  }
  return -1;
}
