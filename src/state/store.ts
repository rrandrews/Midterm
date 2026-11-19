import { create } from "zustand";
import { appendPane, createId, findPane, listPanes, removePane, singlePaneLayout } from "./layout";
import { normalizeWorkspaceModel } from "react-resizable-panels";
import type { Layout, PaneData, PaneNode, Tab, Workspace } from "./types";

export type AppState = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
};

export type AppActions = {
  addWorkspace: (name?: string) => string;
  renameWorkspace: (workspaceId: string, name: string) => void;
  removeWorkspace: (workspaceId: string) => void;
  setActiveWorkspace: (workspaceId: string) => void;

  /** Adds a tab to the active workspace and makes it active. */
  addTab: (options?: { title?: string; layout?: Layout }) => string;
  /** Names a tab, which stops its title following its panes. An empty name undoes that. */
  renameTab: (tabId: string, title: string) => void;
  /** Sets a tab's automatic title; ignored for a tab the user named. */
  setAutoTitle: (tabId: string, title: string) => void;
  /** Closing a workspace's last tab replaces it with a fresh one. */
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  /** Records a layout reported by the mounted layout component. */
  setTabLayout: (tabId: string, layout: Layout) => void;
  markActivity: (tabId: string) => void;
  /** Records which pane has keyboard focus, in whichever tab holds it. */
  setActivePane: (paneId: string) => void;

  /**
   * Removes a pane from whichever tab holds it, without going through the
   * mounted layout component (so that tab's layout is remounted).
   * Removing a tab's last pane closes the tab.
   */
  removePane: (paneId: string) => void;
  /** Moves a pane into a new tab of the same workspace and activates it. */
  movePaneToNewTab: (paneId: string) => void;
  /**
   * Moves a pane into another tab, to the right of everything there, and
   * activates that tab. Moving a tab's last pane out closes the tab.
   */
  movePaneToTab: (paneId: string, tabId: string) => void;
  /** Moves a tab to `index` among its workspace's tabs. */
  moveTab: (tabId: string, index: number) => void;
  /**
   * Merges `patch` into a pane's data in the stored layout (remounting its
   * layout if mounted; prefer the layout handle for a mounted tab).
   */
  updatePaneData: (paneId: string, patch: Partial<PaneData>, options?: { replace?: boolean }) => void;
};

export function createTab(options: { title?: string; layout?: Layout } = {}): Tab {
  return {
    id: createId(),
    title: options.title ?? "new tab",
    layout: options.layout ?? singlePaneLayout(),
    layoutRev: 0,
    activity: false,
  };
}

export function createWorkspace(name: string, tabs: Tab[] = [createTab()]): Workspace {
  return { id: createId(), name, tabs, activeTabId: tabs[0].id };
}

function nextWorkspaceName(workspaces: Workspace[]): string {
  const names = new Set(workspaces.map((workspace) => workspace.name));
  for (let n = workspaces.length + 1; ; n += 1) {
    const name = `workspace ${n}`;
    if (!names.has(name)) return name;
  }
}

/** Applies `update` to the tab with the given id, wherever it is. */
function updateTab(state: AppState, tabId: string, update: (tab: Tab) => Tab): AppState {
  let changed = false;
  const workspaces = state.workspaces.map((workspace) => {
    const index = workspace.tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return workspace;
    const next = update(workspace.tabs[index]);
    if (next === workspace.tabs[index]) return workspace;
    changed = true;
    const tabs = workspace.tabs.slice();
    tabs[index] = next;
    return { ...workspace, tabs };
  });
  return changed ? { ...state, workspaces } : state;
}

/**
 * The tab with a new layout. If the layout no longer has the tab's active
 * pane, the nearest pane before it (else the first pane) becomes active.
 */
function withLayout(tab: Tab, layout: Layout, options: { remount: boolean }): Tab {
  let { activePaneId } = tab;
  if (activePaneId && !findPane(layout, activePaneId)) {
    const before = listPanes(tab.layout);
    const index = before.findIndex((pane) => pane.id === activePaneId);
    const survivor = before
      .slice(0, Math.max(index, 0))
      .reverse()
      .find((pane) => findPane(layout, pane.id));
    activePaneId = survivor?.id ?? listPanes(layout)[0]?.id;
  }
  return {
    ...tab,
    layout,
    activePaneId,
    layoutRev: tab.layoutRev + (options.remount ? 1 : 0),
  };
}

