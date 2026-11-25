import { describe, expect, it } from "vitest";
import {
  countPanes,
  createLayout,
  createPane,
  findPane,
  frameIdOf,
  listPanes,
  paneIndexForDigit,
  paneNode,
  paneNumberLabel,
  paneNumbers,
  removePane,
  singlePaneLayout,
} from "./layout";
import type { Layout } from "./types";

function threePanes() {
  const a = createPane("explorer");
  const b = createPane("editor");
  const c = createPane("terminal");
  const layout = createLayout({
    type: "split",
    orientation: "horizontal",
    children: [
      paneNode(a, "220px"),
      { type: "split", orientation: "vertical", children: [paneNode(b, 47), paneNode(c)] },
    ],
  });
  return { layout, a, b, c };
}

const orientationOf = (layout: Layout) =>
  layout.root.type === "split" ? layout.root.orientation : "none";

describe("layout helpers", () => {
  it("creates a single-pane layout", () => {
    const pane = createPane();
    const layout = singlePaneLayout(pane);
    expect(layout.root.type).toBe("tabset");
    expect(listPanes(layout)).toEqual([pane]);
    expect(pane.data.kind).toBe("terminal");
  });

  it("lists panes in visual order and finds them", () => {
    const { layout, a, b, c } = threePanes();
    expect(listPanes(layout).map((pane) => pane.id)).toEqual([a.id, b.id, c.id]);
    expect(countPanes(layout)).toBe(3);
    expect(findPane(layout, b.id)?.data.kind).toBe("editor");
    expect(findPane(layout, "missing")).toBeUndefined();
  });

  it("finds the frame that holds a pane", () => {
    const { layout, b } = threePanes();
    const frameId = frameIdOf(layout, b.id);
    expect(frameId).toBeDefined();
    expect(frameIdOf(layout, "missing")).toBeUndefined();
  });

  it("gives every frame a unique id", () => {
    const { layout, a, b, c } = threePanes();
    const ids = [a, b, c].map((pane) => frameIdOf(layout, pane.id));
    expect(new Set(ids).size).toBe(3);
  });
});

describe("removePane", () => {
  it("collapses a split left with a single child into its parent", () => {
    const { layout, a, b, c } = threePanes();
    const next = removePane(layout, c.id) as Layout;
    expect(listPanes(next).map((pane) => pane.id)).toEqual([a.id, b.id]);
    // The nested vertical split is gone; only the horizontal root remains.
    expect(orientationOf(next)).toBe("horizontal");
    expect(next.root.type === "split" && next.root.children.every((n) => n.type === "tabset")).toBe(
      true,
    );
  });

  it("promotes the remaining subtree when a root child is removed", () => {
    const { layout, a, b, c } = threePanes();
    const next = removePane(layout, a.id) as Layout;
    expect(listPanes(next).map((pane) => pane.id)).toEqual([b.id, c.id]);
    expect(orientationOf(next)).toBe("vertical");
  });

  it("returns null when the last pane is removed", () => {
    const pane = createPane();
    expect(removePane(singlePaneLayout(pane), pane.id)).toBeNull();
  });

  it("returns the same layout when the pane is not in it", () => {
    const { layout } = threePanes();
    expect(removePane(layout, "missing")).toBe(layout);
  });

  it("does not mutate its input", () => {
    const { layout, c } = threePanes();
    const snapshot = JSON.stringify(layout);
    removePane(layout, c.id);
    expect(JSON.stringify(layout)).toBe(snapshot);
  });
});

describe("pane numbers", () => {
  it("labels the first nine panes 1 to 9 and the tenth 0", () => {
    expect(Array.from({ length: 10 }, (_, index) => paneNumberLabel(index))).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
    ]);
    expect(paneNumberLabel(10)).toBeNull();
    expect(paneNumberLabel(-1)).toBeNull();
  });

  it("maps digit keys back to positions", () => {
    expect(Array.from({ length: 10 }, (_, digit) => paneIndexForDigit(digit))).toEqual([
      9, 0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    // Labels and digits agree.
    for (let index = 0; index < 10; index++) {
      expect(paneIndexForDigit(Number(paneNumberLabel(index)))).toBe(index);
    }
  });

  it("numbers panes in layout order", () => {
    const { layout, a, b, c } = threePanes();
    expect(paneNumbers(layout)).toEqual({ [a.id]: "1", [b.id]: "2", [c.id]: "3" });
  });

  it("takes labels from a labeler, leaving out positions without one", () => {
    const { layout, a, b, c } = threePanes();
    const labels = ["2", "1", null];
    expect(paneNumbers(layout, (index) => labels[index])).toEqual({ [a.id]: "2", [b.id]: "1" });
    expect(c.id in paneNumbers(layout, (index) => labels[index])).toBe(false);
  });

  it("leaves panes beyond the tenth unnumbered", () => {
    const panes = Array.from({ length: 11 }, () => createPane("terminal"));
    const layout = createLayout({
      type: "split",
      orientation: "horizontal",
      children: panes.map((pane) => paneNode(pane)),
    });
    const numbers = paneNumbers(layout);
    expect(Object.keys(numbers)).toHaveLength(10);
    expect(numbers[panes[9].id]).toBe("0");
    expect(numbers[panes[10].id]).toBeUndefined();
  });
});
