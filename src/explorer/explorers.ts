import { updatePaneData } from "../actions";
import { createPaneState } from "../plugins/paneState";
import { paneSpec } from "../plugins/registry";
import { findPane, listPanes } from "../state/layout";
import { findTabOfPane, useAppStore } from "../state/store";
import type { PaneData, PaneNode, Tab } from "../state/types";
import { ExplorerModel } from "./model";

/*
 * Explorer models, keyed by pane id (a shared pane state, see
 * src/plugins/paneState.ts): disposed once no explorer pane with their id
 * is left in the store and nothing shows them.
 *
 * It also makes unpinned explorers follow the focused terminal: the root of
 * each is the directory of the pane that last had focus in its tab among
 * those whose plugin says explorers follow it (`explorerFollows`).
 */

/** An explorer pane's data. */
export type ExplorerData = PaneData & {
  /** The directory at the top of the tree. */
  root?: string;
  /** The root stays put instead of following the focused terminal's directory. */
  pinned?: boolean;
  /** The pane (a terminal in the same tab) whose directory the root follows, instead of the last focused one. */
  link?: string;
  /** Dotfiles and ignored files are listed too. */
  showHidden?: boolean;
  /** Expanded directories (absolute paths). */
  expanded?: string[];
};

const models = createPaneState<ExplorerModel>({
  kind: "explorer",
  dispose: (model, paneId) => {
    waitingForFocus.delete(paneId);
    model.dispose();
  },
});

function createModel(paneId: string): ExplorerModel {
  const tab = findTabOfPane(useAppStore.getState(), paneId);
  const data = tab && (findPane(tab.layout, paneId)?.data as ExplorerData | undefined);
  const model: ExplorerModel = new ExplorerModel(
    paneId,
    {
      root: data?.root,
      pinned: data?.pinned ?? false,
      link: data?.link ?? null,
      showHidden: data?.showHidden ?? false,
      expanded: data?.expanded,
    },
    (settings) => {
      if (models.get(paneId) !== model) return;
      updatePaneData(paneId, {
        root: settings.root,
        pinned: settings.pinned || undefined,
        link: settings.link ?? undefined,
        showHidden: settings.showHidden || undefined,
        expanded: settings.expanded.length ? settings.expanded : undefined,
      });
    },
  );
  // A restored root stays until a followed pane in the tab is focused:
  // which one had focus last is not saved, and guessing would replace it.
  if (!data?.root) waitingForFocus.delete(paneId);
  else waitingForFocus.add(paneId);
  if (tab) followDirectory(model, tab);
  return model;
}

/**
 * The pane's explorer model, created if needed, for a mounted component
 * (which calls `releaseExplorer` when done).
 */
export function acquireExplorer(paneId: string): ExplorerModel {
  return models.acquire(paneId, () => createModel(paneId));
}

/** Takes an explorer off screen; it is disposed only if its pane is gone. */
export function releaseExplorer(model: ExplorerModel): void {
  model.detach();
  models.release(model.paneId, model);
}

export function peekExplorer(paneId: string): ExplorerModel | undefined {
  return models.get(paneId);
}

/*
 * Following. "The pane that last had focus" is remembered per tab, because
 * focus moves to the explorer itself as soon as it is used.
 */

const lastFollowed = new Map<string, string>();
/** Explorers with a restored root, which follow only once a followed pane is focused. */
const waitingForFocus = new Set<string>();

function leads(pane: PaneNode | undefined): boolean {
  return pane !== undefined && paneSpec(pane.data.kind)?.explorerFollows === true;
}

function directoryOf(pane: PaneNode): string | undefined {
  try {
    return paneSpec(pane.data.kind)?.directory?.(pane);
  } catch {
    return undefined;
  }
}

function followDirectory(model: ExplorerModel, tab: Tab): void {
  if (model.isPinned) return;
  const linked = model.linkedPane;
  if (linked) {
    const pane = findPane(tab.layout, linked);
    // A linked terminal that closed (or left the tab) hands over to the focused one.
    if (!pane || !leads(pane)) model.setLink(null);
    else {
      const dir = directoryOf(pane);
      if (dir) model.setRoot(dir);
      return;
    }
  }
  const remembered = lastFollowed.get(tab.id);
  const known = remembered ? findPane(tab.layout, remembered) : undefined;
  if (known && leads(known)) waitingForFocus.delete(model.paneId);
  else if (waitingForFocus.has(model.paneId)) return;
  const leader = known && leads(known) ? known : listPanes(tab.layout).find(leads);
  const dir = leader && directoryOf(leader);
  if (dir) model.setRoot(dir);
}

function updateFollowing(): void {
  const state = useAppStore.getState();
  const tabs = new Set<string>();
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      tabs.add(tab.id);
      const active = tab.activePaneId;
      if (active && leads(findPane(tab.layout, active))) lastFollowed.set(tab.id, active);
      for (const pane of listPanes(tab.layout)) {
        const model = pane.data.kind === "explorer" ? models.get(pane.id) : undefined;
        if (model) followDirectory(model, tab);
      }
    }
  }
  for (const tabId of lastFollowed.keys()) if (!tabs.has(tabId)) lastFollowed.delete(tabId);
}

let followQueued = false;

/** Re-checks which directory each unpinned explorer should show (e.g. after a terminal changed directory). */
export function scheduleFollowing(): void {
  if (followQueued) return;
  followQueued = true;
  queueMicrotask(() => {
    followQueued = false;
    updateFollowing();
  });
}

/** The panes an explorer in `tab` can be linked to (terminals), in layout order, with their directories. */
export function linkablePanes(paneId: string): { pane: PaneNode; directory: string | undefined }[] {
  const tab = findTabOfPane(useAppStore.getState(), paneId);
  if (!tab) return [];
  return listPanes(tab.layout)
    .filter(leads)
    .map((pane) => ({ pane, directory: directoryOf(pane) }));
}

/** Follows again right away, e.g. after the explorer is unpinned. */
export function refollow(paneId: string): void {
  waitingForFocus.delete(paneId);
  scheduleFollowing();
}

useAppStore.subscribe(scheduleFollowing);
