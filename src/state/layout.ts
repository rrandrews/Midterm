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
  // No title: a pane's title is the name the user gave its subtab, if any.
  return { id: createId(), data: full };
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

/** Every pane in the layout, in visual (depth-first) order, hidden subtabs included. */
export function listPanes(layout: Layout): PaneNode[] {
  return tabsets(layout).flatMap((tabset) => tabset.tabs);
}

/** The pane a frame shows: its selected subtab (its first if none is selected). */
export function shownPane(frame: Pick<Tabset, "tabs" | "selectedId">): PaneNode | undefined {
  return frame.tabs.find((pane) => pane.id === frame.selectedId) ?? frame.tabs[0];
}

/** The pane each frame shows, in `listPanes` order: the panes on screen (unless one is maximized). */
export function visiblePanes(layout: Layout): PaneNode[] {
  return tabsets(layout).flatMap((tabset) => shownPane(tabset) ?? []);
}

/** The frame (library tabset) that holds a pane. */
export function frameOf(layout: Layout, paneId: string): Tabset | undefined {
  return tabsets(layout).find((tabset) => tabset.tabs.some((pane) => pane.id === paneId));
}

export function countFrames(layout: Layout): number {
  return tabsets(layout).length;
}

/** Whether a pane is the one its frame shows (not a hidden subtab). */
export function isShown(layout: Layout, paneId: string): boolean {
  const frame = frameOf(layout, paneId);
  return !!frame && shownPane(frame)?.id === paneId;
}

/**
 * The layout with `paneId` selected in its frame; the same object when it
 * already is (or is not in the layout).
 */
export function selectPaneInLayout(layout: Layout, paneId: string): Layout {
  const frame = frameOf(layout, paneId);
  if (!frame || shownPane(frame)?.id === paneId) return layout;
  const select = (node: Layout["root"]): Layout["root"] =>
    node === frame
      ? { ...node, selectedId: paneId }
      : node.type === "split"
        ? { ...node, children: node.children.map(select) }
        : node;
  return {
    ...layout,
    root: select(layout.root),
    ...(layout.floating && { floating: layout.floating.map((f) => (f === frame ? { ...f, selectedId: paneId } : f)) }),
  };
}

/** The name the user gave a pane's subtab, if any. */
export function paneName(pane: PaneNode): string | undefined {
  return pane.title?.trim() || undefined;
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

/**
 * Each numbered pane's id mapped to its label, in `visiblePanes` order (at
 * most ten panes; hidden subtabs get none). `labelOf` gives a position's
 * label, or `null` for none.
 */
export function paneNumbers(layout: Layout, labelOf: (index: number) => string | null | undefined = paneNumberLabel): Record<string, string> {
  const numbers: Record<string, string> = {};
  for (const [index, pane] of visiblePanes(layout).entries()) {
    if (index > 9) break;
    const label = labelOf(index);
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
  return frameOf(layout, paneId)?.id;
}

/**
 * Removes a pane, collapsing the splits it leaves behind.
 * Returns `null` when it was the last pane (the caller closes the tab), and
 * the same layout when the pane isn't in it.
 */
export function removePane(layout: Layout, paneId: string): Layout | null {
  return removePanes(layout, [paneId]);
}

/**
 * Removes panes, as `removePane`. A frame that loses the subtab it showed
 * but keeps others shows the next one (else the one before), as closing
 * it in the mounted layout does.
 */
export function removePanes(layout: Layout, paneIds: string[]): Layout | null {
  const gone = new Set(paneIds.filter((id) => findPane(layout, id)));
  if (gone.size === 0) return layout;
  let selected = layout;
  for (const frame of tabsets(layout)) {
    const shown = shownPane(frame);
    if (!shown || !gone.has(shown.id)) continue;
    const index = frame.tabs.indexOf(shown);
    const next = [...frame.tabs.slice(index + 1), ...frame.tabs.slice(0, index).reverse()].find((pane) => !gone.has(pane.id));
    if (next) selected = selectPaneInLayout(selected, next.id);
  }
  const next = normalizeWorkspaceModel<PaneData>(selected, {
    mapTab: (pane) => (gone.has(pane.id) ? null : pane),
  });
  if (!next || countPanes(next) === 0) return null;
  return next;
}

/** A layout node holding panes as subtabs, showing `selectedId` (the first if not given). */
export function frameNode(panes: PaneNode[], selectedId?: string): LayoutNodeInput {
  return { type: "tabset", tabs: panes, selectedId: selectedId ?? panes[0]?.id };
}

/** The layout with `pane` (or a frame of panes) added to the right of everything in it. */
export function appendPane(layout: Layout, pane: PaneNode | LayoutNodeInput): Layout {
  const node = "type" in pane ? pane : paneNode(pane);
  const root = layout.root;
  // Extend a horizontal root split rather than nesting another one in it.
  if (root.type === "split" && root.orientation === "horizontal") {
    return createLayout({ ...root, children: [...root.children, node] });
  }
  return createLayout({
    type: "split",
    orientation: "horizontal",
    children: [{ ...root, size: undefined }, node],
  });
}
