import { renameOpenModels } from "./editor/registry";
import { isWithin, joinPath, relativePath } from "./explorer/tree";
import { isRemotePath } from "./files/location";
import { forgetWorkspace } from "./workspaces/settings";
import { peekExplorer } from "./explorer/explorers";
import { revealInFileManager } from "./ipc/shell";
import { noteRecentFile } from "./palette/recent";
import { shortcutLabel } from "./commands/registry";
import { type DockHandle, focusPane, getDock } from "./layout/dock";
import { convertedData, defaultTerminalKind, fileHandlers, newPane, newPaneData } from "./plugins/panes";
import { isPluginEnabled, paneSpec } from "./plugins/registry";
import {
  countFrames,
  countPanes,
  createPane,
  findPane,
  frameIdOf,
  frameOf,
  listPanes,
  paneIndexForDigit,
  paneNumbers,
  shownPane,
  singlePaneLayout,
  visiblePanes,
} from "./state/layout";
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

/**
 * The pane that last had focus in the active tab (its first pane on screen
 * if none has yet). A remembered pane hidden behind another subtab of its
 * frame gives way to the one shown.
 */
export function activePaneId(): string | undefined {
  const { activePaneId: remembered } = selectActiveTab(store());
  const { layout } = activeLayout();
  const frame = remembered ? frameOf(layout, remembered) : undefined;
  return (frame && shownPane(frame)?.id) ?? visiblePanes(layout)[0]?.id;
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

/** Shows a pane wherever it is (its workspace and tab) and focuses it. */
export function revealPane(paneId: string): void {
  const state = store();
  const workspace = state.workspaces.find((w) => w.tabs.some((tab) => findPane(tab.layout, paneId)));
  const tab = findTabOfPane(state, paneId);
  if (!workspace || !tab) return;
  if (state.activeWorkspaceId !== workspace.id) state.setActiveWorkspace(workspace.id);
  state.setActiveTab(tab.id);
  state.setActivePane(paneId);
  focusActivePane();
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
  // Its first tab was made while the previous workspace's settings were in
  // effect (default pane kind). Nothing has shown it yet: replace it with a
  // fresh one under the new workspace's settings.
  const { tabs } = selectActiveWorkspace(store());
  store().closeTab(tabs[0].id);
  focusActivePane();
}

export function selectWorkspace(workspaceId: string): void {
  store().setActiveWorkspace(workspaceId);
  focusActivePane();
}

/** Closes a workspace without asking (see `src/closing.ts`). */
export function removeWorkspaceNow(workspaceId: string): void {
  if (store().workspaces.length <= 1) return;
  store().removeWorkspace(workspaceId);
  forgetWorkspace(workspaceId);
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

  const focused = activePaneId();
  const neighbour = closingNeighbour(layout, paneId);

  if (dock) dock.closeTab(paneId);
  else store().removePane(paneId);

  if (wasActive) focusPane(focused === paneId ? neighbour : focused);
}

/**
 * The pane that takes focus when `paneId` closes: the subtab its frame shows
 * next (the one after it, else before it), or for a frame's only pane the
 * pane shown before it (after it, for the first).
 */
function closingNeighbour(layout: Layout, paneId: string): string | undefined {
  const frame = frameOf(layout, paneId);
  if (frame && frame.tabs.length > 1) {
    if (shownPane(frame)?.id !== paneId) return shownPane(frame)?.id;
    const index = frame.tabs.findIndex((pane) => pane.id === paneId);
    return (frame.tabs[index + 1] ?? frame.tabs[index - 1])?.id;
  }
  const panes = visiblePanes(layout);
  const index = panes.findIndex((pane) => pane.id === paneId);
  return panes[index > 0 ? index - 1 : 1]?.id;
}

/** Maximizes a pane within its tab, or restores the layout if it is maximized. */
export function toggleMaximizePane(paneId = activePaneId()): void {
  const { dock, layout } = activeLayout();
  const frameId = paneId && frameIdOf(layout, paneId);
  if (!dock || !frameId || countFrames(layout) <= 1) return;
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

/**
 * Panes dropped on a tab (`target` is its id) or on the new-tab button
 * (`"new"`): one pane, or a frame's subtabs (dragged by its grip), which
 * stay together. The first is the one their frame showed.
 */
export function dropPaneOnTab(paneIds: string[], target: string): void {
  if (paneIds.length === 0) return;
  if (target === "new") store().movePaneToNewTab(paneIds);
  else store().movePaneToTab(paneIds, target);
  focusPane(paneIds[0]);
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
    // A hidden subtab has no box.
    if (!rect.width || !rect.height) continue;
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

/**
 * The labels shown on the active tab's panes while ⌥ is held, by pane id:
 * each pane's `pane.selectN` shortcut as bound now (the key alone when it is
 * ⌥ plus one key, as by default). Panes whose command has no binding get none.
 */
export function activePaneNumbers(): Record<string, string> {
  return paneNumbers(activeLayout().layout, (index) => {
    const label = shortcutLabel(`pane.select${index + 1}`);
    return label && /^⌥.$/u.test(label) ? label.slice(1) : label;
  });
}

/**
 * Focuses the pane a digit key (1 … 9, 0 for the tenth) selects, counting
 * in `visiblePanes` order. Restores a maximized layout if the pane is hidden by it.
 */
export function selectPaneByDigit(digit: number): void {
  const { dock, layout } = activeLayout();
  const pane = visiblePanes(layout)[paneIndexForDigit(digit)];
  if (!pane) return;
  const hidden = layout.maximizedTabsetId && layout.maximizedTabsetId !== frameIdOf(layout, pane.id);
  if (dock && hidden) dock.restoreTabset();
  store().setActivePane(pane.id);
  focusPane(pane.id);
  // A pane revealed by the restore can only take focus once it is visible again.
  if (hidden) restoreFocusSoon(pane.id);
}

/**
 * Shows and focuses the subtab a digit key (1 … 9, 0 for the tenth) selects
 * in the active pane's frame. A number with no subtab does nothing.
 */
export function selectSubtabByDigit(digit: number): void {
  const { layout } = activeLayout();
  const id = activePaneId();
  const pane = id && frameOf(layout, id)?.tabs[paneIndexForDigit(digit)];
  if (!pane) return;
  store().setActivePane(pane.id);
  focusPane(pane.id);
}

/** Shows the next (`1`) or previous (`-1`) subtab of the active pane's frame, wrapping around. */
export function cycleSubtab(delta: 1 | -1): void {
  const { layout } = activeLayout();
  const id = activePaneId();
  const tabs = (id && frameOf(layout, id)?.tabs) || [];
  if (tabs.length < 2) return;
  const index = tabs.findIndex((pane) => pane.id === id);
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  store().setActivePane(next.id);
  focusPane(next.id);
}

/**
 * Adds a pane of `kind` (the default kind when not given) as a new subtab of
 * a pane's frame, after the frame's other subtabs, and shows it.
 */
export function addSubtab(kind?: PaneKind, paneId = activePaneId()): void {
  const { dock, layout } = activeLayout();
  const frame = paneId ? frameOf(layout, paneId) : undefined;
  if (!dock || !frame || !paneId) return;
  const pane = newPane(kind, findPane(layout, paneId));
  if (dock.addTab(pane, { target: { tabsetId: frame.id, index: frame.tabs.length } })) {
    store().setActivePane(pane.id);
    focusPane(pane.id);
  }
}

/** Names a pane's subtab; an empty name goes back to the automatic one. */
export function renameSubtab(paneId: string, name: string): void {
  const tab = findTabOfPane(store(), paneId);
  const dock = tab && getDock(tab);
  if (!dock) return;
  dock.updateTab(paneId, { title: name.trim() || undefined });
}

function restoreFocusSoon(paneId: string): void {
  requestAnimationFrame(() => focusPane(paneId));
}

/** Whether a pane may be given another file: its plugin says it has nothing unsaved. */
function mayReplaceFile(pane: PaneNode): boolean {
  const spec = paneSpec(pane.data.kind);
  if (!spec) return false;
  if (spec.isDirty) {
    try {
      return !spec.isDirty(pane.id);
    } catch {
      return false;
    }
  }
  return !spec.closeBlockers;
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
      const free = ofKind.filter((pane) => mayReplaceFile(pane));
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

/**
 * Shows a directory in an explorer of `fromPaneId`'s tab: the last active
 * explorer there is pinned to it, or, with `newPane` or when the tab has
 * none, a new explorer pane pinned to it is split off. Without the
 * explorer plugin, Finder shows it.
 */
export function openDirectory(path: string, { fromPaneId, newPane: alwaysNew = false }: { fromPaneId: string; newPane?: boolean }): void {
  const tab = findTabOfPane(store(), fromPaneId);
  const dock = tab && getDock(tab);
  if (!tab || !dock) return;
  // Without the explorer plugin, Finder is the folder view for local directories;
  // for remote SSH directories, open a remote terminal there instead.
  if (!isPluginEnabled("explorer")) {
    if (isRemotePath(path)) return openTerminalAt(path, fromPaneId);
    return revealInFileManager(path);
  }
  if (!alwaysNew) {
    const explorers = listPanes(dock.getModel()).filter((pane) => pane.data.kind === "explorer");
    const target = explorers.find((pane) => pane.id === tab.activePaneId) ?? explorers[0];
    const model = target && peekExplorer(target.id);
    if (target && model) {
      model.setPinned(true);
      model.setRoot(path);
      focusPane(target.id);
      return;
    }
    if (target) {
      // Not mounted yet: its model reads the data when it is created.
      dock.updateTab(target.id, { data: { ...target.data, root: path, pinned: true, expanded: undefined } });
      focusPane(target.id);
      return;
    }
  }
  addPaneBeside(fromPaneId, createPane("explorer", { ...newPaneData("explorer"), root: path, pinned: true }));
}

/** Opens the default terminal in `cwd` (or local home when omitted), in a new pane of `fromPaneId`'s tab. */
export function openTerminalAt(cwd: string | undefined, fromPaneId: string): void {
  const kind = defaultTerminalKind();
  addPaneBeside(fromPaneId, createPane(kind, { ...newPaneData(kind), ...(cwd ? { cwd } : {}) }));
}

/** Points editor and viewer panes showing `from` (or a file inside it) at `to` after a rename. */
export function renameOpenFiles(from: string, to: string): void {
  renameOpenModels(from, to);
  for (const pane of selectAllPanes(store())) {
    const path = pane.data.path;
    if (!path || !isWithin(path, from)) continue;
    const rel = relativePath(path, from);
    updatePaneData(pane.id, { path: rel ? joinPath(to, rel) : to });
  }
}