function withoutTab(state: AppState, tabId: string): AppState {
  return {
    ...state,
    workspaces: state.workspaces.map((workspace) => {
      const index = workspace.tabs.findIndex((tab) => tab.id === tabId);
      if (index === -1) return workspace;
      const tabs = workspace.tabs.filter((tab) => tab.id !== tabId);
      // A workspace always has a tab to show.
      if (tabs.length === 0) {
        const tab = createTab();
        return { ...workspace, tabs: [tab], activeTabId: tab.id };
      }
      const activeTabId =
        workspace.activeTabId === tabId
          ? tabs[Math.min(index, tabs.length - 1)].id
          : workspace.activeTabId;
      return { ...workspace, tabs, activeTabId };
    }),
  };
}

const initialWorkspace = createWorkspace("workspace 1");

export const useAppStore = create<AppState & AppActions>()((set, get) => ({
  workspaces: [initialWorkspace],
  activeWorkspaceId: initialWorkspace.id,

  addWorkspace: (name) => {
    const workspace = createWorkspace(name?.trim() || nextWorkspaceName(get().workspaces));
    set((state) => ({
      workspaces: [...state.workspaces, workspace],
      activeWorkspaceId: workspace.id,
    }));
    return workspace.id;
  },

  renameWorkspace: (workspaceId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((state) => ({
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId ? { ...workspace, name: trimmed } : workspace,
      ),
    }));
  },

  removeWorkspace: (workspaceId) => {
    set((state) => {
      // The app always has a workspace to show.
      if (state.workspaces.length <= 1) return state;
      const index = state.workspaces.findIndex((workspace) => workspace.id === workspaceId);
      if (index === -1) return state;
      const workspaces = state.workspaces.filter((workspace) => workspace.id !== workspaceId);
      const activeWorkspaceId =
        state.activeWorkspaceId === workspaceId
          ? workspaces[Math.min(index, workspaces.length - 1)].id
          : state.activeWorkspaceId;
      return { workspaces, activeWorkspaceId };
    });
  },

  setActiveWorkspace: (workspaceId) => {
    if (!get().workspaces.some((workspace) => workspace.id === workspaceId)) return;
    set({ activeWorkspaceId: workspaceId });
    const workspace = selectActiveWorkspace(get());
    get().setActiveTab(workspace.activeTabId);
  },

  addTab: (options) => {
    const tab = createTab(options);
    set((state) => ({
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === state.activeWorkspaceId
          ? { ...workspace, tabs: [...workspace.tabs, tab], activeTabId: tab.id }
          : workspace,
      ),
    }));
    return tab.id;
  },

  renameTab: (tabId, title) => {
    const trimmed = title.trim();
    set((state) =>
      updateTab(state, tabId, (tab) =>
        trimmed ? { ...tab, title: trimmed, titleLocked: true } : { ...tab, titleLocked: undefined },
      ),
    );
  },

  setAutoTitle: (tabId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((state) =>
      updateTab(state, tabId, (tab) =>
        tab.titleLocked || tab.title === trimmed ? tab : { ...tab, title: trimmed },
      ),
    );
  },

  closeTab: (tabId) => set((state) => withoutTab(state, tabId)),

  setActiveTab: (tabId) => {
    set((state) => {
      const workspaces = state.workspaces.map((workspace) =>
        workspace.tabs.some((tab) => tab.id === tabId)
          ? { ...workspace, activeTabId: tabId }
          : workspace,
      );
      // Showing a tab acknowledges its background output.
      return updateTab({ ...state, workspaces }, tabId, (tab) =>
        tab.activity ? { ...tab, activity: false } : tab,
      );
    });
  },

  setTabLayout: (tabId, layout) => {
    set((state) => updateTab(state, tabId, (tab) => withLayout(tab, layout, { remount: false })));
  },

  markActivity: (tabId) => {
    set((state) => {
      if (selectActiveTab(state).id === tabId) return state;
      return updateTab(state, tabId, (tab) => (tab.activity ? tab : { ...tab, activity: true }));
    });
  },

  setActivePane: (paneId) => {
    set((state) => {
      const tab = findTabOfPane(state, paneId);
      if (!tab || tab.activePaneId === paneId) return state;
      return updateTab(state, tab.id, (current) => ({ ...current, activePaneId: paneId }));
    });
  },

  removePane: (paneId) => {
    set((state) => {
      const tab = findTabOfPane(state, paneId);
      if (!tab) return state;
      const layout = removePane(tab.layout, paneId);
      if (!layout) return withoutTab(state, tab.id);
      return updateTab(state, tab.id, (current) => withLayout(current, layout, { remount: true }));
    });
  },

  movePaneToNewTab: (paneId) => {
    set((state) => {
      const source = findTabOfPane(state, paneId);
      const pane = source && findPane(source.layout, paneId);
      if (!source || !pane) return state;
      const remaining = removePane(source.layout, paneId);
      // Already alone in its tab: nothing to move.
      if (!remaining) return state;
      const tab = {
        ...createTab({ title: source.title, layout: singlePaneLayout(pane) }),
        activePaneId: pane.id,
      };
      const next = updateTab(state, source.id, (current) =>
        withLayout(current, remaining, { remount: true }),
      );
      return {
        ...next,
        workspaces: next.workspaces.map((workspace) => {
          const index = workspace.tabs.findIndex((candidate) => candidate.id === source.id);
          if (index === -1) return workspace;
          const tabs = workspace.tabs.slice();
          tabs.splice(index + 1, 0, tab);
          return { ...workspace, tabs, activeTabId: tab.id };
        }),
      };
    });
  },

  movePaneToTab: (paneId, tabId) => {
    set((state) => {
      const source = findTabOfPane(state, paneId);
      const pane = source && findPane(source.layout, paneId);
      const target = findTab(state, tabId);
      if (!source || !pane || !target || source.id === target.id) return state;
      const remaining = removePane(source.layout, paneId);
      let next = updateTab(state, target.id, (current) => ({
        ...withLayout(current, appendPane(current.layout, pane), { remount: true }),
        activePaneId: pane.id,
      }));
      next = remaining
        ? updateTab(next, source.id, (current) => withLayout(current, remaining, { remount: true }))
        : withoutTab(next, source.id);
      return {
        ...next,
        workspaces: next.workspaces.map((workspace) =>
          workspace.tabs.some((tab) => tab.id === target.id)
            ? { ...workspace, activeTabId: target.id }
            : workspace,
        ),
      };
    });
  },

  moveTab: (tabId, index) => {
    set((state) => ({
      workspaces: state.workspaces.map((workspace) => {
        const from = workspace.tabs.findIndex((tab) => tab.id === tabId);
        const to = Math.max(0, Math.min(index, workspace.tabs.length - 1));
        if (from === -1 || from === to) return workspace;
        const tabs = workspace.tabs.slice();
        const [tab] = tabs.splice(from, 1);
        tabs.splice(to, 0, tab);
        return { ...workspace, tabs };
      }),
    }));
  },

  updatePaneData: (paneId, patch, options) => {
    set((state) => {
      const tab = findTabOfPane(state, paneId);
      if (!tab) return state;
      const layout = normalizeWorkspaceModel<PaneData>(tab.layout, {
        mapTab: (pane) =>
          pane.id === paneId
            ? { ...pane, data: (options?.replace ? patch : { ...pane.data, ...patch }) as PaneData }
            : pane,
      });
      if (!layout) return state;
      return updateTab(state, tab.id, (current) => withLayout(current, layout, { remount: true }));
    });
  },
}));

export function selectActiveWorkspace(state: AppState): Workspace {
  return (
    state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ??
    state.workspaces[0]
  );
}

export function selectActiveTab(state: AppState): Tab {
  const workspace = selectActiveWorkspace(state);
  return workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? workspace.tabs[0];
}

export function findTab(state: AppState, tabId: string): Tab | undefined {
  for (const workspace of state.workspaces) {
    const tab = workspace.tabs.find((candidate) => candidate.id === tabId);
    if (tab) return tab;
  }
  return undefined;
}

export function findTabOfPane(state: AppState, paneId: string): Tab | undefined {
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      if (findPane(tab.layout, paneId)) return tab;
    }
  }
  return undefined;
}

/** Every pane in every tab of every workspace. */
export function selectAllPanes(state: AppState): PaneNode[] {
  return state.workspaces.flatMap((workspace) =>
    workspace.tabs.flatMap((tab) => listPanes(tab.layout)),
  );
}
