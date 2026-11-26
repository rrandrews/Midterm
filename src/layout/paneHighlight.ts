/*
 * Outlines one pane for a moment, e.g. while a menu item that names it is
 * highlighted (the explorer's "Link to terminal" list). Plain DOM: the
 * class goes straight on the pane's element, so nothing re-renders.
 */

const CLASS = "is-highlighted";
let current: string | null = null;

function element(paneId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.pane[data-pane-id="${CSS.escape(paneId)}"]`);
}

/** Outlines `paneId`, or nothing for `null`, replacing any other highlight. */
export function highlightPane(paneId: string | null): void {
  if (current === paneId) return;
  if (current) element(current)?.classList.remove(CLASS);
  current = paneId;
  if (paneId) element(paneId)?.classList.add(CLASS);
}

/** Ends `paneId`'s highlight if it is the one shown. */
export function unhighlightPane(paneId: string): void {
  if (current === paneId) highlightPane(null);
}
