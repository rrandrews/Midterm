import { describe, expect, it } from "vitest";
import { createLayout, createPane, listPanes, paneNode } from "./layout";
import { SCHEMA_VERSION, restoreLayout, restoreState, snapshotState } from "./persist";
import { createTab, createWorkspace } from "./store";

function sampleState() {
  const a = createPane("terminal", { cwd: "/tmp" });
  const b = createPane("editor");
  const layout = createLayout({
    type: "split",
    orientation: "horizontal",
    children: [paneNode(a, 30), paneNode(b)],
  });
  const tab = { ...createTab({ title: "named", layout }), titleLocked: true, activePaneId: b.id };
  const other = createTab();
  const workspace = { ...createWorkspace("work", [tab, other]), activeTabId: other.id };
  const second = createWorkspace("second");
  return { workspaces: [workspace, second], activeWorkspaceId: second.id };
}

/** Saved data as it comes back from disk. */
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("snapshot and restore", () => {
  it("round-trips workspaces, tabs, layouts and pane data", () => {
    const state = sampleState();
    const restored = restoreState(roundTrip(snapshotState(state)));
    expect(restored).not.toBeNull();
    expect(restored?.activeWorkspaceId).toBe(state.activeWorkspaceId);
    const [work] = restored?.workspaces ?? [];
    expect(work.name).toBe("work");
    expect(work.activeTabId).toBe(state.workspaces[0].activeTabId);
    const [tab] = work.tabs;
    expect(tab.title).toBe("named");
    expect(tab.titleLocked).toBe(true);
    expect(tab.activePaneId).toBe(state.workspaces[0].tabs[0].activePaneId);
    expect(listPanes(tab.layout).map((pane) => pane.data)).toEqual([
      { kind: "terminal", cwd: "/tmp" },
      { kind: "editor" },
    ]);
  });

  it("keeps valid explorer and file fields and drops malformed ones", () => {
    const explorer = createPane("explorer", {
      root: "/src",
      pinned: true,
      showHidden: true,
      expanded: ["/src/a", "", 3 as unknown as string],
    });
    const editor = createPane("editor", { path: "/src/a/b.ts", pinned: "yes" as unknown as boolean });
    const layout = createLayout({
      type: "split",
      orientation: "horizontal",
      children: [paneNode(explorer), paneNode(editor)],
    });
    const restored = restoreLayout(roundTrip(layout));
    expect(restored && listPanes(restored).map((pane) => pane.data)).toEqual([
      { kind: "explorer", root: "/src", pinned: true, showHidden: true, expanded: ["/src/a"] },
      { kind: "editor", path: "/src/a/b.ts" },
    ]);
  });

  it("does not save transient fields", () => {
    const state = sampleState();
    state.workspaces[0].tabs[0] = { ...state.workspaces[0].tabs[0], activity: true, layoutRev: 4 };
    const saved = snapshotState(state);
    expect(saved.version).toBe(SCHEMA_VERSION);
    expect(saved.workspaces[0].tabs[0]).not.toHaveProperty("activity");
    expect(saved.workspaces[0].tabs[0]).not.toHaveProperty("layoutRev");
  });

  it("rejects unusable data", () => {
    expect(restoreState(undefined)).toBeNull();
    expect(restoreState("nope")).toBeNull();
    expect(restoreState({ version: SCHEMA_VERSION + 1, workspaces: [] })).toBeNull();
    expect(restoreState({ version: SCHEMA_VERSION, workspaces: [] })).toBeNull();
    expect(restoreState({ version: SCHEMA_VERSION, workspaces: [null, 3] })).toBeNull();
  });

  it("replaces a tab whose layout is invalid with a fresh one", () => {
    const saved = roundTrip(snapshotState(sampleState()));
    saved.workspaces[0].tabs[0].layout = { version: 1, root: { type: "bogus" } };
    const restored = restoreState(saved);
    const tab = restored?.workspaces[0].tabs[0];
    expect(tab?.title).toBe("named");
    expect(listPanes(tab!.layout).map((pane) => pane.data.kind)).toEqual(["terminal"]);
  });

  it("drops panes of unknown kinds and keeps the rest", () => {
    const saved = roundTrip(snapshotState(sampleState()));
    const root = saved.workspaces[0].tabs[0].layout.root;
    root.children[1].tabs[0].data = { kind: "spreadsheet" };
    const tab = restoreState(saved)?.workspaces[0].tabs[0];
    expect(listPanes(tab!.layout).map((pane) => pane.data.kind)).toEqual(["terminal"]);
  });

  it("falls back to existing ids for a missing active tab or workspace", () => {
    const saved = roundTrip(snapshotState(sampleState()));
    saved.activeWorkspaceId = "gone";
    saved.workspaces[0].activeTabId = "gone";
    const restored = restoreState(saved);
    expect(restored?.activeWorkspaceId).toBe(restored?.workspaces[0].id);
    expect(restored?.workspaces[0].activeTabId).toBe(restored?.workspaces[0].tabs[0].id);
  });

  it("never lets two tabs share a pane id", () => {
    const saved = roundTrip(snapshotState(sampleState()));
    saved.workspaces[1].tabs[0].layout = saved.workspaces[0].tabs[0].layout;
    const restored = restoreState(saved);
    const ids = restored!.workspaces.flatMap((w) => w.tabs.flatMap((t) => listPanes(t.layout).map((p) => p.id)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps tab ids unique across workspaces", () => {
    const saved = roundTrip(snapshotState(sampleState()));
    saved.workspaces[1].tabs[0].id = saved.workspaces[0].tabs[0].id;
    const restored = restoreState(saved)!;
    const ids = restored.workspaces.flatMap((w) => w.tabs.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const w of restored.workspaces) expect(w.tabs.some((t) => t.id === w.activeTabId)).toBe(true);
  });

  it("replaces a tab whose layout repeats a pane id", () => {
    const saved = roundTrip(snapshotState(sampleState()));
    const root = saved.workspaces[0].tabs[0].layout.root;
    root.children[1].tabs[0].id = root.children[0].tabs[0].id;
    const tab = restoreState(saved)!.workspaces[0].tabs[0];
    expect(listPanes(tab.layout)).toHaveLength(1);
    expect(tab.title).toBe("named");
  });

  it("returns null for a layout with no panes", () => {
    expect(restoreLayout({ version: 1, root: { type: "split", orientation: "horizontal", children: [] } })).toBeNull();
  });
});
