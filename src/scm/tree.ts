import type { ScmChangeKind, ScmDiff, ScmFileChange } from "../ipc/scm";

/*
 * Pure data helpers for the Source Control panel:
 * - File path splitting and compacted folder tree construction (for List vs Tree view)
 * - Unified diff patch reconstruction for single-hunk Stage / Unstage / Revert
 * - Status badge metadata and compact relative timestamps
 */

export type ScmTreeFolder = {
  kind: "folder";
  /** Unique path key of this (possibly compacted) folder node, e.g. `src/components`. */
  path: string;
  /** Display label relative to parent folder, e.g. `components/ui`. */
  label: string;
  /** Depth in the rendered tree (0-based). */
  depth: number;
  children: ScmTreeNode[];
  /** Every file change contained anywhere below this folder. */
  files: ScmFileChange[];
};

export type ScmTreeFile = {
  kind: "file";
  path: string;
  name: string;
  depth: number;
  change: ScmFileChange;
};

export type ScmTreeNode = ScmTreeFolder | ScmTreeFile;

export function splitRelPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/");
  if (slash === -1) return { name: path, dir: "" };
  return { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

type RawFolder = {
  name: string;
  path: string;
  folders: Map<string, RawFolder>;
  files: ScmFileChange[];
};

function sortByName<T>(items: T[], key: (item: T) => string): T[] {
  return items.sort((a, b) => key(a).localeCompare(key(b), undefined, { sensitivity: "base" }));
}

function collectFiles(folder: RawFolder): ScmFileChange[] {
  const out: ScmFileChange[] = [];
  for (const child of folder.folders.values()) out.push(...collectFiles(child));
  out.push(...folder.files);
  return out;
}

/**
 * Builds a VS Code-style compacted folder tree from a flat list of Git changes.
 * Single-child folder chains (no sibling files or folders) compact into `a/b/c`.
 */
export function buildChangeTree(changes: ScmFileChange[]): ScmTreeNode[] {
  const root: RawFolder = { name: "", path: "", folders: new Map(), files: [] };

  for (const change of changes) {
    const parts = change.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let next = cur.folders.get(seg);
      if (!next) {
        next = {
          name: seg,
          path: cur.path ? `${cur.path}/${seg}` : seg,
          folders: new Map(),
          files: [],
        };
        cur.folders.set(seg, next);
      }
      cur = next;
    }
    cur.files.push(change);
  }

  function convert(folder: RawFolder, depth: number): ScmTreeNode[] {
    const out: ScmTreeNode[] = [];
    const subFolders = sortByName(Array.from(folder.folders.values()), (f) => f.name);
    for (const sub of subFolders) {
      // Compact single-child directory chains when no files sit at the intermediate level.
      let leaf = sub;
      const labelParts = [sub.name];
      while (leaf.files.length === 0 && leaf.folders.size === 1) {
        const only = leaf.folders.values().next().value as RawFolder;
        labelParts.push(only.name);
        leaf = only;
      }
      out.push({
        kind: "folder",
        path: leaf.path,
        label: labelParts.join("/"),
        depth,
        children: convert(leaf, depth + 1),
        files: collectFiles(leaf),
      });
    }

    const sortedFiles = sortByName([...folder.files], (f) => splitRelPath(f.path).name);
    for (const change of sortedFiles) {
      out.push({
        kind: "file",
        path: change.path,
        name: splitRelPath(change.path).name,
        depth,
        change,
      });
    }
    return out;
  }

  return convert(root, 0);
}

/** Flattens a tree respecting the set of collapsed folder keys. */
export function flattenChangeTree(nodes: ScmTreeNode[], collapsed: ReadonlySet<string>): ScmTreeNode[] {
  const out: ScmTreeNode[] = [];
  const visit = (list: ScmTreeNode[]) => {
    for (const node of list) {
      out.push(node);
      if (node.kind === "folder" && !collapsed.has(node.path)) {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return out;
}

/** C-quotes a patch path header when it contains characters Git requires quoting for. */
function formatPatchHeaderPath(prefix: "a/" | "b/", relPath: string): string {
  const full = `${prefix}${relPath}`;
  if (!/[\t\n\r"\\]/.test(full)) return full;
  const escaped = full
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/**
 * Reconstructs a single-hunk unified diff patch suitable for `git apply --unidiff-zero --recount`.
 * Returns `null` if the diff is non-patchable (binary, truncated, non-UTF-8, type change)
 * or the hunk index is out of bounds.
 */
export function buildHunkPatch(diff: ScmDiff, hunkIndex: number): string | null {
  if (!diff.patchable) return null;
  const hunk = diff.hunks[hunkIndex];
  if (!hunk || hunk.lines.length === 0) return null;

  const oldPath = diff.oldPath ?? diff.path;
  const oldHeader = diff.isNew ? "/dev/null" : formatPatchHeaderPath("a/", oldPath);
  const newHeader = diff.isDeleted ? "/dev/null" : formatPatchHeaderPath("b/", diff.path);

  let oldCount = 0;
  let newCount = 0;
  const bodyLines: string[] = [];

  for (const line of hunk.lines) {
    if (line.kind === "context") {
      oldCount += 1;
      newCount += 1;
      bodyLines.push(` ${line.content}`);
    } else if (line.kind === "del") {
      oldCount += 1;
      bodyLines.push(`-${line.content}`);
    } else {
      newCount += 1;
      bodyLines.push(`+${line.content}`);
    }
    if (line.noNewline) {
      bodyLines.push("\\ No newline at end of file");
    }
  }

  const oldStart = diff.isNew ? 0 : hunk.oldStart;
  const newStart = diff.isDeleted ? 0 : hunk.newStart;
  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;

  const lines = [
    `--- ${oldHeader}`,
    `+++ ${newHeader}`,
    header,
    ...bodyLines,
    "",
  ];
  return lines.join("\n");
}

export const SCM_BADGE_CLASS: Record<ScmChangeKind, string> = {
  M: "text-warn",
  A: "text-ok",
  D: "text-err",
  R: "text-info",
  C: "text-info",
  T: "text-keyword",
  U: "text-ok",
  "!": "text-err",
};

export const SCM_BADGE_LABEL: Record<ScmChangeKind, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type Changed",
  U: "Untracked",
  "!": "Conflicted",
};

export function formatRelativeTime(unixSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!unixSeconds || unixSeconds <= 0) return "";
  const delta = Math.max(0, nowSeconds - unixSeconds);
  if (delta < 60) return "just now";
  const mins = Math.floor(delta / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

/** Compact relative age without "ago" for dense rows like the commit graph title line. */
export function formatCompactRelativeTime(unixSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!unixSeconds || unixSeconds <= 0) return "";
  const delta = Math.max(0, nowSeconds - unixSeconds);
  if (delta < 60) return "now";
  const mins = Math.floor(delta / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}
