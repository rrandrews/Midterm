import { describe, expect, it } from "vitest";
import type { TextSearchFile } from "../ipc/fs";
import {
  countMatches,
  firstMatchIndex,
  flattenResults,
  indexEntries,
  indexesToRanges,
  normalizeRanges,
  resultsSummary,
  searchNames,
  segments,
  trimPreview,
} from "./search";

describe("segments", () => {
  it("splits a line around its ranges", () => {
    expect(segments("foo bar baz", [[4, 7]])).toEqual([
      { text: "foo ", hit: false },
      { text: "bar", hit: true },
      { text: " baz", hit: false },
    ]);
  });

  it("merges overlapping ranges, ignores empty and clips to the text", () => {
    expect(normalizeRanges([[5, 8], [0, 2], [2, 3], [7, 20], [4, 4]], 10)).toEqual([[0, 3], [5, 10]]);
    expect(segments("abc", [[1, 99]])).toEqual([
      { text: "a", hit: false },
      { text: "bc", hit: true },
    ]);
  });

  it("returns the text whole without ranges, and nothing for an empty text", () => {
    expect(segments("abc", [])).toEqual([{ text: "abc", hit: false }]);
    expect(segments("", [[0, 1]])).toEqual([]);
  });

  it("turns indexes into runs", () => {
    expect(indexesToRanges([0, 1, 2, 5, 7, 8])).toEqual([[0, 3], [5, 6], [7, 9]]);
    expect(indexesToRanges([])).toEqual([]);
  });

  it("trims indentation and moves the ranges with it", () => {
    expect(trimPreview("    let x", [[8, 9]])).toEqual({ text: "let x", ranges: [[4, 5]] });
    expect(trimPreview("let x", [[4, 5]])).toEqual({ text: "let x", ranges: [[4, 5]] });
  });
});

describe("searchNames", () => {
  const index = indexEntries([
    { path: "src", dir: true },
    { path: "src/components/Terminal.tsx", dir: false },
    { path: "src/terminal/index.ts", dir: false },
    { path: "docs/terminal.md", dir: false },
    { path: "README.md", dir: false },
  ]);

  it("finds nothing for a blank query", () => {
    expect(searchNames("  ", index)).toEqual([]);
  });

  it("matches names and prefers them to directories", () => {
    const results = searchNames("terminal", index);
    expect(results.map((result) => result.path).slice(0, 2).sort()).toEqual(["docs/terminal.md", "src/components/Terminal.tsx"]);
    expect(results[2].path).toBe("src/terminal/index.ts");
    const terminal = results.find((result) => result.path === "src/components/Terminal.tsx");
    expect(terminal).toMatchObject({ name: "Terminal.tsx", parent: "src/components", dir: false, nameRanges: [[0, 8]] });
    // The last one only matched in its directory.
    expect(results[2].nameRanges).toEqual([]);
    expect(results[2].parentRanges).toEqual([[4, 12]]);
  });

  it("flags directories and gives them an empty parent at the top", () => {
    expect(searchNames("src", index)[0]).toMatchObject({ path: "src", dir: true, parent: "" });
  });

  it("respects the limit", () => {
    expect(searchNames("e", index, 2)).toHaveLength(2);
  });
});

describe("flattenResults", () => {
  const files: TextSearchFile[] = [
    {
      path: "a.ts",
      matches: [
        { line: 1, column: 1, text: "foo", ranges: [[0, 3]] },
        { line: 4, column: 7, text: "x foo", ranges: [[2, 5]] },
      ],
    },
    { path: "b/c.ts", matches: [{ line: 2, column: 1, text: "foo", ranges: [[0, 3]] }] },
  ];

  it("lists a header per file followed by its matches", () => {
    const rows = flattenResults(files, new Set());
    expect(rows.map((row) => row.type)).toEqual(["file", "match", "match", "file", "match"]);
    expect(rows[0]).toMatchObject({ path: "a.ts", count: 2, collapsed: false });
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("hides the matches of collapsed files but keeps their count", () => {
    const rows = flattenResults(files, new Set(["a.ts"]));
    expect(rows.map((row) => row.type)).toEqual(["file", "file", "match"]);
    expect(rows[0]).toMatchObject({ count: 2, collapsed: true });
  });

  it("finds the first match and counts", () => {
    expect(firstMatchIndex(flattenResults(files, new Set()))).toBe(1);
    expect(firstMatchIndex(flattenResults(files, new Set(["a.ts", "b/c.ts"])))).toBe(0);
    expect(firstMatchIndex([])).toBe(0);
    expect(countMatches(files)).toBe(3);
  });

  it("summarizes", () => {
    expect(resultsSummary(1, 1)).toBe("1 result in 1 file");
    expect(resultsSummary(1200, 3)).toBe("1,200 results in 3 files");
  });
});
