import { addPaneBeside, updatePaneData } from "../actions";
import type { ScmDiffMode } from "../ipc/scm";
import { focusPane, getDock } from "../layout/dock";
import { createPaneState } from "../plugins/paneState";
import { paneSpec } from "../plugins/registry";
import { createPane, findPane, listPanes } from "../state/layout";
import { findTabOfPane, useAppStore } from "../state/store";
import type { PaneData, PaneNode, Tab } from "../state/types";
import { ScmModel, type ScmViewMode } from "./model";

/*
 * Source Control models (keyed by pane id) + terminal-following logic
 * (matching `src/explorer/explorers.ts`) + helper to open/reuse a sibling
 * diff pane beside the Source Control sidebar.
 */

export type ScmDiffTarget = {
  root: string;
  filePath: string;
  oldPath?: string;
  mode: ScmDiffMode;
  commitHash?: string;
  label?: string;
};

export type SourceControlData = PaneData & {
  root?: string;
  pinned?: boolean;
  link?: string;
  viewMode?: ScmViewMode;
  /** When set, this `source-control` pane renders an interactive diff viewer instead of the sidebar. */
  diffTarget?: ScmDiffTarget;
};

const models = createPaneState<ScmModel>({
  kind: "source-control",
  dispose: (model, paneId) => {
    waitingForFocus.delete(paneId);
    model.dispose();
  },
});

function createModel(paneId: string): ScmModel {
  const tab = findTabOfPane(useAppStore.getState(), paneId);
  const data = tab && (findPane(tab.layout, paneId)?.data as SourceControlData | undefined);
  const model = new ScmModel(
    paneId,
    {
      root: data?.root,
      pinned: data?.pinned ?? false,
      link: data?.link ?? null,
      viewMode: data?.viewMode,
    },
    (settings) => {
      if (models.get(paneId) !== model) return;
      updatePaneData(paneId, {
        root: settings.root,
        pinned: settings.pinned || undefined,
        link: settings.link ?? undefined,
        viewMode: settings.viewMode,
      });
    },
  );
  if (!data?.root) waitingForFocus.delete(paneId);
  else waitingForFocus.add(paneId);
  if (tab) followDirectory(model, tab);
  return model;
}

export function acquireScm(paneId: string): ScmModel {
  return models.acquire(paneId, () => createModel(paneId));
}

export function releaseScm(model: ScmModel): void {
  model.detach();
  models.release(model.paneId, model);
}

export function peekScm(paneId: string): ScmModel | undefined {
  return models.get(paneId);
}

/* Following focused / linked terminals in the same tab (ignored for diff-mode panes). */

const lastFollowed = new Map<string, string>();
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

function followDirectory(model: ScmModel, tab: Tab): void {
  if (model.isPinned) return;
  const linked = model.linkedPane;
  if (linked) {
    const pane = findPane(tab.layout, linked);
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
        const data = pane.data as SourceControlData;
        if (data.kind !== "source-control" || data.diffTarget) continue;
        const model = models.get(pane.id);
        if (model) followDirectory(model, tab);
      }
    }
  }
  for (const tabId of lastFollowed.keys()) if (!tabs.has(tabId)) lastFollowed.delete(tabId);
}

let followQueued = false;

export function scheduleScmFollowing(): void {
  if (followQueued) return;
  followQueued = true;
  queueMicrotask(() => {
    followQueued = false;
    updateFollowing();
  });
}

export function linkableScmPanes(paneId: string): { pane: PaneNode; directory: string | undefined }[] {
  const tab = findTabOfPane(useAppStore.getState(), paneId);
  if (!tab) return [];
  return listPanes(tab.layout)
    .filter(leads)
    .map((pane) => ({ pane, directory: directoryOf(pane) }));
}

export function refollowScm(paneId: string): void {
  waitingForFocus.delete(paneId);
  scheduleScmFollowing();
}

useAppStore.subscribe(scheduleScmFollowing);

/**
 * Opens a diff for `target` in the same tab as `fromPaneId`: reuses an existing
 * diff-mode `source-control` pane in that tab (unless `newPane` is true), or
 * opens a new diff pane beside the roomiest splittable pane.
 */
export function openScmDiff({
  fromPaneId,
  target,
  newPane = false,
}: {
  fromPaneId: string;
  target: ScmDiffTarget;
  newPane?: boolean;
}): void {
  const tab = findTabOfPane(useAppStore.getState(), fromPaneId);
  const dock = tab && getDock(tab);
  if (!tab || !dock) return;

  if (!newPane) {
    const layout = dock.getModel();
    const diffPanes = listPanes(layout).filter((p) => {
      const d = p.data as SourceControlData;
      return d.kind === "source-control" && d.diffTarget !== undefined;
    });
    const existing = diffPanes.find((p) => p.id === tab.activePaneId) ?? diffPanes[0];
    if (existing) {
      dock.updateTab(existing.id, {
        data: { kind: "source-control", root: target.root, diffTarget: target },
      });
      focusPane(existing.id);
      return;
    }
  }

  const pane = createPane("source-control", {
    kind: "source-control",
    root: target.root,
    diffTarget: target,
  });
  addPaneBeside(fromPaneId, pane);
}
