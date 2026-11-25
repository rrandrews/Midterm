import { findPane, listPanes } from "../state/layout";
import { useAppStore } from "../state/store";
import type { PaneNode } from "../state/types";
import { paneSpec } from "./registry";

/*
 * Automatic tab titles: each tab is named by its active pane's plugin
 * (`tabTitle`, e.g. a terminal's program or directory) unless the user named
 * it. Recomputed on any store change (the active pane may have moved) and
 * whenever a plugin says its title may have changed; `setAutoTitle` ignores
 * unchanged titles.
 */

function updateTitles(): void {
  const state = useAppStore.getState();
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.titleLocked) continue;
      const pane = (tab.activePaneId && findPane(tab.layout, tab.activePaneId)) || listPanes(tab.layout)[0];
      if (!pane) continue;
      const title = paneTitle(pane);
      if (title) state.setAutoTitle(tab.id, title);
    }
  }
  for (const listener of listeners) listener();
}

/** Listeners told whenever titles are recomputed (subtab labels use `tabTitle` too). */
const listeners = new Set<() => void>();

/** Calls `listener` after each recomputation of titles. Returns an unsubscribe function. */
export function subscribeTitles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A pane's own title from its plugin's `tabTitle`, if it has one. */
export function paneTitle(pane: PaneNode): string | undefined {
  try {
    return paneSpec(pane.data.kind)?.tabTitle?.(pane) || undefined;
  } catch (error) {
    console.error(`tabTitle of ${pane.data.kind} failed:`, error);
    return undefined;
  }
}

let queued = false;

/** Recomputes tab titles soon (once per microtask, however often it is called). */
export function refreshTabTitles(): void {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    updateTitles();
  });
}

useAppStore.subscribe(refreshTabTitles);
