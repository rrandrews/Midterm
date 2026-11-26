import { describe, expect, it } from "vitest";
import type { FsEntry } from "../ipc/fs";
import {
  type Listing,
  type Row,
  baseName,
  displayPath,
  findByPrefix,
  flattenTree,
  gitBadges,
  isWithin,
  joinPath,
  parentPath,
  relativePath,
  rowId,
  validName,
} from "./tree";

const file = (path: string): FsEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  kind: "file",
  symlink: false,
  hidden: false,
  ignored: false,
});
const dir = (path: string): FsEntry => ({ ...file(path), kind: "dir" });
const loaded = (...entries: FsEntry[]): Listing => ({ state: "loaded", entries });

describe("paths", () => {
  it("joins, splits and relativizes", () => {
    expect(joinPath("/a", "b")).toBe("/a/b");
    expect(joinPath("/", "b")).toBe("/b");
    expect(parentPath("/a/b")).toBe("/a");
    expect(parentPath("/a")).toBe("/");
    expect(relativePath("/a/b/c", "/a")).toBe("b/c");
    expect(relativePath("/a/b", "/")).toBe("a/b");
    expect(relativePath("/a", "/a")).toBe("");
  });

  it("shortens the home directory, but not a sibling that shares its prefix", () => {
    expect(displayPath("/Users/me/src", "/Users/me")).toBe("~/src");
    expect(displayPath("/Users/me", "/Users/me")).toBe("~");
    expect(displayPath("/Users/meg", "/Users/me")).toBe("/Users/meg");
  });

  it("accepts single path components only", () => {
    expect(validName("  a.ts ")).toBe("a.ts");
    expect(validName("a/b")).toBeNull();
    expect(validName("..")).toBeNull();
    expect(validName(" ")).toBeNull();
  });

  it("handles remote ssh:// locations cleanly without host collisions or prefix leaks", () => {
    expect(joinPath("ssh://box/", "etc")).toBe("ssh://box/etc");
    expect(joinPath("ssh://box/srv", "app")).toBe("ssh://box/srv/app");
    expect(parentPath("ssh://box/srv/app")).toBe("ssh://box/srv");
    expect(parentPath("ssh://box/srv")).toBe("ssh://box/");
    expect(parentPath("ssh://box/")).toBe("ssh://box/");
    expect(baseName("ssh://box/srv/app")).toBe("app");
    expect(baseName("ssh://box/")).toBe("/");

    expect(isWithin("ssh://box/srv/app", "ssh://box/srv")).toBe(true);
    expect(isWithin("ssh://box/srv/app", "ssh://box/")).toBe(true);
    expect(isWithin("ssh://box/srv/app", "/")).toBe(false);
    expect(isWithin("ssh://box/srv/app", "ssh://other/srv")).toBe(false);

    expect(relativePath("ssh://box/srv/app", "ssh://box/")).toBe("srv/app");
    expect(relativePath("ssh://box/srv/app", "ssh://box/srv")).toBe("app");

    expect(displayPath("ssh://box/home/u/app", "ssh://box/home/u")).toBe("~/app");
    expect(displayPath("ssh://box/home/u", "ssh://box/home/u")).toBe("~");
    expect(displayPath("ssh://box/etc", "ssh://box/")).toBe("~/etc");
    // A plain local home path must NOT falsely shorten a remote path.
    expect(displayPath("ssh://box/home/u/app", "/home/u")).toBe("/home/u/app");
    expect(displayPath("ssh://box/etc/hosts", "/home/u")).toBe("/etc/hosts");
    expect(isWithin("ssh://box/srv/app", "ssh://box///")).toBe(true);
    expect(relativePath("ssh://box/srv/app", "ssh://box///")).toBe("srv/app");

    const remoteBadges = gitBadges({
      root: "ssh://box/",
      branch: "main",
      entries: { "etc/hosts": "M" },
    });
    expect(remoteBadges.get("ssh://box/etc/hosts")).toBe("M");
    expect(remoteBadges.get("ssh://box/etc")).toBe("M");
    expect(remoteBadges.get("ssh://box/")).toBe("M");
  });
});

describe("flattenTree", () => {
  const listings = new Map<string, Listing>([
    ["/r", loaded(dir("/r/src"), dir("/r/docs"), file("/r/README.md"))],
    ["/r/src", loaded(file("/r/src/a.ts"))],
    ["/r/docs", { state: "loading" }],
  ]);

  it("shows expanded directories' contents below them", () => {
    const rows = flattenTree({ root: "/r", expanded: new Set(["/r/src"]), listings });
    expect(rows.map((row) => [rowId(row), row.depth])).toEqual([
      ["/r/src", 0],
      ["/r/src/a.ts", 1],
      ["/r/docs", 0],
      ["/r/README.md", 0],
    ]);
  });

  it("shows a placeholder for a directory still loading, and the field for a new entry", () => {
    const rows = flattenTree({
      root: "/r",
      expanded: new Set(["/r/docs"]),
      listings,
      creating: { dir: "/r/docs", kind: "file" },
    });
    expect(rows.slice(1, 4).map((row) => row.type)).toEqual(["entry", "create", "status"]);
  });

  it("shows nothing for a root that is loading, and the reason for one that failed", () => {
    expect(flattenTree({ root: "/x", expanded: new Set(), listings })).toEqual([]);
    const failed = new Map<string, Listing>([["/x", { state: "error", message: "Permission denied" }]]);
    expect(flattenTree({ root: "/x", expanded: new Set(), listings: failed })).toMatchObject([
      { type: "status", text: "Permission denied" },
    ]);
  });
});

describe("gitBadges", () => {
  const badges = gitBadges({
    root: "/r",
    branch: "main",
    entries: { "src/a.ts": "U", "src/deep/b.ts": "M", "README.md": "D" },
  });

  it("badges files as reported", () => {
    expect(badges.get("/r/src/a.ts")).toBe("U");
    expect(badges.get("/r/src/c.ts")).toBeUndefined();
  });

  it("rolls the most significant status up to each directory", () => {
    expect(badges.get("/r/src/deep")).toBe("M");
    expect(badges.get("/r/src")).toBe("M");
    expect(badges.get("/r")).toBe("D");
    expect(badges.get("/")).toBeUndefined();
  });

  it("has no badges without a repository", () => {
    expect(gitBadges(null).get("/r")).toBeUndefined();
  });
});

describe("findByPrefix", () => {
  const rows: Row[] = ["/r/apple", "/r/banana", "/r/avocado", "/r/apricot"].map((path) => ({
    type: "entry",
    entry: file(path),
    depth: 0,
    expanded: false,
  }));

  it("finds the next match after the current row, wrapping", () => {
    expect(findByPrefix(rows, 0, "a", false)).toBe(2);
    expect(findByPrefix(rows, 3, "a", false)).toBe(0);
    expect(findByPrefix(rows, 0, "z", false)).toBe(-1);
  });

  it("keeps the current row while a longer prefix still matches it", () => {
    expect(findByPrefix(rows, 3, "ap", false)).toBe(3);
    expect(findByPrefix(rows, 0, "apr", false)).toBe(3);
  });

  it("cycles through names starting with a repeated letter", () => {
    expect(findByPrefix(rows, 2, "aa", true)).toBe(3);
  });
});
