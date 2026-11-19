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

let dragged: string | null = null;
let hovered: HTMLElement | null = null;
let onDrop: ((paneId: string, target: string) => void) | null = null;

/** Called by the layout's drag preview, which only exists during a pane drag. */
export function notePaneDrag(paneId: string): void {
  dragged = paneId;
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
 * Starts watching for pane drops; `drop` is called with the pane and the
 * target's `data-pane-drop` value. Returns a function that stops.
 */
export function installPaneDropTargets(drop: (paneId: string, target: string) => void): () => void {
  onDrop = drop;

  const onPointerMove = (event: PointerEvent) => {
    if (dragged) setHovered(targetAt(event.clientX, event.clientY));
  };
  const onPointerUp = (event: PointerEvent) => {
    const paneId = dragged;
    const target = paneId && targetAt(event.clientX, event.clientY)?.dataset.paneDrop;
    end();
    // After the library has finished (cancelling) its own drag.
    if (paneId && target) setTimeout(() => onDrop?.(paneId, target), 0);
  };

  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", end, true);
  // Escape cancels the library's drag.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") end();
  };
  window.addEventListener("keydown", onKeyDown, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    onDrop = null;
    end();
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", end, true);
  };
}
