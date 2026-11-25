import { describe, expect, it } from "vitest";
import { createLayout, createPane, paneNode } from "../state/layout";
import { clampSizeLimits, type FrameLimits, frameLimitUpdates, withSizeLimits } from "./paneSize";

describe("clampSizeLimits", () => {
  it("keeps sensible values and writes pixels", () => {
    expect(clampSizeLimits({ minWidth: 240, maxHeight: 300.4 })).toEqual({
      minWidth: "240px",
      minHeight: undefined,
      maxWidth: undefined,
      maxHeight: "300px",
    });
  });

  it("clamps minimums to their range and raises maximums to the floor and the minimum", () => {
    expect(clampSizeLimits({ minWidth: 10, minHeight: 5000, maxWidth: 20, maxHeight: 50 })).toEqual({
      minWidth: "96px",
      minHeight: "600px",
      maxWidth: "160px",
      maxHeight: "600px",
    });
  });

  it("drops values that are not positive finite numbers", () => {
    const junk = { minWidth: "200", minHeight: Number.NaN, maxWidth: -5, maxHeight: Number.POSITIVE_INFINITY } as never;
    expect(clampSizeLimits(junk)).toEqual({});
    expect(clampSizeLimits(undefined)).toEqual({});
    expect(clampSizeLimits("big" as never)).toEqual({});
  });
});

describe("frame limits in a layout", () => {
  const limits: Record<string, FrameLimits> = { explorer: { minWidth: "180px", maxWidth: "480px" } };
  const limitsOf = (kind: string) => limits[kind] ?? {};
  const layout = () =>
    createLayout({ type: "split", orientation: "horizontal", children: [paneNode(createPane("explorer")), paneNode(createPane("terminal"))] });

  it("sets each frame's limits from its pane's kind, and then has nothing to update", () => {
    const before = layout();
    expect(frameLimitUpdates(before, limitsOf)).toHaveLength(1);
    const after = withSizeLimits(before, limitsOf);
    const root = after.root as Extract<typeof after.root, { type: "split" }>;
    expect(root.children[0]).toMatchObject({ minWidth: "180px", maxWidth: "480px" });
    expect(root.children[1]).not.toHaveProperty("minWidth");
    expect(frameLimitUpdates(after, limitsOf)).toEqual([]);
    expect(withSizeLimits(after, limitsOf)).toBe(after);
  });

  it("removes limits a kind no longer asks for", () => {
    const limited = withSizeLimits(layout(), limitsOf);
    const updates = frameLimitUpdates(limited, () => ({}));
    expect(updates).toHaveLength(1);
    expect(updates[0].limits).toEqual({ minWidth: undefined, minHeight: undefined, maxWidth: undefined, maxHeight: undefined });
    const cleared = withSizeLimits(limited, () => ({}));
    const root = cleared.root as Extract<typeof cleared.root, { type: "split" }>;
    expect(root.children[0]).not.toHaveProperty("minWidth");
    expect(root.children[0]).not.toHaveProperty("maxWidth");
  });
});
