import { isWithin, relativePath } from "../explorer/tree";

/*
 * Pure helpers for the editor: file text in and out of CodeMirror, the
 * smallest change between two texts, indentation, breadcrumbs. No I/O, no
 * DOM; unit-tested in text.test.ts.
 */

const BOM = "﻿";

/** How a file's text was stored, so saving writes it back the same way. */
export type TextFormat = {
  /** Started with a UTF-8 byte order mark. */
  bom: boolean;
  /** Line ending used when saving (CodeMirror keeps lines without their endings). */
  lineEnding: "\n" | "\r\n";
};

/** Splits file text into the text CodeMirror gets and how it was stored. The first line break decides the ending. */
export function decodeText(raw: string): { text: string; format: TextFormat } {
  const bom = raw.startsWith(BOM);
  const text = bom ? raw.slice(1) : raw;
  const firstBreak = text.indexOf("\n");
  const lineEnding = firstBreak > 0 && text[firstBreak - 1] === "\r" ? "\r\n" : "\n";
  return { text, format: { bom, lineEnding } };
}

/** File text for a document whose lines are joined with `\n`. */
export function encodeText(text: string, format: TextFormat): string {
  const body = format.lineEnding === "\n" ? text : text.replace(/\n/g, "\r\n");
  return format.bom ? BOM + body : body;
}

/**
 * The single replacement that turns `from` into `to`: their common prefix
 * and suffix are left alone, so a reload keeps the cursor and scroll
 * position wherever the text did not change. `null` if they are equal.
 */
export function minimalChange(from: string, to: string): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  const max = Math.min(from.length, to.length);
  let start = 0;
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)
  ) {
    end++;
  }
  // Never split a surrogate pair.
  if (start > 0 && isHighSurrogate(from.charCodeAt(start - 1))) start--;
  if (end > 0 && isLowSurrogate(from.charCodeAt(from.length - end))) end--;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The indentation a file uses: `"\t"` if more indented lines start with a
 * tab than with spaces, else the smallest space indent (2–8), or `null` if
 * there is too little to tell.
 */
export function detectIndent(text: string): string | null {
  let tabs = 0;
  let spaced = 0;
  let smallest = Infinity;
  const lines = text.split("\n", 2000);
  for (const line of lines) {
    if (line.startsWith("\t")) tabs++;
    else if (line.startsWith(" ")) {
      const width = line.length - line.trimStart().length;
      // Lone spaces, e.g. the " * " of a block comment, say nothing.
      if (width < 2 || line.trim() === "" || line.trimStart().startsWith("*")) continue;
      spaced++;
      smallest = Math.min(smallest, width);
    }
  }
  if (tabs + spaced < 3) return null;
  if (tabs > spaced) return "\t";
  return " ".repeat(Math.min(8, Math.max(2, smallest)));
}

/**
 * The breadcrumb segments for a file: relative to its repository when it is
 * in one (as in the mockup, `src › components › SplitNode.tsx`), else from
 * the home directory (`~ › notes.md`), else from the root.
 */
export function breadcrumbSegments(
  path: string,
  { repoRoot, home }: { repoRoot?: string | null; home?: string },
): string[] {
  const split = (relative: string) => relative.split("/").filter(Boolean);
  if (repoRoot && repoRoot !== path && isWithin(path, repoRoot)) return split(relativePath(path, repoRoot));
  if (home && home !== path && isWithin(path, home)) return ["~", ...split(relativePath(path, home))];
  return split(path);
}

/** A position in a document for 1-based `line` and `column`, clamped to the document. */
export function clampPosition(
  lines: number,
  lineLength: (line: number) => number,
  line: number,
  column = 1,
): { line: number; column: number } {
  const clampedLine = Math.min(Math.max(1, Math.floor(line) || 1), lines);
  const maxColumn = lineLength(clampedLine) + 1;
  return { line: clampedLine, column: Math.min(Math.max(1, Math.floor(column) || 1), maxColumn) };
}
