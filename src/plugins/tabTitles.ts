import { findPane, listPanes } from "../state/layout";
import { useAppStore } from "../state/store";
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
      let title: string | undefined;
      try {
        title = paneSpec(pane.data.kind)?.tabTitle?.(pane);
      } catch (error) {
        console.error(`tabTitle of ${pane.data.kind} failed:`, error);
      }
      if (title) state.setAutoTitle(tab.id, title);
    }
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
