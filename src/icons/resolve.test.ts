import { describe, expect, it } from "vitest";
import { buildIndex, extensionsOf, iconIdFor } from "./resolve";
import type { IconQuery } from "./types";

const index = buildIndex({
  file: "file",
  folder: "folder",
  folderExpanded: "folder-open",
  fileNames: { "package.json": "npm", "README.md": "readme", ".config/tool.json": "tool", constructor: "ctor" },
  fileExtensions: { ts: "ts", "test.ts": "test", gitignore: "git", json: "json" },
  folderNames: { src: "folder-src", ".github/workflows": "folder-gha" },
  folderNamesExpanded: { src: "folder-src-open" },
  languageIds: { python: "py" },
  light: { fileExtensions: { ts: "ts-light" } },
});

const file = (name: string, extra: Partial<IconQuery> = {}): IconQuery => ({ name, kind: "file", expanded: false, light: false, ...extra });
const dir = (name: string, expanded = false, extra: Partial<IconQuery> = {}): IconQuery => ({ name, kind: "dir", expanded, light: false, ...extra });

describe("iconIdFor", () => {
  it("prefers the file name over the extension", () => {
    expect(iconIdFor(index, file("package.json"))).toBe("npm");
    expect(iconIdFor(index, file("other.json"))).toBe("json");
  });

  it("tries the longest extension first", () => {
    expect(iconIdFor(index, file("a.test.ts"))).toBe("test");
    expect(iconIdFor(index, file("a.ts"))).toBe("ts");
  });

  it("treats a dotfile's name as its extension", () => {
    expect(iconIdFor(index, file(".gitignore"))).toBe("git");
  });

  it("matches path tails", () => {
    expect(iconIdFor(index, file("tool.json", { path: "/home/me/.config/tool.json" }))).toBe("tool");
    expect(iconIdFor(index, file("tool.json", { path: "/home/me/other/tool.json" }))).toBe("json");
    expect(iconIdFor(index, dir("workflows", false, { path: "/repo/.github/workflows" }))).toBe("folder-gha");
  });

  it("is case-insensitive", () => {
    expect(iconIdFor(index, file("readme.md"))).toBe("readme");
    expect(iconIdFor(index, file("A.TS"))).toBe("ts");
    expect(iconIdFor(index, dir("SRC"))).toBe("folder-src");
  });

  it("uses open folder icons for expanded folders", () => {
    expect(iconIdFor(index, dir("src", true))).toBe("folder-src-open");
    expect(iconIdFor(index, dir("lib"))).toBe("folder");
    expect(iconIdFor(index, dir("lib", true))).toBe("folder-open");
  });

  it("falls back to language ids, then the default", () => {
    expect(iconIdFor(index, file("x.py"))).toBe("py");
    expect(iconIdFor(index, file("notes"))).toBe("file");
    expect(iconIdFor(index, file("notes"), true)).toBeUndefined();
  });

  it("tries light mappings first under a light theme", () => {
    expect(iconIdFor(index, file("a.ts", { light: true }))).toBe("ts-light");
    expect(iconIdFor(index, file("a.json", { light: true }))).toBe("json");
  });

  it("does not trip over names of Object.prototype members", () => {
    expect(iconIdFor(index, file("constructor"))).toBe("ctor");
    expect(iconIdFor(index, file("__proto__"))).toBe("file");
    expect(iconIdFor(index, file("hasOwnProperty"))).toBe("file");
  });
});

describe("extensionsOf", () => {
  it("lists extensions longest first", () => {
    expect(extensionsOf("a.d.ts")).toEqual(["d.ts", "ts"]);
    expect(extensionsOf(".eslintrc.json")).toEqual(["eslintrc.json", "json"]);
    expect(extensionsOf("Makefile")).toEqual([]);
    expect(extensionsOf("trailing.")).toEqual([]);
  });
});
