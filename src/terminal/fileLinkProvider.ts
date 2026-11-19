import type { IBufferCellPosition, IDisposable, ILink, Terminal } from "@xterm/xterm";
import { openFile } from "../actions";
import * as fs from "../ipc/fs";
import { homeDirectory } from "../ipc/system";
import { findFileLinks, resolveLinkPath } from "./fileLinks";

/*
 * Makes file references in terminal output (`src/a.ts:12:5`, see
 * fileLinks.ts) links: ⌘-click (or Ctrl-click) opens the file in an editor
 * in the terminal's tab, at that line. Relative paths are resolved against
 * the terminal's working directory, and only files that exist become links;
 * lookups are cached briefly, so hovering over a busy screen does not stat
 * the same paths again and again.
 */

const FOUND_MS = 10_000;
const MISSING_MS = 3_000;
const CACHE_LIMIT = 2000;
/** Lookups by path, kept until `until` (a miss for less long: the file may be about to appear). */
const cache = new Map<string, { exists: Promise<boolean>; until: number }>();

function isFile(path: string): Promise<boolean> {
  const cached = cache.get(path);
  if (cached && Date.now() < cached.until) return cached.exists;
  const entry = {
    exists: fs.stat(path).then(
      (found) => found?.kind === "file",
      () => false,
    ),
    until: Date.now() + MISSING_MS,
  };
  void entry.exists.then((exists) => {
    if (exists) entry.until = Date.now() + FOUND_MS;
  });
  cache.delete(path);
  cache.set(path, entry);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return entry.exists;
}

/**
 * The logical line (a row and the rows wrapped onto it) containing buffer
 * row `y` (1-based), as text, with each string index's cell position.
 */
function readLogicalLine(term: Terminal, y: number): { text: string; cells: IBufferCellPosition[] } {
  const buffer = term.buffer.active;
  let first = y - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let last = y - 1;
  while (buffer.getLine(last + 1)?.isWrapped) last++;

  let text = "";
  const cells: IBufferCellPosition[] = [];
  const cell = buffer.getNullCell();
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue; // second half of a wide character
      const chars = cell.getChars() || " ";
      text += chars;
      for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: row + 1 });
    }
  }
  return { text, cells };
}

/** Registers the link provider on `term`. `cwd` is the shell's current directory. */
export function registerFileLinks(term: Terminal, paneId: string, cwd: () => string | undefined): IDisposable {
  return term.registerLinkProvider({
    provideLinks(y, callback) {
      const { text, cells } = readLogicalLine(term, y);
      const matches = findFileLinks(text).filter(
        (match) => cells[match.start]?.y <= y && cells[match.end - 1]?.y >= y,
      );
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      const directory = cwd();
      const home = homeDirectory();
      void Promise.all(
        matches.map(async (match): Promise<ILink | null> => {
          const path = resolveLinkPath(match.path, directory, home);
          if (!path || !(await isFile(path))) return null;
          return {
            range: { start: cells[match.start], end: cells[match.end - 1] },
            text: text.slice(match.start, match.end),
            decorations: { pointerCursor: true, underline: true },
            activate(event) {
              // Plain clicks are for selecting text and the shell's mouse mode.
              if (!event.metaKey && !event.ctrlKey) return;
              openFile(path, { fromPaneId: paneId, line: match.line, column: match.column });
            },
          };
        }),
      ).then((links) => {
        const found = links.filter((link): link is ILink => link !== null);
        callback(found.length ? found : undefined);
      });
    },
  });
}
