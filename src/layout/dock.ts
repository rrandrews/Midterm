import type { WorkspaceImperativeHandle } from "react-resizable-panels";
import type { PaneData } from "../state/types";

/*
 * Bridge between app code and the mounted pane layout.
 *
 * The layout component is uncontrolled: changes to a mounted layout go
 * through its imperative handle, which is registered here by tab id and
 * layout revision. Only the active tab's layout is mounted, so `getDock`
 * returns `null` for background tabs (callers fall back to editing the
 * stored layout).
 */

export type DockHandle = WorkspaceImperativeHandle<PaneData>;

/** Identifies one mounted layout: a tab at a particular layout revision. */
type DockKey = { id: string; layoutRev: number };

const docks = new Map<string, DockHandle>();
const keyOf = ({ id, layoutRev }: DockKey) => `${id}:${layoutRev}`;

export function registerDock(tab: DockKey, handle: DockHandle): () => void {
  const key = keyOf(tab);
  docks.set(key, handle);
  return () => {
    if (docks.get(key) === handle) docks.delete(key);
  };
}

/**
 * The handle of the mounted layout showing exactly this revision of the
 * tab's layout, or `null`. Pass the tab as it is in the store *now*: after a
 * store-side layout edit the still-mounted old layout is stale, and this
 * deliberately does not return it.
 */
export function getDock(tab: DockKey): DockHandle | null {
  return docks.get(keyOf(tab)) ?? null;
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
export function editingElsewhere(): boolean {
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

/**
 * Moves keyboard focus to a pane: now, as soon as its content mounts, or
 * (if the user is typing in a field outside the panes) when they finish.
 */
export function focusPane(paneId: string | undefined): void {
  if (!paneId) return;
  wanted = paneId;
  if (!editingElsewhere()) focusers.get(paneId)?.();
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
 * separator, a cancelled pane drag) leaves nothing useful focused, focus
 * returns to the wanted pane. Returns a function that stops.
 */
export function installFocusKeeper(): () => void {
  const onPointerUp = () => {
    // After the press has finished moving focus (or failing to).
    setTimeout(() => {
      const focused = document.activeElement;
      // The layout focuses a separator when it is pressed, for keyboard
      // resizing; after a mouse drag the keyboard belongs to the pane again.
      if (focused === document.body || focused?.matches("[data-separator]")) refocusPane();
    }, 0);
  };
  window.addEventListener("pointerup", onPointerUp, true);
  return () => window.removeEventListener("pointerup", onPointerUp, true);
}
