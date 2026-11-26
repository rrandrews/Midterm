import type { ScmCommit } from "../ipc/scm";

/*
 * Pure SVG commit-graph lane layout calculator.
 * Assigns each commit a horizontal lane and tracks active parent rails from
 * top (newest) to bottom (oldest), producing exact vertical and curved edge
 * segments for every row.
 */

export type GraphEdge = {
  fromLane: number;
  toLane: number;
  colorIndex: number;
};

export type GraphRowLayout = {
  lane: number;
  colorIndex: number;
  /** Active rails continuing straight through the top half into this row. */
  incoming: GraphEdge[];
  /** Rails leaving this row downward (including forks and merges). */
  outgoing: GraphEdge[];
  /** Number of lane columns visible on this row (at least `lane + 1`). */
  laneCount: number;
  isHead: boolean;
  isMerge: boolean;
};

export const GRAPH_LANE_COLORS = [
  "var(--color-accent)",
  "var(--color-info)",
  "var(--color-ok)",
  "var(--color-warn)",
  "var(--color-keyword)",
  "var(--color-err)",
] as const;

type Rail = {
  /** Expected commit hash for this rail, or null if vacant. */
  hash: string | null;
  colorIndex: number;
};

/**
 * Computes per-row graph rail geometry for a chronologically/topologically
 * ordered list of commits from `git log`.
 */
export function computeGraphLayout(commits: readonly ScmCommit[]): GraphRowLayout[] {
  const rails: Rail[] = [];
  let nextColor = 0;
  const rows: GraphRowLayout[] = [];

  const allocColor = () => {
    const c = nextColor % GRAPH_LANE_COLORS.length;
    nextColor += 1;
    return c;
  };

  for (const commit of commits) {
    // Capture incoming vertical rails from the previous row.
    const incoming: GraphEdge[] = [];
    for (let i = 0; i < rails.length; i++) {
      if (rails[i].hash !== null) {
        incoming.push({ fromLane: i, toLane: i, colorIndex: rails[i].colorIndex });
      }
    }

    // Locate the first rail expecting this commit, or allocate the leftmost free lane.
    let lane = rails.findIndex((r) => r.hash === commit.hash);
    let colorIndex: number;
    if (lane !== -1) {
      colorIndex = rails[lane].colorIndex;
    } else {
      const empty = rails.findIndex((r) => r.hash === null);
      colorIndex = allocColor();
      if (empty !== -1) {
        lane = empty;
        rails[lane] = { hash: commit.hash, colorIndex };
      } else {
        lane = rails.length;
        rails.push({ hash: commit.hash, colorIndex });
      }
    }

    // Any duplicate rails also waiting on this commit converge into `lane` on the top half.
    const duplicateLanes: number[] = [];
    for (let i = lane + 1; i < rails.length; i++) {
      if (rails[i].hash === commit.hash) {
        duplicateLanes.push(i);
        // Replace the straight incoming segment for the converging lane with a curve into `lane`.
        const idx = incoming.findIndex((e) => e.fromLane === i && e.toLane === i);
        if (idx !== -1) {
          incoming[idx] = { fromLane: i, toLane: lane, colorIndex: rails[i].colorIndex };
        }
        rails[i] = { hash: null, colorIndex: rails[i].colorIndex };
      }
    }

    // Build outgoing rails for the bottom half of the row.
    const outgoing: GraphEdge[] = [];

    // Existing non-commit rails pass straight through.
    for (let i = 0; i < rails.length; i++) {
      if (i === lane) continue;
      if (rails[i].hash !== null) {
        outgoing.push({ fromLane: i, toLane: i, colorIndex: rails[i].colorIndex });
      }
    }

    const parents = commit.parents;
    if (parents.length === 0) {
      // Root commit: rail terminates here.
      rails[lane] = { hash: null, colorIndex };
    } else {
      // First parent stays on `lane` unless another rail already tracks it (in which case curve into it).
      const firstParent = parents[0];
      const existingFirst = rails.findIndex((r, idx) => idx !== lane && r.hash === firstParent);
      if (existingFirst !== -1) {
        outgoing.push({ fromLane: lane, toLane: existingFirst, colorIndex });
        rails[lane] = { hash: null, colorIndex };
      } else {
        rails[lane] = { hash: firstParent, colorIndex };
        outgoing.push({ fromLane: lane, toLane: lane, colorIndex });
      }

      // Secondary parents (merges): curve to an existing rail or open a new branch lane.
      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p];
        const existing = rails.findIndex((r) => r.hash === parentHash);
        if (existing !== -1) {
          outgoing.push({ fromLane: lane, toLane: existing, colorIndex: rails[existing].colorIndex });
        } else {
          const free = rails.findIndex((r) => r.hash === null);
          const pColor = allocColor();
          let targetLane: number;
          if (free !== -1) {
            targetLane = free;
            rails[free] = { hash: parentHash, colorIndex: pColor };
          } else {
            targetLane = rails.length;
            rails.push({ hash: parentHash, colorIndex: pColor });
          }
          outgoing.push({ fromLane: lane, toLane: targetLane, colorIndex: pColor });
        }
      }
    }

    // Trim trailing vacant lanes so the graph stays compact.
    const maxEdgeLane = Math.max(
      lane,
      ...duplicateLanes,
      ...incoming.map((e) => Math.max(e.fromLane, e.toLane)),
      ...outgoing.map((e) => Math.max(e.fromLane, e.toLane)),
    );
    while (rails.length > 0 && rails[rails.length - 1].hash === null) {
      rails.pop();
    }

    rows.push({
      lane,
      colorIndex,
      incoming,
      outgoing,
      laneCount: Math.max(1, maxEdgeLane + 1),
      isHead: commit.refs.some((r) => r.kind === "head"),
      isMerge: parents.length > 1,
    });
  }

  return rows;
}
