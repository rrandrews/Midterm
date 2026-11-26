import fuzzysort, { type SnapshotKeys } from "fuzzysort";
import type { FoundEntry, TextMatch, TextSearchFile } from "../ipc/fs";

/*
 * Pure helpers for the explorer's search (ExplorerSearch.tsx): fuzzy name
 * matching over the entries of a folder, text search results flattened to
 * rows, and splitting a line into highlighted segments. No I/O, no React;
 * unit-tested in search.test.ts.
 */

/** A `[start, end)` range of UTF-16 indexes into a string. */
export type Range = readonly [number, number];

export type Segment = { text: string; hit: boolean };

/** Merges overlapping or touching ranges, drops empty ones, clips to `length`. */
export function normalizeRanges(ranges: readonly Range[], length: number): Range[] {
  const sorted = ranges
    .map(([start, end]) => [Math.max(0, start), Math.min(length, end)] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** `text` cut into pieces that are, or are not, inside `ranges`. */
export function segments(text: string, ranges: readonly Range[]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [start, end] of normalizeRanges(ranges, text.length)) {
    if (start > at) out.push({ text: text.slice(at, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** Fuzzysort's matched character indexes as ranges (runs of consecutive indexes). */
export function indexesToRanges(indexes: readonly number[]): Range[] {
  const ranges: [number, number][] = [];
  for (const index of indexes) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === index) last[1] = index + 1;
    else ranges.push([index, index + 1]);
  }
  return ranges;
}

/** A match line without its leading whitespace (indentation is noise in a narrow list), the ranges moved to fit. */
export function trimPreview(text: string, ranges: readonly Range[]): { text: string; ranges: Range[] } {
  const lead = text.length - text.trimStart().length;
  if (lead === 0) return { text, ranges: [...ranges] };
  return { text: text.slice(lead), ranges: ranges.map(([start, end]) => [start - lead, end - lead] as const) };
}

/* Name search */

export const NAME_RESULT_LIMIT = 200;

export type NameItem = {
  path: string;
  dir: boolean;
  name: string;
  /** The path without the name (no trailing slash); `""` at the top. */
  parent: string;
};

/** The entries of a folder, prepared once so that each keystroke only scans. */
export type NameIndex = {
  items: NameItem[];
  snapshot: SnapshotKeys<NameItem>;
};

export type NameResult = {
  path: string;
  dir: boolean;
  name: string;
  parent: string;
  /** Matched ranges in `name`. */
  nameRanges: Range[];
  /** Matched ranges in `parent`. */
  parentRanges: Range[];
};

export function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** Prepares the entries of a folder for `searchNames`. */
export function indexEntries(entries: readonly FoundEntry[]): NameIndex {
  const items = entries.map((entry) => ({
    path: entry.path,
    dir: entry.dir,
    name: baseNameOf(entry.path),
    parent: parentOf(entry.path),
  }));
  return { items, snapshot: fuzzysort.snapshot(items, { keys: ["name", "path"] }) };
}

/**
 * Entries matching `query`, best first. A match in the name beats one
 * spread over the directories (as in the palette).
 */
export function searchNames(query: string, index: NameIndex, limit = NAME_RESULT_LIMIT): NameResult[] {
  const text = query.trim();
  if (!text) return [];
  const results = fuzzysort.go(text, index.snapshot, {
    limit,
    threshold: 0.2,
    scoreFn: (result) => Math.max((result[0]?.score ?? 0) * 1.1, result[1]?.score ?? 0),
  });
  // Equal scores: shallower paths first, then by path, so the order is stable.
  const depth = (path: string) => path.split("/").length;
  const ranked = [...results].sort(
    (a, b) => b.score - a.score || depth(a.obj.path) - depth(b.obj.path) || a.obj.path.localeCompare(b.obj.path),
  );
  return ranked.map((result) => {
    const { name, parent, path, dir } = result.obj;
    if (result[0]?.score) {
      return { path, dir, name, parent, nameRanges: indexesToRanges(result[0].indexes), parentRanges: [] };
    }
    // Only the full path matched: split its indexes between the directories and the name.
    const nameStart = path.length - name.length;
    const indexes = result[1]?.indexes ?? [];
    return {
      path,
      dir,
      name,
      parent,
      nameRanges: indexesToRanges(indexes.filter((i) => i >= nameStart).map((i) => i - nameStart)),
      parentRanges: indexesToRanges(indexes.filter((i) => i < parent.length)),
    };
  });
}

/* Text search */

export type TextRow =
  | { type: "file"; key: string; path: string; count: number; collapsed: boolean }
  | { type: "match"; key: string; path: string; match: TextMatch };

/** The rows of the results list: a header per file, then its matches unless collapsed. */
export function flattenResults(files: readonly TextSearchFile[], collapsed: ReadonlySet<string>): TextRow[] {
  const rows: TextRow[] = [];
  for (const file of files) {
    const isCollapsed = collapsed.has(file.path);
    rows.push({ type: "file", key: `f:${file.path}`, path: file.path, count: file.matches.length, collapsed: isCollapsed });
    if (isCollapsed) continue;
    for (const match of file.matches) {
      rows.push({ type: "match", key: `m:${file.path}:${match.line}:${match.column}`, path: file.path, match });
    }
  }
  return rows;
}

/** Index of the first match row (what Enter should open first), else 0. */
export function firstMatchIndex(rows: readonly TextRow[]): number {
  const index = rows.findIndex((row) => row.type === "match");
  return index === -1 ? 0 : index;
}

export function countMatches(files: readonly TextSearchFile[]): number {
  return files.reduce((total, file) => total + file.matches.length, 0);
}

const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

/** "12 results in 3 files". */
export function resultsSummary(matches: number, files: number): string {
  return `${plural(matches, "result")} in ${plural(files, "file")}`;
}
