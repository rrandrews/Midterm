import { describe, expect, it } from "vitest";
import { headingSlug, normalizePath, resolveImage, resolveLink } from "./links";

const dir = "/repo/docs";

describe("resolveLink", () => {
  it("opens http(s) externally and refuses other schemes", () => {
    expect(resolveLink("https://tauri.app", dir)).toEqual({ type: "external", url: "https://tauri.app/" });
    expect(resolveLink("javascript:alert(1)", dir)).toBeNull();
    expect(resolveLink("mailto:a@b.c", dir)).toBeNull();
    expect(resolveLink("", dir)).toBeNull();
  });

  it("resolves files against the document's directory", () => {
    expect(resolveLink("../src/a.ts", dir)).toEqual({ type: "file", path: "/repo/src/a.ts" });
    expect(resolveLink("./b%20c.md?x=1", dir)).toEqual({ type: "file", path: "/repo/docs/b c.md" });
    expect(resolveLink("/etc/hosts", dir)).toEqual({ type: "file", path: "/etc/hosts" });
    expect(resolveLink("file:///tmp/x.txt", dir)).toEqual({ type: "file", path: "/tmp/x.txt" });
    expect(resolveLink("main.rs#L42", dir)).toEqual({ type: "file", path: "/repo/docs/main.rs", line: 42 });
  });

  it("treats fragments as headings", () => {
    expect(resolveLink("#pane-types", dir)).toEqual({ type: "anchor", id: "pane-types" });
    expect(resolveLink("?q#top", dir)).toEqual({ type: "anchor", id: "top" });
  });
});

describe("resolveImage", () => {
  it("loads local files only", () => {
    expect(resolveImage("logo.svg", dir)).toEqual({ type: "file", path: "/repo/docs/logo.svg" });
    expect(resolveImage("../img/a.png#x", dir)).toEqual({ type: "file", path: "/repo/img/a.png" });
    expect(resolveImage("data:image/png;base64,AAA", dir)).toEqual({ type: "inline" });
    expect(resolveImage("https://example.com/a.png", dir)).toBeNull();
    expect(resolveImage("data:text/html,x", dir)).toBeNull();
  });
});

describe("normalizePath / headingSlug", () => {
  it("normalizes", () => {
    expect(normalizePath("/a/./b/../c//d")).toBe("/a/c/d");
    expect(normalizePath("/../..")).toBe("/");
  });

  it("slugs headings like GitHub", () => {
    expect(headingSlug("Pane types")).toBe("pane-types");
    expect(headingSlug("What's new in v2.0?")).toBe("whats-new-in-v20");
  });
});
