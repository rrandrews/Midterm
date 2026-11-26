import { describe, expect, it } from "vitest";
import { breadcrumbSegments, clampPosition, decodeText, detectIndent, encodeText, minimalChange } from "./text";

describe("decodeText / encodeText", () => {
  it("round-trips LF, CRLF and a BOM", () => {
    for (const raw of ["a\nb\n", "a\r\nb\r\n", "﻿a\r\nb", "", "one line"]) {
      const { text, format } = decodeText(raw);
      const doc = text.replace(/\r\n/g, "\n"); // what CodeMirror keeps
      expect(encodeText(doc, format)).toBe(raw);
    }
  });

  it("takes the line ending from the first line break", () => {
    expect(decodeText("a\r\nb\nc").format.lineEnding).toBe("\r\n");
    expect(decodeText("a\nb\r\nc").format.lineEnding).toBe("\n");
    expect(decodeText("﻿x").format).toEqual({ bom: true, lineEnding: "\n" });
  });
});

describe("minimalChange", () => {
  const apply = (text: string, change: ReturnType<typeof minimalChange>) =>
    change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text;

  it("replaces only what differs", () => {
    expect(minimalChange("hello world", "hello there world")).toEqual({ from: 6, to: 6, insert: "there " });
    expect(minimalChange("abc", "abc")).toBeNull();
    expect(minimalChange("abc", "")).toEqual({ from: 0, to: 3, insert: "" });
    expect(minimalChange("aaa", "aaaa")).toEqual({ from: 3, to: 3, insert: "a" });
  });

  it("produces the new text in every case", () => {
    const cases: [string, string][] = [
      ["", "x"],
      ["abcabc", "abc"],
      ["line1\nline2\n", "line1\nchanged\nline2\n"],
      ["😀a", "😃a"],
      ["a😀", "a😃"],
    ];
    for (const [from, to] of cases) expect(apply(from, minimalChange(from, to))).toBe(to);
  });

  it("does not split surrogate pairs", () => {
    // 😀 and 😃 share their high surrogate.
    expect(minimalChange("😀", "😃")).toEqual({ from: 0, to: 2, insert: "😃" });
  });
});

describe("detectIndent", () => {
  it("recognises tabs and space widths", () => {
    expect(detectIndent("a\n\tb\n\tc\n\t\td\n")).toBe("\t");
    expect(detectIndent("a\n    b\n    c\n        d\n")).toBe("    ");
    expect(detectIndent("a\n  b\n  c\n    d\n")).toBe("  ");
  });

  it("ignores block comment stars and gives up on too little", () => {
    expect(detectIndent("/**\n * x\n * y\n */\n")).toBeNull();
    expect(detectIndent("a\n  b\n")).toBeNull();
  });
});

describe("breadcrumbSegments", () => {
  it("is relative to the repository, then home, then root", () => {
    const home = "/Users/dev";
    const repoRoot = "/Users/dev/proj";
    expect(breadcrumbSegments("/Users/dev/proj/src/a.ts", { repoRoot, home })).toEqual(["src", "a.ts"]);
    expect(breadcrumbSegments("/Users/dev/notes.md", { repoRoot: null, home })).toEqual(["~", "notes.md"]);
    expect(breadcrumbSegments("/etc/hosts", { home })).toEqual(["etc", "hosts"]);
  });

  it("handles remote ssh:// files without showing the ssh:// authority", () => {
    const rHome = "ssh://prod-0123456789ab/home/deploy";
    const rRepo = "ssh://prod-0123456789ab/home/deploy/api";
    expect(breadcrumbSegments("ssh://prod-0123456789ab/home/deploy/api/src/main.rs", { repoRoot: rRepo, home: rHome })).toEqual([
      "src",
      "main.rs",
    ]);
    expect(breadcrumbSegments("ssh://prod-0123456789ab/home/deploy/notes.md", { repoRoot: null, home: rHome })).toEqual([
      "~",
      "notes.md",
    ]);
    expect(breadcrumbSegments("ssh://prod-0123456789ab/etc/nginx/nginx.conf", { repoRoot: null, home: rHome })).toEqual([
      "etc",
      "nginx",
      "nginx.conf",
    ]);
    // Local home must never abbreviate a remote file path.
    expect(
      breadcrumbSegments("ssh://prod-0123456789ab/Users/dev/notes.md", { repoRoot: null, home: "/Users/dev" }),
    ).toEqual(["Users", "dev", "notes.md"]);
  });
});

describe("clampPosition", () => {
  const lengths = [3, 0, 10];
  const lineLength = (line: number) => lengths[line - 1];
  it("clamps line and column to the document", () => {
    expect(clampPosition(3, lineLength, 2, 5)).toEqual({ line: 2, column: 1 });
    expect(clampPosition(3, lineLength, 99)).toEqual({ line: 3, column: 1 });
    expect(clampPosition(3, lineLength, 0, 0)).toEqual({ line: 1, column: 1 });
    expect(clampPosition(3, lineLength, 1, 99)).toEqual({ line: 1, column: 4 });
  });
});
