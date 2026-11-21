import { describe, expect, it } from "vitest";
import { moveSelection, oneLine, searchMatches } from "./historySearch";

const entries = ["git status", "Git push", "ls -la", "echo a\necho b"];

describe("searchMatches", () => {
  it("is case-insensitive for a lowercase query", () => {
    expect(searchMatches(entries, "git").map((m) => m.entry)).toEqual(["git status", "Git push"]);
  });
  it("is case-sensitive when the query has an uppercase letter", () => {
    expect(searchMatches(entries, "Git").map((m) => m.entry)).toEqual(["Git push"]);
  });
  it("reports the matched range", () => {
    expect(searchMatches(entries, "sta")[0]).toEqual({ entry: "git status", start: 4, end: 7 });
  });
  it("matches everything for an empty query and nothing for no hit", () => {
    expect(searchMatches(entries, "")).toHaveLength(4);
    expect(searchMatches(entries, "zzz")).toEqual([]);
  });
  it("matches across lines of a multi-line entry", () => {
    expect(searchMatches(entries, "echo b")).toHaveLength(1);
  });
});

describe("moveSelection", () => {
  it("clamps to the list", () => {
    expect(moveSelection(0, -1, 3)).toBe(0);
    expect(moveSelection(2, 1, 3)).toBe(2);
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});

describe("oneLine", () => {
  it("replaces newlines", () => {
    expect(oneLine("a\nb\nc")).toBe("a⏎b⏎c");
  });
});
