import type { IBuffer, IBufferCell, ITheme } from "@xterm/xterm";

/*
 * Turns rows of an xterm buffer into styled text runs for the blocks view
 * (and plain text for copying). Rows that xterm soft-wrapped are joined
 * into one logical line, which the DOM wraps again at its own width, so
 * blocks reflow with CSS rather than with the terminal.
 */

export type Run = {
  text: string;
  /** CSS color; unset for the default foreground. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** The terminal cursor is on this run (a single cell). */
  cursor?: boolean;
};

export type Line = Run[];

/** The `[from, to)` rows that make up each logical line in the range. */
export function logicalLines(buffer: IBuffer, from: number, to: number): [number, number][] {
  const lines: [number, number][] = [];
  for (let row = from; row < to; row++) {
    const line = buffer.getLine(row);
    if (row > from && line?.isWrapped && lines.length) lines[lines.length - 1][1] = row + 1;
    else lines.push([row, row + 1]);
  }
  return lines;
}

/**
 * Plain text of rows `[from, to)`: wrapped rows joined, trailing blanks and
 * blank last lines dropped. `lastCells` cuts the last logical line short.
 */
export function rowsText(buffer: IBuffer, from: number, to: number, cols: number, lastCells?: number): string {
  const out: string[] = [];
  const lines = logicalLines(buffer, from, to);
  lines.forEach(([start, end], index) => {
    const limit = index === lines.length - 1 ? lastCells : undefined;
    let text = "";
    for (let row = start; row < end; row++) {
      const line = buffer.getLine(row);
      const endCol = limit === undefined ? undefined : limit - (row - start) * cols;
      if (endCol !== undefined && endCol <= 0) break;
      // Only the last row of a wrapped line can end in real blanks.
      if (line) text += line.translateToString(row === end - 1, 0, endCol === undefined ? undefined : Math.min(endCol, cols));
    }
    out.push(text.trimEnd());
  });
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join("\n");
}

/** The xterm 256-color palette: theme colors for 0–15, the standard cube and grays above. */
export function palette(theme: ITheme): string[] {
  const base = [
    theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white,
    theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
    theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
  ];
  const fallback = ["#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff"];
  const colors = base.map((color, i) => color ?? fallback[i]);
  const steps = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) {
    colors.push(hex((steps[Math.floor(i / 36)] << 16) | (steps[Math.floor(i / 6) % 6] << 8) | steps[i % 6]));
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    colors.push(hex((v << 16) | (v << 8) | v));
  }
  return colors;
}

