import { hasUnsavedChanges, renameOpenModels } from "./editor/registry";
import { noteRecentFile } from "./palette/recent";
import { type DockHandle, focusPane, getDock } from "./layout/dock";
import { convertedData, fileHandlers, newPane } from "./plugins/panes";
import { paneSpec } from "./plugins/registry";
import { countPanes, createPane, findPane, frameIdOf, listPanes, singlePaneLayout } from "./state/layout";
import {
  findTabOfPane,
  selectActiveTab,
  selectActiveWorkspace,
  selectAllPanes,
  useAppStore,
} from "./state/store";
import type { Layout, PaneData, PaneKind, PaneNode } from "./state/types";

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

/** A pane as current as possible (from the mounted layout if its tab is showing). */
export function livePane(paneId: string | undefined): PaneNode | undefined {
  if (!paneId) return undefined;
  const tab = findTabOfPane(store(), paneId);
  const layout = (tab && getDock(tab)?.getModel()) ?? tab?.layout;
  return layout && findPane(layout, paneId);
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

/**
 * Opens a tab with one pane of `kind` (the default kind: a terminal unless
 * the settings say otherwise), started from the active pane (a terminal
 * opens in its directory).
 */
export function newTab(kind?: PaneKind): void {
  const pane = newPane(kind, livePane(activePaneId()));
  store().addTab({ layout: singlePaneLayout(pane) });
  focusPane(pane.id);
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

/** Closes a tab without asking (see `src/closing.ts`). */
export function closeTabNow(tabId: string = selectActiveTab(store()).id): void {
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

/** Closes a workspace without asking (see `src/closing.ts`). */
export function removeWorkspaceNow(workspaceId: string): void {
  store().removeWorkspace(workspaceId);
  focusActivePane();
}

/** Adds a pane of the default kind beside (`right`) or below (`bottom`) a pane, taking half its space. */
export function splitPane(region: "right" | "bottom", paneId = activePaneId(), kind?: PaneKind): void {
  const { dock, layout } = activeLayout();
  const frameId = paneId && frameIdOf(layout, paneId);
  if (!dock || !frameId) return;
  const pane = newPane(kind, findPane(layout, paneId));
  if (dock.addTab(pane, { target: { tabsetId: frameId, region } })) focusPane(pane.id);
}

/** Opens a pane of `kind` beside the active pane (where there is most room). */
export function openPaneBeside(kind: PaneKind, fromPaneId = activePaneId()): void {
  if (!fromPaneId) return;
  addPaneBeside(fromPaneId, newPane(kind, livePane(fromPaneId)));
}

/**
 * Closes a pane without asking; closing a tab's only pane closes the tab.
 * User commands go through `closePane` in `src/closing.ts`, which asks first
 * if a program is running.
 */
export function closePaneNow(paneId = activePaneId()): void {
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

/** Maximizes a pane within its tab, or restores the layout if it is maximized. */
export function toggleMaximizePane(paneId = activePaneId()): void {
  const { dock, layout } = activeLayout();
  const frameId = paneId && frameIdOf(layout, paneId);
  if (!dock || !frameId || countPanes(layout) <= 1) return;
  if (layout.maximizedTabsetId === frameId) dock.restoreTabset();
  else dock.maximizeTabset(frameId);
  focusPane(paneId);
}

/** Changes a pane's kind; its plugin converts the data (editor ↔ viewer keep the file). */
export function setPaneKind(paneId: string, kind: PaneKind): void {
  const tab = findTabOfPane(store(), paneId);
  if (!tab) return;
  const dock = getDock(tab);
  const pane = findPane(dock?.getModel() ?? tab.layout, paneId);
  if (!pane || pane.data.kind === kind) return;
  const data = convertedData(pane, kind);
  if (dock) dock.updateTab(paneId, { data });
  else store().updatePaneData(paneId, data, { replace: true });
  focusPane(paneId);
}

export function movePaneToNewTab(paneId: string): void {
  store().movePaneToNewTab(paneId);
  focusPane(paneId);
}

/** Moves a pane into another tab (to the right of its panes) and shows that tab. */
export function movePaneToTab(paneId: string, tabId: string): void {
  store().movePaneToTab(paneId, tabId);
  focusPane(paneId);
}

/** A pane dropped on a tab (`target` is its id) or on the new-tab button (`"new"`). */
export function dropPaneOnTab(paneId: string, target: string): void {
  if (target === "new") movePaneToNewTab(paneId);
  else movePaneToTab(paneId, target);
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

export type OpenFileOptions = {
  /** The pane the request comes from; the file opens in its tab. */
  fromPaneId: string;
  /** Always open a new pane. */
  newPane?: boolean;
  /** Only panes of this kind (a plugin that may not claim the file by default). */
  kind?: PaneKind;
  /** 1-based line (and column) to put the cursor on, in an editor. */
  line?: number;
  column?: number;
};

/**
 * Opens a file from `fromPaneId` (an explorer, a terminal link…) in the same
 * tab: in a pane already showing it, else in an editor or viewer pane
 * already there (the last active one if several), or, with `newPane` or
 * when there is none, in a new pane split off the largest pane that is not
 * an explorer.
 *
 * An editor with unsaved changes is never given another file: the file
 * opens in a new editor pane instead, so nothing is lost and nobody is
 * asked. With a `line`, only editors are considered.
 */
export function openFile(path: string, { fromPaneId, newPane: alwaysNew = false, line, column, kind: only }: OpenFileOptions): void {
  const tab = findTabOfPane(store(), fromPaneId);
  const dock = tab && getDock(tab);
  if (!tab || !dock) return;
  // A line can only be shown by a plugin that can reveal one.
  const handlers = line !== undefined ? fileHandlers(path, { line: true }) : [];
  const kinds: PaneKind[] = (handlers.length ? handlers : fileHandlers(path))
    .map((plugin) => plugin.id)
    .filter((kind) => !only || kind === only);
  if (kinds.length === 0) return;
  noteRecentFile(path);
  const layout = dock.getModel();
  const panes = listPanes(layout);
  const reveal = (paneId: string, kind: PaneKind) => {
    if (line !== undefined) paneSpec(kind)?.reveal?.(paneId, path, line, column);
  };
  const show = (paneId: string, kind: PaneKind) => {
    reveal(paneId, kind);
    focusPane(paneId);
  };

  let kind = kinds[0];
  if (!alwaysNew) {
    for (const candidateKind of kinds) {
      const showing = panes.find((pane) => pane.data.kind === candidateKind && pane.data.path === path);
      if (showing) return show(showing.id, candidateKind);
    }
    for (const candidateKind of kinds) {
      const ofKind = panes.filter((pane) => pane.data.kind === candidateKind);
      if (ofKind.length === 0) continue;
      const free = ofKind.filter((pane) => !hasUnsavedChanges(pane.id));
      const target = free.find((pane) => pane.id === tab.activePaneId) ?? free[0];
      if (!target) {
        kind = candidateKind;
        break;
      }
      dock.updateTab(target.id, { data: { ...target.data, path } });
      return show(target.id, candidateKind);
    }
  }

  const pane = createPane(kind, { ...newPane(kind).data, path });
  reveal(pane.id, kind);
  addPaneBeside(fromPaneId, pane);
}

/**
 * Adds a pane to `fromPaneId`'s tab by splitting the roomiest pane along its
 * longer side. Panes whose plugin is not `splittable` (explorers: it
 * squeezes the tree) are split only as a last resort, and only the one the
 * request came from.
 */
export function addPaneBeside(fromPaneId: string, pane: PaneNode): void {
  const tab = findTabOfPane(store(), fromPaneId);
  const dock = tab && getDock(tab);
  if (!dock) return;
  const layout = dock.getModel();
  let best: { id: string; area: number; wide: boolean } | undefined;
  for (const candidate of listPanes(layout)) {
    const explorer = paneSpec(candidate.data.kind)?.splittable === false;
    if (explorer && candidate.id !== fromPaneId) continue;
    const rect = document
      .querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(candidate.id)}"]`)
      ?.getBoundingClientRect();
    if (!rect) continue;
    const area = rect.width * rect.height * (explorer ? 0.01 : 1);
    if (!best || area > best.area) best = { id: candidate.id, area, wide: rect.width >= rect.height * 1.2 };
  }
  const frameId = best && frameIdOf(layout, best.id);
  if (!best || !frameId) return;
  const region = best.wide ? "right" : "bottom";
  if (dock.addTab(pane, { target: { tabsetId: frameId, region } })) focusPane(pane.id);
}

/** Opens a terminal in `cwd`, in a new pane of `fromPaneId`'s tab. */
export function openTerminalAt(cwd: string, fromPaneId: string): void {
  addPaneBeside(fromPaneId, createPane("terminal", { cwd }));
}

/** Points editor and viewer panes showing `from` (or a file inside it) at `to` after a rename. */
export function renameOpenFiles(from: string, to: string): void {
  renameOpenModels(from, to);
  for (const pane of selectAllPanes(store())) {
    const path = pane.data.path;
    if (!path || (path !== from && !path.startsWith(`${from}/`))) continue;
    updatePaneData(pane.id, { path: to + path.slice(from.length) });
  }
}
