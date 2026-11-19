import type { WorkspaceImperativeHandle } from "react-resizable-panels";
import type { PaneData } from "../state/types";

/*
 * Bridge between app code and the mounted pane layout.
 *
 * The layout component is uncontrolled: changes to a mounted layout go
 * through its imperative handle, which is registered here by tab id. Only
 * the active tab's layout is mounted, so `getDock` returns `null` for
 * background tabs (callers fall back to editing the stored layout).
 */

export type DockHandle = WorkspaceImperativeHandle<PaneData>;

const docks = new Map<string, DockHandle>();

export function registerDock(tabId: string, handle: DockHandle): () => void {
  docks.set(tabId, handle);
  return () => {
    // A remounted layout registers its new handle before or after the old one
    // unregisters; only remove the entry if it is still ours.
    if (docks.get(tabId) === handle) docks.delete(tabId);
  };
}

export function getDock(tabId: string): DockHandle | null {
  return docks.get(tabId) ?? null;
}

/*
 * Pane focus.
 *
 * `wanted` is the pane that should hold keyboard focus. Pane content
 * registers how to focus itself; whenever the wanted pane's content mounts
 * (after a split, a tab switch, or any remount) it takes focus, so a request
 * made before the content exists is honoured once it does.
 */

const focusers = new Map<string, () => void>();
let wanted: string | null = null;

/** The user is typing in a field outside the panes (e.g. renaming a tab). */
function editingElsewhere(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el.closest("[data-pane-id]")) return false;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable;
}

export function registerPaneFocuser(paneId: string, focus: () => void): () => void {
  focusers.set(paneId, focus);
  if (wanted === paneId && !editingElsewhere()) focus();
  return () => {
    if (focusers.get(paneId) === focus) focusers.delete(paneId);
  };
}

/** Moves keyboard focus to a pane, now or as soon as its content mounts. */
export function focusPane(paneId: string | undefined): void {
  if (!paneId) return;
  wanted = paneId;
  focusers.get(paneId)?.();
}

/** Records that a pane took focus by itself (a click, or tabbing into it). */
export function notePaneFocused(paneId: string): void {
  wanted = paneId;
}

/** Returns focus to the wanted pane, e.g. after a menu closes. */
export function refocusPane(): void {
  if (wanted && !editingElsewhere()) focusers.get(wanted)?.();
}

/**
 * Returns focus to the wanted pane if a layout change left nothing focused.
 *
 * WebKit has no `Element.moveBefore`, so when the layout restructures (a
 * pane is moved or closed) the panes that shift are re-inserted into the
 * document and whichever had focus loses it. That can happen after the
 * change is reported, hence the check on the next frame as well as now.
 */
export function restoreFocusAfterLayoutChange(): void {
  const restore = () => {
    if (!document.activeElement || document.activeElement === document.body) refocusPane();
  };
  restore();
  requestAnimationFrame(restore);
}

/**
 * Keeps the keyboard in a pane: when a press on app chrome (the title bar, a
 * separator, a cancelled pane drag) leaves nothing focused, focus returns to
 * the wanted pane. Returns a function that stops.
 */
export function installFocusKeeper(): () => void {
  const onPointerUp = () => {
    // After the press has finished moving focus (or failing to).
    setTimeout(() => {
      if (document.activeElement === document.body) refocusPane();
    }, 0);
  };
  window.addEventListener("pointerup", onPointerUp, true);
  return () => window.removeEventListener("pointerup", onPointerUp, true);
}
