import { describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({ CLAUDE_KIND: "claude-code", request: async () => ({}), onSessionEvent: () => () => {}, onBridgeEvent: () => () => {} }));
vi.mock("../plugins/settings", () => ({ pluginSettings: () => ({}), usePluginSettings: () => ({}) }));

const { commandList, findModel, findPaneCommand, hasFullList, rememberCommands, statusText, transcriptMarkdown } = await import("./commands");
const { createSession } = await import("./reduce");

const cli = (name: string) => ({ name, description: name, argumentHint: "" });

describe("commandList", () => {
  it("puts the pane's commands first and drops the CLI's of the same name", () => {
    const init = { commands: [cli("doctor"), cli("model"), cli("context"), cli("codex:review")], models: [], agents: [] };
    const names = commandList({ init, cwd: "/a" }).map((command) => command.name);
    expect(names.slice(0, 3)).toEqual(["btw", "plan", "model"]);
    expect(names.filter((name) => name === "model")).toHaveLength(1);
    expect(names).toContain("doctor");
    expect(names).toContain("codex:review");
  });

  it("uses the folder's last list before the session reports its own", () => {
    expect(hasFullList({ init: undefined, cwd: "/b" })).toBe(false);
    expect(commandList({ init: undefined, cwd: "/b" }).map((c) => c.name)).toContain("compact");
    rememberCommands("/b", [cli("doctor"), cli("my-skill")]);
    expect(hasFullList({ init: undefined, cwd: "/b" })).toBe(true);
    expect(commandList({ init: undefined, cwd: "/b" }).map((c) => c.name)).toContain("my-skill");
    expect(commandList({ init: undefined, cwd: "/c" }).map((c) => c.name)).not.toContain("my-skill");
  });
});

describe("findPaneCommand", () => {
  it("matches names and aliases, with the rest as arguments", () => {
    expect(findPaneCommand("/btw what is this?")).toMatchObject({ command: { name: "btw" }, args: "what is this?" });
    expect(findPaneCommand("/cost")).toMatchObject({ command: { name: "usage" }, args: "" });
    expect(findPaneCommand("/plan add a\nsecond line")?.args).toBe("add a\nsecond line");
    expect(findPaneCommand("/doctor")).toBeUndefined();
    expect(findPaneCommand("not a command")).toBeUndefined();
  });
});

describe("findModel", () => {
  const models = [
    { value: "default", displayName: "Default", description: "" },
    { value: "opus", displayName: "Opus", description: "" },
    { value: "opus[1m]", displayName: "Opus (1M context)", description: "" },
    { value: "haiku", displayName: "Haiku", description: "" },
  ];
  it("takes a value, a name or a unique prefix", () => {
    expect(findModel(models, "opus")?.value).toBe("opus");
    expect(findModel(models, "Opus (1M context)")?.value).toBe("opus[1m]");
    expect(findModel(models, "hai")?.value).toBe("haiku");
    expect(findModel(models, "op")).toBeUndefined();
    expect(findModel(models, "")).toBeUndefined();
  });
});

describe("statusText and transcriptMarkdown", () => {
  const session = {
    ...createSession({ key: "k", paneId: "p", cwd: "/repo", sessionId: "s1" }),
    title: "Fix the bug",
    items: [
      { kind: "user" as const, id: "u", text: "Fix the bug" },
      { kind: "tool" as const, id: "t", toolUseId: "tu" },
      { kind: "assistant" as const, id: "a", text: "Fixed.", streaming: false },
    ],
    tools: { tu: { id: "tu", name: "Edit", input: { file_path: "/repo/a.ts" }, status: "done" as const, parentToolUseId: null, startedAt: 0 } },
  };
  it("lists what the session runs with", () => {
    expect(statusText(session)).toContain("Folder");
    expect(statusText(session)).toContain("/repo");
  });
  it("writes messages, answers and tool lines", () => {
    const md = transcriptMarkdown(session);
    expect(md).toContain("# Fix the bug");
    expect(md).toContain("## You\n\nFix the bug");
    expect(md).toContain("- Edit: `/repo/a.ts`");
    expect(md).toContain("## Claude\n\nFixed.");
  });
});
