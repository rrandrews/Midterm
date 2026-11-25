import type { IBufferCellPosition, IDisposable, ILink, Terminal } from "@xterm/xterm";
import { findPathLinks, leaveHoveredPath, openPathTarget, opensLink, setHoveredPath } from "./pathTargets";

/*
 * Makes files and folders named in terminal output links: paths and
 * references (`src/a.ts:12:5`, see fileLinks.ts) and bare names as `ls`
 * prints them. Hovering one underlines it; ⌘-click (or Ctrl-click) opens a
 * file in an editor in the terminal's tab, at that line, and a folder in an
 * explorer; right-click adds its items to the pane's menu (pathTargets.ts).
 * Relative names are resolved against the terminal's working directory,
 * and only what exists becomes a link.
 */

/**
 * The logical line (a row and the rows wrapped onto it) containing buffer
 * row `y` (1-based), as text, with each string index's cell position.
 */
function readLogicalLine(term: Terminal, y: number): { text: string; cells: IBufferCellPosition[]; widths: number[] } {
  const buffer = term.buffer.active;
  let first = y - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let last = y - 1;
  while (buffer.getLine(last + 1)?.isWrapped) last++;

  let text = "";
  const cells: IBufferCellPosition[] = [];
  /** Cells each string index's character covers (2 for a wide one). */
  const widths: number[] = [];
  const cell = buffer.getNullCell();
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue; // second half of a wide character
      const chars = cell.getChars() || " ";
      text += chars;
      for (let i = 0; i < chars.length; i++) {
        cells.push({ x: x + 1, y: row + 1 });
        widths.push(cell.getWidth());
      }
    }
  }
  return { text, cells, widths };
}

/** Registers the link provider on `term`. `cwd` is the shell's current directory. */
export function registerFileLinks(
  term: Terminal,
  paneId: string,
  /**
   * Directories to resolve names on buffer row `row` (0-based) against, in
   * order; null when what is printed there is not on this machine (a shell
   * over ssh).
   */
  directories: (row: number) => readonly (string | undefined)[] | null,
): IDisposable {
  return term.registerLinkProvider({
    provideLinks(y, callback) {
      const dirs = directories(y - 1);
      if (!dirs) {
        callback(undefined);
        return;
      }
      const { text, cells, widths } = readLogicalLine(term, y);
      void findPathLinks(text, dirs).then((found) => {
        const links = found
          // Each row is asked for separately: only the links touching this one.
          .filter((link) => cells[link.start]?.y <= y && cells[link.end - 1]?.y >= y)
          .map(({ start, end, target }): ILink => ({
            // Inclusive; a wide last character covers its second cell too.
            range: { start: cells[start], end: { x: cells[end - 1].x + Math.max(0, widths[end - 1] - 1), y: cells[end - 1].y } },
            text: text.slice(start, end),
            decorations: { pointerCursor: true, underline: true },
            activate(event) {
              // Plain clicks are for selecting text and the shell's mouse mode.
              if (opensLink(event)) openPathTarget(target, paneId);
            },
            hover: () => setHoveredPath(paneId, target, "terminal"),
            leave: () => leaveHoveredPath(paneId, target),
          }));
        callback(links.length ? links : undefined);
      });
    },
  });
}
