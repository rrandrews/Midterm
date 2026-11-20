import { describe, expect, it } from "vitest";
import type { Block, BlocksSnapshot } from "../terminal/blocks";
import { EXPLAIN_SYSTEM_PROMPT, FIX_SYSTEM_PROMPT, buildExplainRequest, buildFixRequest } from "./blockAi";
import { contextBody } from "./context";
import { type ContextSource, contextInputOf } from "./engine";

let nextId = 1;
function block(command: string, extra: Partial<Block> = {}): Block {
  return {
    id: nextId++,
    command,
    cwd: "/Users/me/proj",
    host: undefined,
    nested: false,
    branch: "main",
    end: {} as Block["end"],
    exitCode: 0,
    ...extra,
  } as Block;
}

function source(blocks: Block[], commands: Record<string, string[]>, extra: Partial<BlocksSnapshot> = {}): ContextSource {
  const snapshot = { integration: "present", phase: "prompt", altScreen: false, blocks, nested: false, location: {}, ...extra } as BlocksSnapshot;
  return {
    snapshot,
    cwd: "/Users/me/elsewhere",
    scope: snapshot.nested ? (snapshot.location.host ?? "nested") : "",
    commandsFor: (scope) => commands[scope] ?? [],
    shell: "zsh",
    output: (b) => `output of ${b.command}`,
    os: "macOS",
    homeRelative: (path) => path?.replace("/Users/me", "~"),
  };
}

describe("buildExplainRequest", () => {
  it("adds the block after the body, with more output, and asks to explain", () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const request = buildExplainRequest("OS: macOS", { command: "make", exitCode: 2, output, cwd: "~/proj" });
    expect(request.system).toBe(EXPLAIN_SYSTEM_PROMPT);
    expect(request.prompt).toMatch(/^OS: macOS\n\nThe command in question:\n\n\$ make\n\(in ~\/proj\)\nline 0\n/);
    expect(request.prompt).toContain("line 39\n… (80 lines omitted)\nline 120");
    expect(request.prompt).toMatch(/line 199\n\[exit 2\]\n\nExplain:$/);
  });

  it("redacts the block in question", () => {
    const request = buildExplainRequest("", {
      command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x",
      exitCode: 1,
      output: "export API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz",
    });
    expect(request.prompt).not.toContain("abcdefghijklmnop");
    expect(request.prompt).not.toContain("sk-ant-");
  });
});

describe("buildFixRequest", () => {
  it("ends in the corrected command question", () => {
    const request = buildFixRequest("Shell: zsh", { command: "gti status", exitCode: 127, output: "zsh: command not found: gti" });
    expect(request.system).toBe(FIX_SYSTEM_PROMPT);
    expect(request.prompt).toContain("$ gti status\nzsh: command not found: gti\n[exit 127]");
    expect(request.prompt.endsWith("\n\nCorrected command:")).toBe(true);
  });
});

describe("contextInputOf a block", () => {
  it("gives an old block only the context before it", () => {
    const first = block("ls");
    const target = block("make", { exitCode: 2 });
    const later = block("git status");
    const input = contextInputOf(source([first, target, later], { "": ["cd proj", "ls", "make", "git status"] }), {
      limit: 5,
      block: target,
      branch: "main",
    });
    expect(input.blocks.map((b) => b.command)).toEqual(["ls"]);
    expect(input.recentCommands).toEqual(["cd proj", "ls"]);
    expect(input.cwd).toBe("~/proj");
    expect(input.branch).toBe("main");
    expect(input.beforeBlock).toBe(true);
    const body = contextBody(input);
    expect(body).not.toContain("git status");
    expect(body).not.toContain("$ make");
  });

  it("gives a remote block the remote host's facts, not this machine's", () => {
    const local = block("ls");
    const remote = block("cat /etc/nope", { nested: true, host: "box", cwd: "/srv", exitCode: 1 });
    const input = contextInputOf(source([local, block("ssh box", { exitCode: undefined }), remote], { box: ["cd /srv"] }), {
      limit: 5,
      block: remote,
      branch: "main",
    });
    expect(input.host).toBe("box");
    expect(input.os).toBeUndefined();
    expect(input.shell).toBeUndefined();
    expect(input.branch).toBeNull();
    expect(input.cwd).toBe("/srv");
    // Only the remote shell's blocks before it.
    expect(input.blocks).toEqual([]);
    expect(input.recentCommands).toEqual(["cd /srv"]);
    expect(contextBody(input)).toContain("Remote host (over ssh): box");
  });

  it("without a block is the prompt's context", () => {
    const blocks = [block("ls"), block("pwd")];
    const input = contextInputOf(source(blocks, { "": ["ls", "pwd"] }), { limit: 1, branch: "dev" });
    expect(input.blocks.map((b) => b.command)).toEqual(["pwd"]);
    expect(input.cwd).toBe("~/elsewhere");
    expect(input.os).toBe("macOS");
    expect(input.beforeBlock).toBeUndefined();
  });
});
