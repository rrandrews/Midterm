/*
 * Pure layout and resize calculations for the Source Control vertical
 * accordion (Changes, Graph, Stashes).
 *
 * When a user drags a splitter so a section's body height drops below
 * `SCM_COLLAPSE_BODY_PX` (1.5 rows), that section collapses automatically and
 * hands its space to its neighbor. Dragging a collapsed section's splitter
 * outward past the threshold expands it again.
 */

export const SCM_PANES = ["changes", "graph", "stashes"] as const;
export type ScmPaneKey = (typeof SCM_PANES)[number];

/** Fixed header height of each top-level accordion section (matches `h-7`). */
export const SCM_HEADER_HEIGHT = 28;
/** Layout height of each horizontal resize separator (`scm-sash`). */
export const SCM_SASH_HEIGHT = 1;
/** Approximate row height across Changes (25px) and Graph/Stashes (28px). */
export const SCM_ROW_HEIGHT = 26;
/** 1.5 lines: resizing a section's body below this height collapses it. */
export const SCM_COLLAPSE_BODY_PX = Math.round(SCM_ROW_HEIGHT * 1.5); // 39px

const MIN_WEIGHT = 0.001;

export type ScmPaneWeights = Record<ScmPaneKey, number>;
export type ScmPaneHeights = Record<ScmPaneKey, number>;

export const DEFAULT_SCM_WEIGHTS: ScmPaneWeights = {
  changes: 0.46,
  graph: 0.36,
  stashes: 0.18,
};

/** Total body pixel height available after subtracting headers and sashes. */
export function availableScmBodyHeight(containerHeight: number): number {
  return Math.max(0, containerHeight - SCM_PANES.length * SCM_HEADER_HEIGHT - (SCM_PANES.length - 1) * SCM_SASH_HEIGHT);
}

/** Computes body pixel heights for each of the 3 sections given total container height. */
export function computeScmPaneHeights(
  containerHeight: number,
  collapsed: ReadonlySet<string>,
  weights: ScmPaneWeights,
): ScmPaneHeights {
  const available = availableScmBodyHeight(containerHeight);
  const open = SCM_PANES.filter((key) => !collapsed.has(key));
  const heights: ScmPaneHeights = { changes: 0, graph: 0, stashes: 0 };
  if (open.length === 0 || available <= 0) return heights;
  if (open.length === 1) {
    heights[open[0]] = available;
    return heights;
  }

  let weightSum = 0;
  for (const key of open) weightSum += Math.max(MIN_WEIGHT, weights[key] || 0);

  for (const key of open) {
    heights[key] = (Math.max(MIN_WEIGHT, weights[key] || 0) / weightSum) * available;
  }

  // Enforce the 1.5-line floor for already-open sections when enough space exists.
  if (available >= open.length * SCM_COLLAPSE_BODY_PX) {
    let deficit = 0;
    const aboveMin: ScmPaneKey[] = [];
    for (const key of open) {
      if (heights[key] < SCM_COLLAPSE_BODY_PX) {
        deficit += SCM_COLLAPSE_BODY_PX - heights[key];
        heights[key] = SCM_COLLAPSE_BODY_PX;
      } else {
        aboveMin.push(key);
      }
    }
    if (deficit > 0 && aboveMin.length > 0) {
      const surplus = aboveMin.reduce((sum, key) => sum + (heights[key] - SCM_COLLAPSE_BODY_PX), 0);
      if (surplus > 0) {
        const takeRatio = Math.min(1, deficit / surplus);
        for (const key of aboveMin) {
          heights[key] -= (heights[key] - SCM_COLLAPSE_BODY_PX) * takeRatio;
        }
      }
    }
  }

  return heights;
}

export type SashDragInput = {
  /** 0 = between Changes and Graph, 1 = between Graph and Stashes. */
  sashIndex: 0 | 1;
  /** Pointer movement along Y in pixels (positive = dragging downward). */
  deltaY: number;
  containerHeight: number;
  startHeights: ScmPaneHeights;
  startCollapsed: ReadonlySet<string>;
  startWeights: ScmPaneWeights;
};

export type SashDragResult = {
  collapsed: Set<string>;
  weights: ScmPaneWeights;
  heights: ScmPaneHeights;
};

