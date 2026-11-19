import { beforeEach, describe, expect, it } from "vitest";
import { countPanes, createLayout, createPane, listPanes, paneNode } from "./layout";
import {
  createTab,
  createWorkspace,
  findTab,
  findTabOfPane,
  selectActiveTab,
  selectActiveWorkspace,
  selectAllPanes,
  useAppStore,
} from "./store";

const store = () => useAppStore.getState();

function twoPaneTab() {
  const a = createPane();
  const b = createPane();
  const layout = createLayout({
    type: "split",
    orientation: "horizontal",
    children: [paneNode(a), paneNode(b)],
  });
  return { tab: createTab({ title: "two", layout }), a, b };
}

beforeEach(() => {
  const workspace = createWorkspace("one");
  useAppStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
});

describe("tabs", () => {
  it("adds a tab with one terminal pane and activates it", () => {
    const id = store().addTab();
    const workspace = selectActiveWorkspace(store());
    expect(workspace.tabs).toHaveLength(2);
    expect(workspace.activeTabId).toBe(id);
    expect(listPanes(selectActiveTab(store()).layout).map((p) => p.data.kind)).toEqual([
      "terminal",
    ]);
  });

  it("activates the neighbour when the active tab is closed", () => {
    const first = selectActiveTab(store()).id;
    const second = store().addTab();
    const third = store().addTab();
    store().setActiveTab(second);
    store().closeTab(second);
    expect(selectActiveWorkspace(store()).tabs.map((t) => t.id)).toEqual([first, third]);
    expect(selectActiveTab(store()).id).toBe(third);
    store().closeTab(third);
    expect(selectActiveTab(store()).id).toBe(first);
  });

  it("keeps the active tab when a background tab is closed", () => {
    const first = selectActiveTab(store()).id;
    const second = store().addTab();
    store().closeTab(first);
    expect(selectActiveTab(store()).id).toBe(second);
  });

  it("replaces the last tab with a fresh one instead of leaving none", () => {
    const only = selectActiveTab(store()).id;
    store().closeTab(only);
    const workspace = selectActiveWorkspace(store());
    expect(workspace.tabs).toHaveLength(1);
    expect(workspace.tabs[0].id).not.toBe(only);
    expect(workspace.activeTabId).toBe(workspace.tabs[0].id);
  });

  it("renames, ignoring blank titles", () => {
    const id = selectActiveTab(store()).id;
    store().renameTab(id, "  server ");
    expect(selectActiveTab(store()).title).toBe("server");
    store().renameTab(id, "   ");
    expect(selectActiveTab(store()).title).toBe("server");
  });

  it("flags background activity and clears it when the tab is shown", () => {
    const first = selectActiveTab(store()).id;
    const second = store().addTab();
    store().markActivity(second);
    expect(selectActiveTab(store()).activity).toBe(false);
    store().markActivity(first);
    const tabs = () => selectActiveWorkspace(store()).tabs;
    expect(tabs().find((t) => t.id === first)?.activity).toBe(true);
    store().setActiveTab(first);
    expect(tabs().find((t) => t.id === first)?.activity).toBe(false);
  });
});

describe("panes", () => {
  it("removes a pane and bumps the layout revision", () => {
    const { tab, a, b } = twoPaneTab();
    store().addTab(tab);
    const id = selectActiveTab(store()).id;
    store().removePane(a.id);
    const after = selectActiveTab(store());
    expect(after.id).toBe(id);
    expect(listPanes(after.layout).map((p) => p.id)).toEqual([b.id]);
    expect(after.layoutRev).toBe(1);
  });

  it("closes the tab when its last pane is removed", () => {
    const first = selectActiveTab(store()).id;
    const pane = createPane();
    const second = store().addTab({ layout: createLayout(paneNode(pane)) });
    store().removePane(pane.id);
    expect(selectActiveWorkspace(store()).tabs.map((t) => t.id)).toEqual([first]);
    expect(selectActiveTab(store()).id).not.toBe(second);
  });

  it("removes panes from background tabs", () => {
    const { tab, a } = twoPaneTab();
    store().addTab(tab);
    store().addTab();
    store().removePane(a.id);
    expect(findTabOfPane(store(), a.id)).toBeUndefined();
    const background = selectActiveWorkspace(store()).tabs[1];
    expect(countPanes(background.layout)).toBe(1);
  });

  it("moves a pane to a new tab next to its source, keeping the pane id", () => {
    const { tab, a, b } = twoPaneTab();
    store().addTab(tab);
    const sourceId = selectActiveTab(store()).id;
    const paneCount = selectAllPanes(store()).length;
    store().movePaneToNewTab(b.id);

    const workspace = selectActiveWorkspace(store());
    const sourceIndex = workspace.tabs.findIndex((t) => t.id === sourceId);
    const moved = workspace.tabs[sourceIndex + 1];
    expect(workspace.activeTabId).toBe(moved.id);
    expect(listPanes(moved.layout).map((p) => p.id)).toEqual([b.id]);
    expect(listPanes(workspace.tabs[sourceIndex].layout).map((p) => p.id)).toEqual([a.id]);
    expect(workspace.tabs[sourceIndex].layoutRev).toBe(1);
    // No pane is ever missing from the store mid-move.
    expect(selectAllPanes(store())).toHaveLength(paneCount);
  });

  it("remembers the focused pane per tab and carries it to a new tab", () => {
    const { tab, a, b } = twoPaneTab();
    store().addTab(tab);
    store().setActivePane(b.id);
    expect(selectActiveTab(store()).activePaneId).toBe(b.id);
    const before = store().workspaces;
    store().setActivePane(b.id);
    expect(store().workspaces).toBe(before);
    store().setActivePane("missing");
    expect(store().workspaces).toBe(before);

    store().movePaneToNewTab(a.id);
    expect(selectActiveTab(store()).activePaneId).toBe(a.id);
  });

  it("re-points the active pane when it is removed or moved away", () => {
    const { tab, a, b } = twoPaneTab();
    store().addTab(tab);
    const sourceId = selectActiveTab(store()).id;
    const source = () => selectActiveWorkspace(store()).tabs.find((t) => t.id === sourceId);

    store().setActivePane(b.id);
    store().movePaneToNewTab(b.id);
    expect(source()?.activePaneId).toBe(a.id);

    const { tab: other, a: c, b: d } = twoPaneTab();
    store().addTab(other);
    store().setActivePane(d.id);
    store().removePane(d.id);
    expect(selectActiveTab(store()).activePaneId).toBe(c.id);
  });

  it("re-points the active pane when the mounted layout reports it gone", () => {
    const { tab, a, b } = twoPaneTab();
    store().addTab(tab);
    store().setActivePane(a.id);
    const current = selectActiveTab(store());
    store().setTabLayout(current.id, createLayout(paneNode(b)));
    const after = selectActiveTab(store());
    expect(after.activePaneId).toBe(b.id);
    // A layout reported by the mounted component is not a reason to remount it.
    expect(after.layoutRev).toBe(current.layoutRev);
  });

  it("does nothing when asked to move a tab's only pane", () => {
    const before = store().workspaces;
    const pane = listPanes(selectActiveTab(store()).layout)[0];
    store().movePaneToNewTab(pane.id);
    expect(store().workspaces).toBe(before);
  });
});

