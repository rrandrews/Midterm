import { updatePaneData } from "../actions";
import { findPane, listPanes } from "../state/layout";
import { findTabOfPane, selectAllPanes, useAppStore } from "../state/store";
import type { Tab } from "../state/types";
import { peekSession } from "../terminal/sessions";
import { ExplorerModel } from "./model";

/*
 * Registry of explorer models, keyed by pane id. Same lifetime rule as
 * terminal sessions (src/terminal/sessions.ts): a model is disposed when no
 * explorer pane with its id is left in the store and it is off screen.
 *
 * It also makes unpinned explorers follow the focused terminal: the root of
 * each is the working directory of the terminal that last had focus in its
 * tab.
 */

const models = new Map<string, ExplorerModel>();

export function acquireExplorer(paneId: string): ExplorerModel {
  let model = models.get(paneId);
  if (!model) {
    const tab = findTabOfPane(useAppStore.getState(), paneId);
    const data = tab && findPane(tab.layout, paneId)?.data;
    const created = new ExplorerModel(
      paneId,
      {
        root: data?.root,
        pinned: data?.pinned,
        showHidden: data?.showHidden,
        expanded: data?.expanded,
      },
      (settings) => {
        if (models.get(paneId) !== created) return;
        updatePaneData(paneId, {
          root: settings.root,
          pinned: settings.pinned || undefined,
          showHidden: settings.showHidden || undefined,
          expanded: settings.expanded.length ? settings.expanded : undefined,
        });
      },
    );
    model = created;
    models.set(paneId, model);
    if (tab) followTerminal(model, tab);
  }
  return model;
}

/** Takes an explorer off screen; it is disposed only if its pane is gone. */
export function releaseExplorer(model: ExplorerModel): void {
  model.detach();
  scheduleReconcile();
}

export function peekExplorer(paneId: string): ExplorerModel | undefined {
  return models.get(paneId);
}

function reconcile(): void {
  const live = new Set(
    selectAllPanes(useAppStore.getState())
      .filter((pane) => pane.data.kind === "explorer")
      .map((pane) => pane.id),
  );
  for (const [paneId, model] of models) {
    if (live.has(paneId) || model.isAttached) continue;
    models.delete(paneId);
    model.dispose();
  }
}

let reconcileTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleReconcile(): void {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(reconcile, 0);
}

/*
 * Following. "The terminal that last had focus" is remembered per tab,
 * because focus moves to the explorer itself as soon as it is used.
 */

const lastTerminal = new Map<string, string>();

function terminalCwd(tab: Tab, paneId: string): string | undefined {
  const pane = findPane(tab.layout, paneId);
  if (pane?.data.kind !== "terminal") return undefined;
  return peekSession(paneId)?.cwd ?? pane.data.cwd;
}

function followTerminal(model: ExplorerModel, tab: Tab): void {
  if (model.isPinned) return;
  const remembered = lastTerminal.get(tab.id);
  const terminal =
    (remembered && findPane(tab.layout, remembered) ? remembered : undefined) ??
    listPanes(tab.layout).find((pane) => pane.data.kind === "terminal")?.id;
  const cwd = terminal && terminalCwd(tab, terminal);
  if (cwd) model.setRoot(cwd);
}

function updateFollowing(): void {
  const state = useAppStore.getState();
  const tabs = new Set<string>();
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      tabs.add(tab.id);
      const active = tab.activePaneId;
      if (active && findPane(tab.layout, active)?.data.kind === "terminal") lastTerminal.set(tab.id, active);
      for (const pane of listPanes(tab.layout)) {
        const model = pane.data.kind === "explorer" ? models.get(pane.id) : undefined;
        if (model) followTerminal(model, tab);
      }
    }
  }
  for (const tabId of lastTerminal.keys()) if (!tabs.has(tabId)) lastTerminal.delete(tabId);
}

let followQueued = false;

function scheduleFollowing(): void {
  if (followQueued) return;
  followQueued = true;
  queueMicrotask(() => {
    followQueued = false;
    updateFollowing();
  });
}

/** Re-applies following now, e.g. after an explorer is unpinned. */
export function refollow(): void {
  scheduleFollowing();
}

useAppStore.subscribe(() => {
  scheduleReconcile();
  scheduleFollowing();
});
