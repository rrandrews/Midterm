/*
 * Dropping a pane on a tab (or on the new-tab button).
 *
 * Pane drags belong to the layout library, which only knows about drop
 * targets inside the layout; released anywhere else, it cancels the drag.
 * So we watch the pointer ourselves while a pane drag is in progress, and
 * when it is released over an element with `data-pane-drop` we act on it.
 *
 * `data-pane-drop` is a tab id, or `"new"` for a new tab. The hovered target
 * gets `data-pane-drop-hover` for styling.
 */

const HOVER = "data-pane-drop-hover";

/** The panes being dragged: one pane (or subtab), or a frame's subtabs, shown one first. */
let dragged: string[] | null = null;
let hovered: HTMLElement | null = null;
let onDrop: ((paneIds: string[], target: string) => void) | null = null;

/** Called by the layout's drag preview, which only exists during a pane drag. */
export function notePaneDrag(paneIds: string[]): void {
  dragged = paneIds;
}

function targetAt(x: number, y: number): HTMLElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const target = el.closest<HTMLElement>("[data-pane-drop]");
    if (target) return target;
  }
  return null;
}

function setHovered(target: HTMLElement | null): void {
  if (target === hovered) return;
  hovered?.removeAttribute(HOVER);
  hovered = target;
  hovered?.setAttribute(HOVER, "");
}

function end(): void {
  dragged = null;
  setHovered(null);
}

/**
 * Starts watching for pane drops; `drop` is called with the panes and the
 * target's `data-pane-drop` value. Returns a function that stops.
 */
export function installPaneDropTargets(drop: (paneIds: string[], target: string) => void): () => void {
  onDrop = drop;

  const onPointerMove = (event: PointerEvent) => {
    if (dragged) setHovered(targetAt(event.clientX, event.clientY));
  };
  const onPointerUp = (event: PointerEvent) => {
    // The preview exists exactly while the library's drag does; without it
    // the drag was cancelled (e.g. the window lost focus) and this release
    // is an ordinary click.
    const paneIds = document.querySelector(".pane-drag-preview") ? dragged : null;
    const target = paneIds && targetAt(event.clientX, event.clientY)?.dataset.paneDrop;
    end();
    // After the library has finished (cancelling) its own drag.
    if (paneIds && target) setTimeout(() => onDrop?.(paneIds, target), 0);
  };

  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", end, true);
  // Escape cancels the library's drag.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") end();
  };
  window.addEventListener("keydown", onKeyDown, true);
  // The library cancels its drag when the window loses focus.
  window.addEventListener("blur", end);
  return () => {
    window.removeEventListener("blur", end);
    window.removeEventListener("keydown", onKeyDown, true);
    onDrop = null;
    end();
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", end, true);
  };
}
