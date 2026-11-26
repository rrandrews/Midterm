import { describe, expect, it } from "vitest";
import { type PaletteSources, paletteItems, parseQuery, relativeTo } from "./items";

const sources = (patch: Partial<PaletteSources> = {}): PaletteSources => ({
  commands: [
    { id: "pane.splitRight", title: "Split right", category: "Pane", shortcut: "⌘D" },
    { id: "pane.splitDown", title: "Split down", category: "Pane" },
    { id: "tab.new", title: "New tab", category: "Tab" },
  ],
  tabs: [{ id: "t1", title: "server", workspaceId: "w1", workspaceName: "work", active: true }],
  workspaces: [{ id: "w1", name: "work", tabCount: 1, active: true }],
  root: "/repo",
  files: ["src/App.tsx", "src/components/SplitNode.tsx", "README.md"],
  recentCommands: [],
  recentFiles: [],
  ...patch,
});

describe("parseQuery", () => {
  it("recognises prefixes", () => {
    expect(parseQuery("> split")).toEqual({ scope: "commands", text: "split" });
    expect(parseQuery("$ ls -la")).toEqual({ scope: "run", text: "ls -la" });
    expect(parseQuery(" app ")).toEqual({ scope: "all", text: "app" });
  });
});

describe("paletteItems", () => {
  it("lists recent commands and files first for an empty query", () => {
    const items = paletteItems("", "all", sources({ recentCommands: ["tab.new"], recentFiles: ["/repo/README.md"] }));
    expect(items.slice(0, 2).map((item) => [item.group, item.title])).toEqual([
      ["Recent", "New tab"],
      ["Recent", "README.md"],
    ]);
    // The recent command is not listed twice.
    expect(items.filter((item) => item.title === "New tab")).toHaveLength(1);
  });

  it("matches files by name and offers to run the text", () => {
    const items = paletteItems("splitnode", "all", sources());
    expect(items[0]).toMatchObject({ group: "Files", title: "SplitNode.tsx", detail: "src/components" });
    expect(items[0].action).toEqual({ kind: "file", path: "/repo/src/components/SplitNode.tsx" });
    expect(items[items.length - 1]?.action).toEqual({ kind: "run", command: "splitnode" });
  });

  it("restricts to commands with >", () => {
    const items = paletteItems(">split", "all", sources());
    expect(items.map((item) => item.title)).toEqual(expect.arrayContaining(["Split right", "Split down"]));
    expect(items.every((item) => item.group === "Commands")).toBe(true);
  });

  it("boosts recently used matches", () => {
    const items = paletteItems(">split", "all", sources({ recentCommands: ["pane.splitDown"] }));
    expect(items[0].title).toBe("Split down");
  });

  it("only runs with $", () => {
    expect(paletteItems("$ make", "all", sources()).map((item) => item.action)).toEqual([{ kind: "run", command: "make" }]);
    expect(paletteItems("$", "all", sources())).toEqual([]);
  });

  it("shows only files in files mode", () => {
    const items = paletteItems("app", "files", sources());
    expect(items.every((item) => item.group === "Files")).toBe(true);
    expect(paletteItems("", "files", sources({ recentFiles: ["/elsewhere/x.md"] })).map((item) => item.title)).toEqual(["x.md"]);
  });

  it("finds tabs and workspaces by name", () => {
    const items = paletteItems("serv", "all", sources());
    expect(items[0]).toMatchObject({ group: "Tabs", title: "server", action: { kind: "tab", tabId: "t1" } });
  });

  it("handles remote SSH project roots and remote recent files without leaking ssh://", () => {
    const remoteRoot = "ssh://prod-0123456789ab/home/deploy/api";
    const items = paletteItems(
      "server",
      "files",
      sources({
        root: remoteRoot,
        files: ["src/server.ts", "README.md"],
        recentFiles: ["ssh://staging-abcdef012345/etc/nginx/server.conf"],
      }),
    );
    const projRemote = items.find((i) => i.title === "server.ts");
    expect(projRemote).toMatchObject({
      title: "server.ts",
      detail: "src",
      action: { kind: "file", path: `${remoteRoot}/src/server.ts` },
    });
    const recentRemote = items.find((i) => i.title === "server.conf");
    expect(recentRemote).toMatchObject({
      title: "server.conf",
      detail: "staging:/etc/nginx",
      action: { kind: "file", path: "ssh://staging-abcdef012345/etc/nginx/server.conf" },
    });
  });
});

describe("relativeTo", () => {
  it("strips the root only from paths inside it on the same host", () => {
    expect(relativeTo("/repo", "/repo/a/b")).toBe("a/b");
    expect(relativeTo("/repo", "/repository/a")).toBe("/repository/a");
    expect(relativeTo(undefined, "/x")).toBe("/x");
    expect(relativeTo("ssh://prod-0123456789ab/repo", "ssh://prod-0123456789ab/repo/a/b")).toBe("a/b");
    expect(relativeTo("/repo", "ssh://prod-0123456789ab/repo/a/b")).toBe("ssh://prod-0123456789ab/repo/a/b");
  });
});
