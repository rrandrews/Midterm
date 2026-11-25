import type { IBufferCellPosition, IBufferRange, IDisposable, ILink, Terminal } from "@xterm/xterm";
import { type AnchorRect, clickPath, findPathLinks, isNewPaneClick, leaveHoveredPath, setHoveredPath } from "./pathTargets";

/*
 * Makes files and folders named in terminal output links: paths and
 * references (`src/a.ts:12:5`, see fileLinks.ts) and bare names as `ls`
 * prints them. Hovering one underlines it and shows its tooltip; a click
 * opens a file in an editor in the terminal's tab (at that line) or `cd`s
 * to a folder, ⌘-click (or Ctrl-click) opens either in a new pane, and a
 * right click opens its own menu (pathTargets.ts, TerminalPane).
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
  /** False while a program reads the mouse (vim, htop): plain clicks are its own. */
  plainClicks: () => boolean,
): IDisposable {
  // Where the last button press was: a link is clicked only by the main
  // button, released where it went down (a drag selects text; xterm
  // reports the selection only after it activates the link).
  let press: { button: number; x: number; y: number } | null = null;
  const onPress = (event: MouseEvent) => {
    press = { button: event.button, x: event.clientX, y: event.clientY };
  };
  window.addEventListener("mousedown", onPress, true);
  const isClick = (event: MouseEvent) =>
    event.button === 0 && press?.button === 0 && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= CLICK_SLOP;
  const provider = term.registerLinkProvider({
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
          .map(({ start, end, target }): ILink => {
            // Inclusive; a wide last character covers its second cell too.
            const linkRange: IBufferRange = {
              start: cells[start],
              end: { x: cells[end - 1].x + Math.max(0, widths[end - 1] - 1), y: cells[end - 1].y },
            };
            return {
              range: linkRange,
              text: text.slice(start, end),
              decorations: { pointerCursor: true, underline: true },
              activate(event) {
                const newPane = isNewPaneClick(event);
                // A drag that selected text is not a click; a program reading the mouse gets plain clicks.
                if (!isClick(event) || (!newPane && !plainClicks())) return;
                clickPath(target, paneId, { newPane });
              },
              hover: (event) => setHoveredPath(paneId, target, "terminal", linkRect(term, linkRange) ?? pointRect(event)),
              leave: () => leaveHoveredPath(paneId, target),
            };
          });
        callback(links.length ? links : undefined);
      });
    },
  });
  return {
    dispose: () => {
      provider.dispose();
      window.removeEventListener("mousedown", onPress, true);
    },
  };
}

/** How far (px) the pointer may move between press and release for a click. */
const CLICK_SLOP = 3;

/** Where the first row of `range` is on screen, if it is in view. */
function linkRect(term: Terminal, range: IBufferRange): AnchorRect | undefined {
  const screen = term.element?.querySelector(".xterm-screen");
  if (!screen || !term.cols || !term.rows) return undefined;
  const box = screen.getBoundingClientRect();
  const cellWidth = box.width / term.cols;
  const cellHeight = box.height / term.rows;
  const row = range.start.y - 1 - term.buffer.active.viewportY;
  if (row < 0 || row >= term.rows) return undefined;
  const lastX = range.end.y === range.start.y ? range.end.x : term.cols;
  return {
    left: box.left + (range.start.x - 1) * cellWidth,
    top: box.top + row * cellHeight,
    width: (lastX - range.start.x + 1) * cellWidth,
    height: cellHeight,
  };
}

function pointRect(event: MouseEvent): AnchorRect {
  return { left: event.clientX, top: event.clientY, width: 1, height: 1 };
}
