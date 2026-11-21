/*
 * ⌃R reverse history search for the blocks input editor: filtering and
 * selection over the editor's history entries (newest first).
 */

export interface SearchMatch {
  /** The history entry. */
  entry: string;
  /** Where the query matched in `entry`. */
  start: number;
  end: number;
}

/** Smart case: case-insensitive unless the query has an uppercase letter. */
export function searchMatches(entries: readonly string[], query: string): SearchMatch[] {
  const sensitive = query !== query.toLowerCase();
  const needle = sensitive ? query : query.toLowerCase();
  const out: SearchMatch[] = [];
  for (const entry of entries) {
    const start = (sensitive ? entry : entry.toLowerCase()).indexOf(needle);
    if (start !== -1) out.push({ entry, start, end: start + needle.length });
  }
  return out;
}

/** Selection moved by `delta` (positive = older), clamped to the list. */
export function moveSelection(selected: number, delta: number, count: number): number {
  if (count === 0) return 0;
  return Math.max(0, Math.min(count - 1, selected + delta));
}

/** Newlines shown as ⏎ so a multi-line command takes one row; offsets are unchanged. */
export function oneLine(text: string): string {
  return text.replace(/\n/g, "⏎");
}
