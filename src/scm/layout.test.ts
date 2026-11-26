import { describe, expect, it } from "vitest";
import {
  applyScmSashDrag,
  computeScmPaneHeights,
  DEFAULT_SCM_WEIGHTS,
  SCM_COLLAPSE_BODY_PX,
  SCM_HEADER_HEIGHT,
  SCM_SASH_HEIGHT,
} from "./layout";

describe("scm/layout", () => {
  const containerHeight = 3 * SCM_HEADER_HEIGHT + 2 * SCM_SASH_HEIGHT + 400; // 400px available body height

  it("distributes available height proportionally across open panes", () => {
    const heights = computeScmPaneHeights(containerHeight, new Set(), DEFAULT_SCM_WEIGHTS);
    expect(Math.round(heights.changes + heights.graph + heights.stashes)).toBe(400);
    expect(heights.changes).toBeGreaterThan(heights.graph);
    expect(heights.graph).toBeGreaterThan(heights.stashes);

    // Single open pane takes 100% of available height.
    const single = computeScmPaneHeights(containerHeight, new Set(["graph", "stashes"]), DEFAULT_SCM_WEIGHTS);
    expect(single).toEqual({ changes: 400, graph: 0, stashes: 0 });
  });

  it("collapses upper pane when dragged below 1.5 lines", () => {
    const startCollapsed = new Set<string>();
    const startHeights = computeScmPaneHeights(containerHeight, startCollapsed, DEFAULT_SCM_WEIGHTS);

    // Drag sash 0 (Changes | Graph) up so Changes drops below SCM_COLLAPSE_BODY_PX.
    const deltaY = -(startHeights.changes - (SCM_COLLAPSE_BODY_PX - 4));
    const res = applyScmSashDrag({
      sashIndex: 0,
      deltaY,
      containerHeight,
      startHeights,
      startCollapsed,
      startWeights: DEFAULT_SCM_WEIGHTS,
    });
    expect(res.collapsed.has("changes")).toBe(true);
    expect(res.collapsed.has("graph")).toBe(false);
    expect(res.heights.changes).toBe(0);
    expect(res.heights.graph).toBeCloseTo(startHeights.changes + startHeights.graph, 5);
  });

  it("collapses lower pane when dragged below 1.5 lines", () => {
    const startCollapsed = new Set<string>();
    const startHeights = computeScmPaneHeights(containerHeight, startCollapsed, DEFAULT_SCM_WEIGHTS);

    // Drag sash 1 (Graph | Stashes) down so Stashes drops below SCM_COLLAPSE_BODY_PX.
    const deltaY = startHeights.stashes - (SCM_COLLAPSE_BODY_PX - 5);
    const res = applyScmSashDrag({
      sashIndex: 1,
      deltaY,
      containerHeight,
      startHeights,
      startCollapsed,
      startWeights: DEFAULT_SCM_WEIGHTS,
    });
    expect(res.collapsed.has("stashes")).toBe(true);
    expect(res.heights.stashes).toBe(0);
    expect(res.heights.graph).toBeCloseTo(startHeights.graph + startHeights.stashes, 5);
  });

  it("expands a collapsed pane when dragged outward past 1.5 lines", () => {
    const startCollapsed = new Set<string>(["stashes"]);
    const startHeights = computeScmPaneHeights(containerHeight, startCollapsed, DEFAULT_SCM_WEIGHTS);
    expect(startHeights.stashes).toBe(0);

    // Dragging less than 1.5 lines keeps Stashes collapsed.
    const tooSmall = applyScmSashDrag({
      sashIndex: 1,
      deltaY: -(SCM_COLLAPSE_BODY_PX - 5),
      containerHeight,
      startHeights,
      startCollapsed,
      startWeights: DEFAULT_SCM_WEIGHTS,
    });
    expect(tooSmall.collapsed.has("stashes")).toBe(true);

    // Dragging past 1.5 lines expands Stashes cleanly.
    const expanded = applyScmSashDrag({
      sashIndex: 1,
      deltaY: -(SCM_COLLAPSE_BODY_PX + 25),
      containerHeight,
      startHeights,
      startCollapsed,
      startWeights: DEFAULT_SCM_WEIGHTS,
    });
    expect(expanded.collapsed.has("stashes")).toBe(false);
    expect(expanded.heights.stashes).toBe(SCM_COLLAPSE_BODY_PX + 25);
  });

  it("resizes Changes against Stashes across a collapsed Graph section", () => {
    const startCollapsed = new Set<string>(["graph"]);
    const startHeights = computeScmPaneHeights(containerHeight, startCollapsed, DEFAULT_SCM_WEIGHTS);
    const res = applyScmSashDrag({
      sashIndex: 1,
      deltaY: -40,
      containerHeight,
      startHeights,
      startCollapsed,
      startWeights: DEFAULT_SCM_WEIGHTS,
    });
    expect(res.collapsed.has("graph")).toBe(true);
    expect(res.heights.stashes).toBeCloseTo(startHeights.stashes + 40, 5);
    expect(res.heights.changes).toBeCloseTo(startHeights.changes - 40, 5);
  });

  it("preserves small valid weights below 5% on tall panes right down to the collapse threshold", () => {
    const tallHeight = 3 * SCM_HEADER_HEIGHT + 2 * SCM_SASH_HEIGHT + 1200;
    const startCollapsed = new Set<string>();
    const startHeights = computeScmPaneHeights(tallHeight, startCollapsed, DEFAULT_SCM_WEIGHTS);
    const deltaY = -(startHeights.changes - 42);
    const dragged = applyScmSashDrag({
      sashIndex: 0,
      deltaY,
      containerHeight: tallHeight,
      startHeights,
      startCollapsed,
      startWeights: DEFAULT_SCM_WEIGHTS,
    });
    expect(dragged.collapsed.has("changes")).toBe(false);
    const recomputed = computeScmPaneHeights(tallHeight, dragged.collapsed, dragged.weights);
    expect(recomputed.changes).toBeCloseTo(42, 0);
  });
});
