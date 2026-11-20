import type { Terminal } from "@xterm/xterm";

/*
 * Sizing the terminal to its host. This is `@xterm/addon-fit` minus one
 * thing: the addon keeps a strip as wide as xterm's scroll bar free at the
 * right, and our scroll bar is a slim overlay drawn over the content (see
 * `.terminal-host .xterm-scrollable-element` in index.css), like the app's
 * other scroll bars.
 */

/** xterm never goes below these. */
const MIN_COLS = 2;
const MIN_ROWS = 1;

export type FitInput = {
  /** The host's content box. */
  width: number;
  height: number;
  /** Padding of the `.xterm` element, which xterm draws inside. */
  paddingX: number;
  paddingY: number;
  /** CSS size of one cell. */
  cellWidth: number;
  cellHeight: number;
};

/** Columns and rows that fit, or null when the cell size is not known yet. */
export function fitDimensions(input: FitInput): { cols: number; rows: number } | null {
  const { width, height, paddingX, paddingY, cellWidth, cellHeight } = input;
  if (!(cellWidth > 0) || !(cellHeight > 0)) return null;
  return {
    cols: Math.max(MIN_COLS, Math.floor(Math.max(0, width - paddingX) / cellWidth)),
    rows: Math.max(MIN_ROWS, Math.floor(Math.max(0, height - paddingY) / cellHeight)),
  };
}

type RenderDimensions = { css: { cell: { width: number; height: number } } };

/** Resizes `term` to fill its host, if that changes anything. */
export function fitTerminal(term: Terminal): void {
  const element = term.element;
  const host = element?.parentElement;
  if (!element || !host) return;
  // The same private field the fit addon reads: xterm has no public API for the cell size.
  const core = (term as unknown as { _core?: { _renderService?: { dimensions?: RenderDimensions } } })._core;
  const cell = core?._renderService?.dimensions?.css.cell;
  if (!cell) return;
  const hostStyle = getComputedStyle(host);
  const style = getComputedStyle(element);
  const px = (value: string) => Number.parseFloat(value) || 0;
  const dims = fitDimensions({
    width: px(hostStyle.width),
    height: px(hostStyle.height),
    paddingX: px(style.paddingLeft) + px(style.paddingRight),
    paddingY: px(style.paddingTop) + px(style.paddingBottom),
    cellWidth: cell.width,
    cellHeight: cell.height,
  });
  if (!dims || (dims.cols === term.cols && dims.rows === term.rows)) return;
  // Like the addon: drop the renderer's cache so the resize redraws everything.
  (core as { _renderService?: { clear?: () => void } })._renderService?.clear?.();
  term.resize(dims.cols, dims.rows);
}
