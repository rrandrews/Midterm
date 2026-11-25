import { normalizeWorkspaceModel } from "react-resizable-panels";
import type { Layout, LayoutNodeInput, PaneData, PaneKind, PaneNode } from "./types";

export function createId(): string {
  return crypto.randomUUID();
}

/**
 * Data for a pane created without a kind (a new tab, a fresh tab replacing
 * a closed one). The plugin layer installs one that follows the
 * `defaultPaneKind` setting; the fallback keeps pure code (and tests) free
 * of that dependency.
 */
let defaultPaneData: () => PaneData = () => ({ kind: "terminal" });

export function setDefaultPaneData(factory: () => PaneData): void {
  defaultPaneData = factory;
}

/** A new pane of `kind` with `data`, or of the default kind when no kind is given. */
export function createPane(kind?: PaneKind, data: Omit<PaneData, "kind"> = {}): PaneNode {
  const full: PaneData = kind === undefined ? { ...defaultPaneData(), ...data } : { ...data, kind };
  return { id: createId(), title: full.kind, data: full };
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

/**
 * The digit key that selects the pane at a position in `listPanes` order:
 * "1" … "9" for the first nine, "0" for the tenth, `null` beyond that.
 */
export function paneNumberLabel(index: number): string | null {
  if (index < 0 || index > 9) return null;
  return String((index + 1) % 10);
}

/** The position in `listPanes` order a digit key selects: "1" is 0, … "9" is 8, "0" is 9. */
export function paneIndexForDigit(digit: number): number {
  return (digit + 9) % 10;
}

/** Each numbered pane's id mapped to its label, in `listPanes` order (at most ten panes). */
export function paneNumbers(layout: Layout): Record<string, string> {
  const numbers: Record<string, string> = {};
  for (const [index, pane] of listPanes(layout).entries()) {
    const label = paneNumberLabel(index);
    if (label) numbers[pane.id] = label;
  }
  return numbers;
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

/** The layout with `pane` added to the right of everything in it. */
export function appendPane(layout: Layout, pane: PaneNode): Layout {
  const root = layout.root;
  // Extend a horizontal root split rather than nesting another one in it.
  if (root.type === "split" && root.orientation === "horizontal") {
    return createLayout({ ...root, children: [...root.children, paneNode(pane)] });
  }
  return createLayout({
    type: "split",
    orientation: "horizontal",
    children: [{ ...root, size: undefined }, paneNode(pane)],
  });
}
