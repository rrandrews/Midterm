import { describe, expect, it } from "vitest";
import { findFileLinks, resolveLinkPath } from "./fileLinks";

const paths = (text: string) => findFileLinks(text).map(({ path, line, column }) => ({ path, line, column }));

describe("findFileLinks", () => {
  it("finds path:line:col in compiler and linter output", () => {
    expect(paths("src/main.rs:12:5: error")).toEqual([{ path: "src/main.rs", line: 12, column: 5 }]);
    expect(paths("  --> src/lib.rs:3:1")).toEqual([{ path: "src/lib.rs", line: 3, column: 1 }]);
    expect(paths("at foo (/app/dist/index.js:10:15)")).toEqual([{ path: "/app/dist/index.js", line: 10, column: 15 }]);
    expect(paths("./a.ts:7")).toEqual([{ path: "./a.ts", line: 7, column: undefined }]);
  });

  it("covers exactly the reference", () => {
    const text = "error in src/a.ts:12:5: oops";
    const [match] = findFileLinks(text);
    expect(text.slice(match.start, match.end)).toBe("src/a.ts:12:5");
  });

  it("understands tsc and Python formats", () => {
    const tsc = "src/App.tsx(12,5): error TS2322";
    const [match] = findFileLinks(tsc);
    expect(match).toMatchObject({ path: "src/App.tsx", line: 12, column: 5 });
    expect(tsc.slice(match.start, match.end)).toBe("src/App.tsx(12,5)");
    expect(paths('  File "/usr/lib/x.py", line 42, in main')).toEqual([
      { path: "/usr/lib/x.py", line: 42, column: undefined },
    ]);
  });

  it("finds plain paths and file names", () => {
    expect(paths("modified:   docs/editor.md")).toEqual([{ path: "docs/editor.md", line: undefined, column: undefined }]);
    expect(paths("see README.md.")).toEqual([{ path: "README.md", line: undefined, column: undefined }]);
    expect(paths("~/notes.txt")).toEqual([{ path: "~/notes.txt", line: undefined, column: undefined }]);
  });

  it("skips URLs, numbers, versions and flags", () => {
    expect(paths("http://localhost:1420/ ready")).toEqual([]);
    expect(paths("v1.2.3 took 3.5s at 12:30")).toEqual([]);
    expect(paths("--force -rf . ..")).toEqual([]);
    expect(paths("hello world")).toEqual([]);
  });
});

describe("resolveLinkPath", () => {
  it("resolves against the cwd and home", () => {
    expect(resolveLinkPath("src/a.ts", "/repo", "/home/me")).toBe("/repo/src/a.ts");
    expect(resolveLinkPath("../b.ts", "/repo/sub", undefined)).toBe("/repo/b.ts");
    expect(resolveLinkPath("/abs/c.ts", undefined, undefined)).toBe("/abs/c.ts");
    expect(resolveLinkPath("~/d.md", "/repo", "/home/me")).toBe("/home/me/d.md");
    expect(resolveLinkPath("~bob/x", "/repo", "/home/me")).toBeNull();
    expect(resolveLinkPath("rel.ts", undefined, "/home/me")).toBeNull();
  });
});

describe("findFileLinks with names", () => {
  const names = (text: string) => findFileLinks(text, { names: true }).map(({ path }) => path);

  it("finds bare names as ls prints them", () => {
    expect(names("Makefile   README.md   src   node_modules")).toEqual(["Makefile", "README.md", "src", "node_modules"]);
  });

  it("handles ls -F markers, keeping them in the range", () => {
    const text = "src/  run.sh*  link@";
    const found = findFileLinks(text, { names: true });
    expect(found.map(({ path, unmarked }) => [path, unmarked])).toEqual([
      ["src", undefined],
      // A literal `run.sh*` is tried first, then `run.sh`.
      ["run.sh*", "run.sh"],
      ["link@", "link"],
    ]);
    expect(text.slice(found[0].start, found[0].end)).toBe("src/");
  });

  it("skips options, numbers and punctuation", () => {
    expect(names("-rw-r--r--  1  4096  12:30  --  .  ..  ~  /")).toEqual([]);
  });

  it("still finds references with positions", () => {
    expect(findFileLinks("src/a.ts:3:1: oops", { names: true })[0]).toMatchObject({ path: "src/a.ts", line: 3, column: 1 });
  });

  it("is off by default", () => {
    expect(paths("Makefile src")).toEqual([]);
  });
});
