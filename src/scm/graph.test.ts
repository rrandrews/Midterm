import { describe, expect, it } from "vitest";
import type { ScmCommit } from "../ipc/scm";
import { computeGraphLayout } from "./graph";

function commit(hash: string, parents: string[], head = false): ScmCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    author: "Dev",
    email: "dev@test",
    date: 1_700_000_000,
    subject: hash,
    body: "",
    refs: head ? [{ kind: "head", name: "main" }] : [],
  };
}

describe("scm/graph", () => {
  it("lays out a linear history in a single lane", () => {
    const rows = computeGraphLayout([
      commit("c3", ["c2"], true),
      commit("c2", ["c1"]),
      commit("c1", []),
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0].isHead).toBe(true);
    expect(rows[0].incoming).toEqual([]);
    expect(rows[0].outgoing).toEqual([{ fromLane: 0, toLane: 0, colorIndex: 0 }]);
    expect(rows[2].outgoing).toEqual([]);
  });

  it("allocates a branch lane for merge commits and converges back onto the common ancestor", () => {
    // M merges main (A) and feature (B), both forked from Base.
    const rows = computeGraphLayout([
      commit("M", ["A", "B"], true),
      commit("B", ["Base"]),
      commit("A", ["Base"]),
      commit("Base", []),
    ]);
    expect(rows[0].lane).toBe(0);
    expect(rows[0].isMerge).toBe(true);
    // Outgoing edges go to lane 0 (A) and lane 1 (B).
    expect(rows[0].outgoing.map((e) => [e.fromLane, e.toLane])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    // B sits on lane 1, A sits on lane 0 and converges to Base.
    expect(rows[1].lane).toBe(1);
    expect(rows[2].lane).toBe(0);
    // Base is reached cleanly and terminates.
    expect(rows[3].outgoing).toEqual([]);
  });
});