function hex(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, "0")}`;
}

type Style = Omit<Run, "text" | "cursor">;

function cellStyle(cell: IBufferCell, colors: string[], theme: ITheme): Style {
  const style: Style = {};
  const bold = cell.isBold() !== 0;
  let fg: string | undefined;
  let bg: string | undefined;
  if (cell.isFgRGB()) fg = hex(cell.getFgColor());
  else if (cell.isFgPalette()) {
    let index = cell.getFgColor();
    // xterm's default (drawBoldTextInBrightColors): bold ANSI colors are bright.
    if (bold && index < 8) index += 8;
    fg = colors[index];
  }
  if (cell.isBgRGB()) bg = hex(cell.getBgColor());
  else if (cell.isBgPalette()) bg = colors[cell.getBgColor()];
  if (cell.isInverse()) {
    [fg, bg] = [bg ?? theme.cursorAccent ?? "#000000", fg ?? theme.foreground ?? "#ffffff"];
  }
  if (cell.isInvisible()) fg = "transparent";
  if (fg) style.fg = fg;
  if (bg) style.bg = bg;
  if (bold) style.bold = true;
  if (cell.isItalic()) style.italic = true;
  if (cell.isDim()) style.dim = true;
  if (cell.isUnderline()) style.underline = true;
  if (cell.isStrikethrough()) style.strike = true;
  return style;
}

function sameStyle(a: Style, b: Style): boolean {
  return (
    a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic &&
    a.dim === b.dim && a.underline === b.underline && a.strike === b.strike
  );
}

export type RenderOptions = {
  theme: ITheme;
  cols: number;
  /** Buffer row and column of a cursor to draw, if any. */
  cursor?: { row: number; col: number };
  /** Cells of the last logical line to draw (the rest belongs to someone else). */
  lastCells?: number;
};

/** Styled runs for each logical line in rows `[from, to)`. */
export function renderRows(buffer: IBuffer, from: number, to: number, options: RenderOptions): Line[] {
  const colors = palette(options.theme);
  const cell = buffer.getNullCell();
  const lines: Line[] = [];
  const logical = logicalLines(buffer, from, to);
  for (const [index, [start, end]] of logical.entries()) {
    const limit = index === logical.length - 1 ? options.lastCells : undefined;
    const runs: Line = [];
    let text = "";
    let style: Style = {};
    const flush = () => {
      if (text) runs.push({ text, ...style });
      text = "";
    };
    for (let row = start; row < end; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const width = Math.min(line.length, options.cols);
      // Skip trailing cells with nothing to show (on the last row of the line).
      let last = width;
      const cursorCol = options.cursor?.row === row ? options.cursor.col : -1;
      if (row === end - 1) {
        while (last > 0) {
          const c = line.getCell(last - 1, cell);
          if (!c || c.getChars() !== "" || !c.isBgDefault() || c.isInverse()) break;
          last--;
        }
        if (cursorCol >= last) last = cursorCol + 1;
      }
      if (limit !== undefined) last = Math.min(last, limit - (row - start) * options.cols);
      for (let x = 0; x < last; x++) {
        const c = line.getCell(x, cell);
        if (!c) {
          // Past the line's end (only reachable for the cursor).
          if (x === cursorCol) {
            flush();
            runs.push({ text: " ", cursor: true });
          } else text += " ";
          continue;
        }
        if (c.getWidth() === 0) continue; // the second half of a wide character
        const chars = c.getChars() || " ";
        const cellStyleNow = cellStyle(c, colors, options.theme);
        if (x === cursorCol) {
          flush();
          runs.push({ text: chars, ...cellStyleNow, cursor: true });
          style = cellStyleNow;
          continue;
        }
        if (!sameStyle(style, cellStyleNow)) {
          flush();
          style = cellStyleNow;
        }
        text += chars;
      }
    }
    flush();
    lines.push(runs);
  }
  return lines;
}

/** "0.04s", "2.3s", "1m 05s", "2h 03m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 1) return `${s.toFixed(2)}s`;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** A piece of a line: runs inside one link's range (`link` set), or between links. */
export type LinkSegment<L> = { link?: L; runs: Run[] };

/**
 * Splits a line's runs at the `[start, end)` ranges of `links` (string
 * indices into the line's text, sorted, not overlapping), so each link can
 * wrap its own runs and keep their styles.
 */
export function splitAtLinks<L extends { start: number; end: number }>(runs: readonly Run[], links: readonly L[]): LinkSegment<L>[] {
  const segments: LinkSegment<L>[] = [];
  let current: LinkSegment<L> | undefined;
  let index = 0;
  let next = 0;
  const segmentFor = (link: L | undefined) => {
    if (!current || current.link !== link) {
      current = link ? { link, runs: [] } : { runs: [] };
      segments.push(current);
    }
    return current;
  };
  for (const run of runs) {
    let offset = 0;
    while (offset < run.text.length) {
      const at = index + offset;
      while (next < links.length && links[next].end <= at) next++;
      const link = links[next];
      const inside = link !== undefined && link.start <= at;
      // Up to the next boundary: the link's end, or its start.
      const boundary = inside ? link.end : (link?.start ?? Infinity);
      const length = Math.min(run.text.length - offset, boundary - at);
      segmentFor(inside ? link : undefined).runs.push({ ...run, text: run.text.slice(offset, offset + length) });
      offset += length;
    }
    index += run.text.length;
  }
  return segments;
}
