import { normalizeWorkspaceModel } from "react-resizable-panels";
import type { Layout, LayoutNodeInput, PaneData, PaneKind, PaneNode } from "./types";

export const PANE_LABELS: Record<PaneKind, string> = {
  terminal: "Terminal",
  explorer: "Explorer",
  editor: "Editor",
  viewer: "Viewer",
};

export function createId(): string {
  return crypto.randomUUID();
}

export function createPane(kind: PaneKind = "terminal", data: Omit<PaneData, "kind"> = {}): PaneNode {
  return { id: createId(), title: PANE_LABELS[kind], data: { ...data, kind } };
}

/** A layout node holding a single pane. */
export function paneNode(pane: PaneNode, size?: number | string): LayoutNodeInput {
  return { type: "tabset", size, tabs: [pane] };
}

/** Builds a valid layout (ids assigned, sizes normalized) from a node tree. */
export function createLayout(root: LayoutNodeInput): Layout {
  const layout = normalizeWorkspaceModel<PaneData>({ version: 1, root });
  if (!layout) throw new Error("Invalid layout");
  return layout;
}

export function singlePaneLayout(pane: PaneNode = createPane()): Layout {
  return createLayout(paneNode(pane));
}

type Tabset = Extract<Layout["root"], { type: "tabset" }>;

function tabsets(layout: Layout): Tabset[] {
  const found: Tabset[] = [];
  const visit = (node: Layout["root"]) => {
    if (node.type === "tabset") found.push(node);
    else node.children.forEach(visit);
  };
  visit(layout.root);
  for (const floating of layout.floating ?? []) found.push(floating);
  return found;
}

/** Every pane in the layout, in visual (depth-first) order. */
export function listPanes(layout: Layout): PaneNode[] {
  return tabsets(layout).flatMap((tabset) => tabset.tabs);
}

export function countPanes(layout: Layout): number {
  return listPanes(layout).length;
}

export function findPane(layout: Layout, paneId: string): PaneNode | undefined {
  return listPanes(layout).find((pane) => pane.id === paneId);
}

/** Id of the frame (library tabset) that currently holds the pane. */
export function frameIdOf(layout: Layout, paneId: string): string | undefined {
  return tabsets(layout).find((tabset) => tabset.tabs.some((pane) => pane.id === paneId))?.id;
}

/**
 * Removes a pane, collapsing the splits it leaves behind.
 * Returns `null` when it was the last pane (the caller closes the tab), and
 * the same layout when the pane isn't in it.
 */
export function removePane(layout: Layout, paneId: string): Layout | null {
  if (!findPane(layout, paneId)) return layout;
  const next = normalizeWorkspaceModel<PaneData>(layout, {
    mapTab: (pane) => (pane.id === paneId ? null : pane),
  });
  if (!next || countPanes(next) === 0) return null;
  return next;
}