function normalizeOpenWeights(
  heights: ScmPaneHeights,
  collapsed: ReadonlySet<string>,
  baseWeights: ScmPaneWeights,
): ScmPaneWeights {
  const next: ScmPaneWeights = { ...baseWeights };
  const open = SCM_PANES.filter((key) => !collapsed.has(key));
  const openSum = open.reduce((sum, key) => sum + Math.max(0, heights[key]), 0);
  if (open.length === 0 || openSum <= 0) return next;
  // Keep collapsed panes' stored weights intact so re-expanding restores them cleanly;
  // redistribute the open panes' total weight share proportionally to their new pixel heights.
  const openWeightBudget = open.reduce((sum, key) => sum + Math.max(MIN_WEIGHT, baseWeights[key]), 0);
  for (const key of open) {
    next[key] = Math.max(MIN_WEIGHT, (Math.max(1, heights[key]) / openSum) * openWeightBudget);
  }
  return next;
}

/**
 * Computes the next collapsed set, weights, and heights during a vertical sash drag.
 * Auto-collapses any pane shrunk below `SCM_COLLAPSE_BODY_PX` (< 1.5 lines) and
 * auto-expands a collapsed adjacent pane when dragged outward past that threshold.
 */
export function applyScmSashDrag(input: SashDragInput): SashDragResult {
  const { sashIndex, deltaY, containerHeight, startHeights, startCollapsed, startWeights } = input;
  const available = availableScmBodyHeight(containerHeight);
  const nextCollapsed = new Set(startCollapsed);
  const nextHeights: ScmPaneHeights = { ...startHeights };

  if (available <= 0 || deltaY === 0) {
    return { collapsed: nextCollapsed, weights: { ...startWeights }, heights: nextHeights };
  }

  const aboveKey: ScmPaneKey = sashIndex === 0 ? "changes" : "graph";
  const belowKey: ScmPaneKey = sashIndex === 0 ? "graph" : "stashes";
  const aboveOpen = !startCollapsed.has(aboveKey);
  const belowOpen = !startCollapsed.has(belowKey);

  // Determine the effective (upper, lower) pair participating in this drag.
  let upper: ScmPaneKey | null = null;
  let lower: ScmPaneKey | null = null;

  if (aboveOpen && belowOpen) {
    upper = aboveKey;
    lower = belowKey;
  } else if (!aboveOpen && belowOpen) {
    if (deltaY > 0) {
      // Dragging downward opens the collapsed pane immediately above the sash.
      upper = aboveKey;
      lower = belowKey;
    } else {
      // Dragging upward expands `belowKey` by taking space from an open pane further above.
      const donorAbove = sashIndex === 1 && !startCollapsed.has("changes") ? "changes" : null;
      if (donorAbove) {
        upper = donorAbove;
        lower = belowKey;
      }
    }
  } else if (aboveOpen && !belowOpen) {
    if (deltaY < 0) {
      // Dragging upward opens the collapsed pane immediately below the sash.
      upper = aboveKey;
      lower = belowKey;
    } else {
      // Dragging downward expands `aboveKey` by taking space from an open pane further below.
      const donorBelow = sashIndex === 0 && !startCollapsed.has("stashes") ? "stashes" : null;
      if (donorBelow) {
        upper = aboveKey;
        lower = donorBelow;
      }
    }
  } else {
    // Both immediate neighbors collapsed: check if dragging outward opens one against the remaining open pane.
    if (deltaY < 0 && sashIndex === 1 && !startCollapsed.has("changes")) {
      upper = "changes";
      lower = "stashes";
    } else if (deltaY > 0 && sashIndex === 0 && !startCollapsed.has("stashes")) {
      upper = "changes";
      lower = "stashes";
    }
  }

  if (!upper || !lower) {
    return { collapsed: nextCollapsed, weights: { ...startWeights }, heights: nextHeights };
  }

  const pairTotal = startHeights[upper] + startHeights[lower];
  if (pairTotal <= 0) {
    return { collapsed: nextCollapsed, weights: { ...startWeights }, heights: nextHeights };
  }

  const rawUpper = Math.max(0, Math.min(pairTotal, startHeights[upper] + deltaY));
  const rawLower = Math.max(0, pairTotal - rawUpper);

  if (rawUpper < SCM_COLLAPSE_BODY_PX) {
    nextCollapsed.add(upper);
    nextCollapsed.delete(lower);
    nextHeights[upper] = 0;
    nextHeights[lower] = pairTotal;
  } else if (rawLower < SCM_COLLAPSE_BODY_PX) {
    nextCollapsed.delete(upper);
    nextCollapsed.add(lower);
    nextHeights[upper] = pairTotal;
    nextHeights[lower] = 0;
  } else {
    nextCollapsed.delete(upper);
    nextCollapsed.delete(lower);
    nextHeights[upper] = rawUpper;
    nextHeights[lower] = rawLower;
  }

  const weights = normalizeOpenWeights(nextHeights, nextCollapsed, startWeights);
  return { collapsed: nextCollapsed, weights, heights: nextHeights };
}