describe("workspaces", () => {
  it("adds a uniquely named workspace and activates it", () => {
    const id = store().addWorkspace();
    expect(store().activeWorkspaceId).toBe(id);
    expect(store().workspaces.map((w) => w.name)).toEqual(["one", "workspace 2"]);
  });

  it("never removes the last workspace", () => {
    store().removeWorkspace(store().activeWorkspaceId);
    expect(store().workspaces).toHaveLength(1);
  });

  it("activates a neighbour when the active workspace is removed", () => {
    const first = store().activeWorkspaceId;
    const second = store().addWorkspace("two");
    store().removeWorkspace(second);
    expect(store().activeWorkspaceId).toBe(first);
  });

  it("clears activity on the tab shown when switching workspace", () => {
    const first = store().activeWorkspaceId;
    const firstTab = selectActiveTab(store()).id;
    store().addWorkspace("two");
    store().markActivity(firstTab);
    store().setActiveWorkspace(first);
    expect(selectActiveTab(store()).activity).toBe(false);
  });
});

describe("tab titles", () => {
  it("follows automatic titles until the user names the tab", () => {
    const id = selectActiveTab(store()).id;
    store().setAutoTitle(id, "vim");
    expect(selectActiveTab(store()).title).toBe("vim");
    store().renameTab(id, "notes");
    store().setAutoTitle(id, "zsh");
    expect(selectActiveTab(store()).title).toBe("notes");
    expect(selectActiveTab(store()).titleLocked).toBe(true);
  });

  it("an empty name hands the title back to the panes", () => {
    const id = selectActiveTab(store()).id;
    store().renameTab(id, "notes");
    store().renameTab(id, "  ");
    expect(selectActiveTab(store()).titleLocked).toBeUndefined();
    store().setAutoTitle(id, "zsh");
    expect(selectActiveTab(store()).title).toBe("zsh");
  });
});

describe("pane data", () => {
  it("merges into a pane's data and remounts its layout", () => {
    const { tab, a } = twoPaneTab();
    const workspace = createWorkspace("w", [tab]);
    useAppStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
    store().updatePaneData(a.id, { cwd: "/tmp" });
    const updated = findTabOfPane(store(), a.id);
    expect(updated?.layoutRev).toBe(1);
    expect(listPanes(updated!.layout).find((p) => p.id === a.id)?.data).toEqual({
      kind: "terminal",
      cwd: "/tmp",
    });
  });
});

describe("moving tabs and panes between tabs", () => {
  it("reorders tabs", () => {
    const first = selectActiveTab(store()).id;
    const second = store().addTab();
    const third = store().addTab();
    store().moveTab(third, 0);
    expect(selectActiveWorkspace(store()).tabs.map((t) => t.id)).toEqual([third, first, second]);
    store().moveTab(third, 99);
    expect(selectActiveWorkspace(store()).tabs.map((t) => t.id)).toEqual([first, second, third]);
  });

  it("moves a pane into another tab and activates it", () => {
    const { tab, a, b } = twoPaneTab();
    const other = createTab();
    const workspace = createWorkspace("w", [tab, other]);
    useAppStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
    store().movePaneToTab(a.id, other.id);
    expect(findTabOfPane(store(), a.id)?.id).toBe(other.id);
    expect(listPanes(findTab(store(), tab.id)!.layout).map((p) => p.id)).toEqual([b.id]);
    expect(selectActiveTab(store()).id).toBe(other.id);
    expect(selectActiveTab(store()).activePaneId).toBe(a.id);
    expect(countPanes(selectActiveTab(store()).layout)).toBe(2);
    // Appending to a horizontal root extends it instead of nesting.
    store().movePaneToTab(b.id, other.id);
    const root = selectActiveTab(store()).layout.root;
    expect(root.type === "split" && root.children.length).toBe(3);
  });

  it("closes a tab whose last pane moved away", () => {
    const from = createTab();
    const to = createTab();
    const workspace = createWorkspace("w", [from, to]);
    useAppStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
    const pane = listPanes(from.layout)[0];
    store().movePaneToTab(pane.id, to.id);
    expect(selectActiveWorkspace(store()).tabs.map((t) => t.id)).toEqual([to.id]);
  });
});
