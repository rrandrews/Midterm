import { normalizeWorkspaceModel } from "react-resizable-panels";
import { countPanes, listPanes } from "./layout";
import { type AppState, createTab, createWorkspace } from "./store";
import { PANE_KINDS, type Layout, type PaneData, type Tab, type Workspace } from "./types";

/*
 * Saving and restoring the app state (workspaces, tabs, layouts).
 *
 * Pure functions only: `src/state/persistence.ts` wires them to disk.
 * Anything loaded is untrusted (an older app version, a hand edit, a crash
 * mid-write), so `restoreState` validates every level and repairs what it
 * can: a bad pane is dropped, a tab with no valid panes becomes a fresh tab,
 * and a file that is unusable as a whole gives `null` (start fresh).
 */

/** Bump when the saved shape changes incompatibly, and migrate in `restoreState`. */
export const SCHEMA_VERSION = 1;

type SavedTab = Pick<Tab, "id" | "title" | "titleLocked" | "layout" | "activePaneId">;
type SavedWorkspace = Pick<Workspace, "id" | "name" | "activeTabId"> & { tabs: SavedTab[] };

export type SavedState = {
  version: number;
  workspaces: SavedWorkspace[];
  activeWorkspaceId: string;
};

/** The part of the state worth keeping. Transient fields (activity, revisions) are dropped. */
export function snapshotState(state: AppState): SavedState {
  return {
    version: SCHEMA_VERSION,
    activeWorkspaceId: state.activeWorkspaceId,
    workspaces: state.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      activeTabId: workspace.activeTabId,
      tabs: workspace.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        titleLocked: tab.titleLocked,
        layout: tab.layout,
        activePaneId: tab.activePaneId,
      })),
    })),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function restorePaneData(data: unknown): PaneData | null {
  if (!isRecord(data) || !PANE_KINDS.includes(data.kind as PaneData["kind"])) return null;
  const restored: PaneData = { kind: data.kind as PaneData["kind"] };
  if (nonEmptyString(data.cwd)) restored.cwd = data.cwd;
  return restored;
}

/** A valid layout from saved data, with invalid panes dropped; `null` if nothing is left. */
export function restoreLayout(saved: unknown): Layout | null {
  if (!isRecord(saved)) return null;
  let layout: Layout | null;
  try {
    layout = normalizeWorkspaceModel<PaneData>(saved as Layout, {
      mapTab: (pane) => {
        const data = restorePaneData(pane.data);
        return data ? { ...pane, data } : null;
      },
    });
  } catch {
    return null;
  }
  if (!layout || countPanes(layout) === 0) return null;
  return layout;
}

function restoreTab(saved: unknown): Tab {
  if (!isRecord(saved)) return createTab();
  const layout = restoreLayout(saved.layout);
  const title = nonEmptyString(saved.title) ? saved.title : undefined;
  if (!layout) return createTab({ title });
  return {
    ...createTab({ title, layout }),
    id: nonEmptyString(saved.id) ? saved.id : createTab().id,
    titleLocked: saved.titleLocked === true || undefined,
    activePaneId: nonEmptyString(saved.activePaneId) ? saved.activePaneId : undefined,
  };
}

function restoreWorkspace(saved: unknown, index: number): Workspace | null {
  if (!isRecord(saved) || !Array.isArray(saved.tabs)) return null;
  const tabs = saved.tabs.map(restoreTab);
  // Ids must be unique for the store's lookups to make sense.
  const seen = new Set<string>();
  const unique = tabs.map((tab) => {
    if (!seen.has(tab.id)) {
      seen.add(tab.id);
      return tab;
    }
    const copy = { ...tab, id: createTab().id };
    seen.add(copy.id);
    return copy;
  });
  const name = nonEmptyString(saved.name) ? saved.name : `workspace ${index + 1}`;
  const workspace = createWorkspace(name, unique.length ? unique : [createTab()]);
  if (nonEmptyString(saved.id)) workspace.id = saved.id;
  if (workspace.tabs.some((tab) => tab.id === saved.activeTabId)) {
    workspace.activeTabId = saved.activeTabId as string;
  }
  return workspace;
}

/**
 * The app state described by saved data, repaired where needed, or `null`
 * if it cannot be used at all (missing, wrong version, no workspaces).
 */
export function restoreState(saved: unknown): AppState | null {
  if (!isRecord(saved) || saved.version !== SCHEMA_VERSION || !Array.isArray(saved.workspaces)) {
    return null;
  }
  const workspaces = saved.workspaces
    .map(restoreWorkspace)
    .filter((workspace): workspace is Workspace => workspace !== null);
  if (workspaces.length === 0) return null;

  const workspaceIds = new Set<string>();
  for (const workspace of workspaces) {
    if (workspaceIds.has(workspace.id)) workspace.id = createWorkspace("").id;
    workspaceIds.add(workspace.id);
  }

  // Duplicate pane ids across tabs would make two panes share one terminal.
  const panes = new Set<string>();
  for (const workspace of workspaces) {
    workspace.tabs = workspace.tabs.map((tab) => {
      const ids = listPanes(tab.layout).map((pane) => pane.id);
      if (ids.some((id) => panes.has(id))) return createTab({ title: tab.title });
      for (const id of ids) panes.add(id);
      return tab;
    });
  }

  const activeWorkspaceId = workspaces.some((workspace) => workspace.id === saved.activeWorkspaceId)
    ? (saved.activeWorkspaceId as string)
    : workspaces[0].id;
  return { workspaces, activeWorkspaceId };
}
