import { type DockHandle, focusPane, getDock } from "./layout/dock";
import { countPanes, createPane, frameIdOf, listPanes, singlePaneLayout } from "./state/layout";
import { findTabOfPane, selectActiveTab, selectActiveWorkspace, useAppStore } from "./state/store";
import type { Layout, PaneData, PaneKind } from "./state/types";

/*
 * User-level commands, shared by menus and keyboard shortcuts.
 * Commands that take an optional pane default to the active pane.
 */

const store = () => useAppStore.getState();

/** The active tab's layout, as current as possible. */
function activeLayout(): { dock: DockHandle | null; layout: Layout } {
  const tab = selectActiveTab(store());
  const dock = getDock(tab);
  return { dock, layout: dock?.getModel() ?? tab.layout };
}

/** The pane that last had focus in the active tab (its first pane if none has yet). */
export function activePaneId(): string | undefined {
  const { activePaneId: remembered } = selectActiveTab(store());
  const panes = listPanes(activeLayout().layout);
  return panes.find((pane) => pane.id === remembered)?.id ?? panes[0]?.id;
}

export function focusActivePane(): void {
  focusPane(activePaneId());
}

/** Working directory for a new terminal opened from `paneId`: that pane's, if known. */
function cwdFrom(paneId: string | undefined): string | undefined {
  if (!paneId) return undefined;
  const tab = findTabOfPane(store(), paneId);
  const layout = (tab && getDock(tab)?.getModel()) ?? tab?.layout;
  return layout && listPanes(layout).find((pane) => pane.id === paneId)?.data.cwd;
}

/**
 * Merges `patch` into a pane's data, through the mounted layout if its tab
 * is showing (so it is not remounted), else in the store.
 */
export function updatePaneData(paneId: string, patch: Partial<PaneData>): void {
  const tab = findTabOfPane(store(), paneId);
  if (!tab) return;
  const dock = getDock(tab);
  const pane = dock && listPanes(dock.getModel()).find((candidate) => candidate.id === paneId);
  if (dock && pane) dock.updateTab(paneId, { data: { ...pane.data, ...patch } });
  else store().updatePaneData(paneId, patch);
}

/** Opens a tab with one terminal, in the active pane's directory. */
export function newTab(): void {
  const cwd = cwdFrom(activePaneId());
  store().addTab({ layout: singlePaneLayout(createPane("terminal", { cwd })) });
  focusPane(listPanes(selectActiveTab(store()).layout)[0]?.id);
}

export function selectTab(tabId: string): void {
  store().setActiveTab(tabId);
  focusActivePane();
}

export function selectTabAt(index: number): void {
  const tab = selectActiveWorkspace(store()).tabs[index];
  if (tab) selectTab(tab.id);
}

export function cycleTab(delta: 1 | -1): void {
  const { tabs, activeTabId } = selectActiveWorkspace(store());
  const index = tabs.findIndex((tab) => tab.id === activeTabId);
  selectTab(tabs[(index + delta + tabs.length) % tabs.length].id);
}

export function closeTab(tabId: string = selectActiveTab(store()).id): void {
  store().closeTab(tabId);
  focusActivePane();
}

export function newWorkspace(): void {
  store().addWorkspace();
  focusActivePane();
}

export function selectWorkspace(workspaceId: string): void {
  store().setActiveWorkspace(workspaceId);
  focusActivePane();
}

export function removeWorkspace(workspaceId: string): void {
  store().removeWorkspace(workspaceId);
  focusActivePane();
}

/** Adds a terminal beside (`right`) or below (`bottom`) a pane, taking half its space. */
export function splitPane(region: "right" | "bottom", paneId = activePaneId()): void {
  const { dock, layout } = activeLayout();
  const frameId = paneId && frameIdOf(layout, paneId);
  if (!dock || !frameId) return;
  const pane = createPane("terminal", { cwd: cwdFrom(paneId) });
  if (dock.addTab(pane, { target: { tabsetId: frameId, region } })) focusPane(pane.id);
}

/** Closes a pane; closing a tab's only pane closes the tab. */
export function closePane(paneId = activePaneId()): void {
  if (!paneId) return;
  const tab = findTabOfPane(store(), paneId);
  if (!tab) return;
  const wasActive = selectActiveTab(store()).id === tab.id;

  const dock = getDock(tab);
  const layout = dock?.getModel() ?? tab.layout;
  if (countPanes(layout) <= 1) {
    store().closeTab(tab.id);
    if (wasActive) focusActivePane();
    return;
  }

  // Focus moves to the pane before the closed one (or after, for the first).
  const panes = listPanes(layout);
  const index = panes.findIndex((pane) => pane.id === paneId);
  const neighbour = panes[index > 0 ? index - 1 : 1]?.id;
  const focused = activePaneId();

  if (dock) dock.closeTab(paneId);
  else store().removePane(paneId);

  if (wasActive) focusPane(focused === paneId ? neighbour : focused);
}

export function setPaneKind(paneId: string, kind: PaneKind): void {
  const { dock, layout } = activeLayout();
  const pane = listPanes(layout).find((candidate) => candidate.id === paneId);
  if (!dock || !pane || pane.data.kind === kind) return;
  dock.updateTab(paneId, { data: { ...pane.data, kind } });
  focusPane(paneId);
}

export function movePaneToNewTab(paneId: string): void {
  store().movePaneToNewTab(paneId);
  focusPane(paneId);
}

export type Direction = "left" | "right" | "up" | "down";

/** Moves focus to the nearest pane in a direction, by on-screen geometry. */
export function focusNeighbourPane(direction: Direction): void {
  const current = activePaneId();
  const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]"));
  const from = elements.find((el) => el.dataset.paneId === current)?.getBoundingClientRect();
  if (!from) return;

  const horizontal = direction === "left" || direction === "right";
  const forward = direction === "right" || direction === "down";
  const crossCentre = horizontal ? from.top + from.height / 2 : from.left + from.width / 2;

  let best: { id: string; gap: number; aligned: boolean } | undefined;
  for (const el of elements) {
    const id = el.dataset.paneId;
    if (!id || id === current) continue;
    const rect = el.getBoundingClientRect();
    // Distance to travel along the direction's axis; panes behind us don't count.
    const gap = horizontal
      ? forward
        ? rect.left - from.right
        : from.left - rect.right
      : forward
        ? rect.top - from.bottom
        : from.top - rect.bottom;
    if (gap < -1) continue;
    const [crossStart, crossEnd, fromStart, fromEnd] = horizontal
      ? [rect.top, rect.bottom, from.top, from.bottom]
      : [rect.left, rect.right, from.left, from.right];
    // Must share an edge span with the current pane, not just be further along.
    if (Math.min(crossEnd, fromEnd) - Math.max(crossStart, fromStart) <= 0) continue;
    const aligned = crossStart <= crossCentre && crossCentre <= crossEnd;
    if (!best || gap < best.gap - 1 || (Math.abs(gap - best.gap) <= 1 && aligned && !best.aligned)) {
      best = { id, gap, aligned };
    }
  }
  if (best) focusPane(best.id);
}
