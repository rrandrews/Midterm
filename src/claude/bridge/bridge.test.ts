import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeLine } from "../protocol";

type FakeQuery = ReturnType<typeof makeQuery>;
const queries: FakeQuery[] = [];
const queryCalls: Array<{ prompt: AsyncIterable<unknown>; options: any }> = [];

function makeQuery(prompt: AsyncIterable<unknown>) {
  const messages: any[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let failure: Error | null = null;
  const q = {
    prompt,
    push: (m: any) => {
      messages.push(m);
      wake?.();
    },
    end: (e?: Error) => {
      ended = true;
      failure = e ?? null;
      wake?.();
    },
    close: vi.fn(() => q.end()),
    interrupt: vi.fn(async () => undefined),
    initializationResult: vi.fn(async () => ({
      commands: [{ name: "init" }],
      models: [{ value: "m" }],
      agents: [],
      account: { email: "a@b" },
      output_style: "default",
      available_output_styles: ["default"],
      current_permission_mode: "default",
      claude_code_version: "9.9.9",
      fast_mode_state: "off",
    })),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    applyFlagSettings: vi.fn(async () => undefined),
    getContextUsage: vi.fn(async () => ({ totalTokens: 1 })),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => ({ cost: 1 })),
    mcpServerStatus: vi.fn(async () => []),
    toggleMcpServer: vi.fn(async () => undefined),
    reconnectMcpServer: vi.fn(async () => undefined),
    reloadPlugins: vi.fn(async () => ({})),
    supportedCommands: vi.fn(async () => [1]),
    supportedModels: vi.fn(async () => [2]),
    supportedAgents: vi.fn(async () => [3]),
    stopTask: vi.fn(async () => undefined),
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (messages.length) yield messages.shift();
        if (ended) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
  return q;
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: any) => {
    const q = makeQuery(prompt);
    queries.push(q);
    queryCalls.push({ prompt, options });
    return q;
  },
  listSessions: vi.fn(async (o: any) => [{ sessionId: "s1", dir: o.dir }]),
  getSessionMessages: vi.fn(async (id: string, o: any) => [{ id, dir: o.dir }]),
}));

const { createBridge } = await import("./bridge");

let out: any[];
function setup(claudePath: string | null = "/bin/claude") {
  out = [];
  const bridge = createBridge({ write: (l: BridgeLine) => out.push(l), sdkVersion: "1.2.3", claudePath: claudePath ?? undefined, env: () => ({ X: "y" }) });
  let n = 0;
  const call = async (method: string, params: object = {}) => {
    const id = ++n;
    await bridge.handleLine(JSON.stringify({ id, method, params }));
    return out.find((l) => "id" in l && l.id === id) as any;
  };
  return { bridge, call };
}
const events = (name: string) => out.filter((l) => "event" in l && l.event === name);
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  queries.length = 0;
  queryCalls.length = 0;
});

describe("dispatch", () => {
  it("answers hello", async () => {
    const { call } = setup();
    const r = await call("hello");
    expect(r.result).toMatchObject({ protocol: 1, sdkVersion: "1.2.3", claudePath: "/bin/claude" });
    expect(r.result.nodeVersion).toBe(process.version);
  });

  it("rejects unknown methods, survives garbage", async () => {
    const { bridge, call } = setup();
    expect((await call("nope")).error).toEqual({ message: "Unknown method: nope", code: "invalid" });
    expect((await call("toString")).error.code).toBe("invalid");
    await bridge.handleLine("{not json");
    await bridge.handleLine("");
    await bridge.handleLine('{"method":"hello"}');
    expect(out).toHaveLength(2);
  });

  it("requires a claude path to start", async () => {
    const { call } = setup(null);
    expect((await call("session.start", { session: "a", cwd: "/w" })).error.code).toBe("notFound");
  });

  it("reports closed for unknown sessions", async () => {
    const { call } = setup();
    expect((await call("session.send", { session: "x", text: "hi", uuid: "u" })).error.code).toBe("closed");
    expect((await call("session.contextUsage", { session: "x" })).error.code).toBe("closed");
    expect((await call("session.close", { session: "x" })).result).toEqual({});
  });
});

describe("sessions", () => {
  it("starts with the real-config options and returns SessionInit", async () => {
    const { call } = setup();
    const r = await call("session.start", { session: "a", cwd: "/w", resume: "sid", model: "haiku", effort: "low", permissionMode: "plan" });
    expect(r.result).toMatchObject({
      sessionId: "sid",
      claudeCodeVersion: "9.9.9",
      outputStyle: "default",
      permissionMode: "default",
      fastModeState: "off",
      commands: [{ name: "init" }],
    });
    const o = queryCalls[0].options;
    expect(o).toMatchObject({
      cwd: "/w",
      resume: "sid",
      model: "haiku",
      effort: "low",
      permissionMode: "plan",
      pathToClaudeCodeExecutable: "/bin/claude",
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      env: { X: "y" },
      systemPrompt: { type: "preset", preset: "claude_code" },
    });
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
    expect(typeof o.canUseTool).toBe("function");
  });

  it("queues user messages, with images before text", async () => {
    const { call } = setup();
    await call("session.start", { session: "a", cwd: "/w" });
    const it = queryCalls[0].prompt[Symbol.asyncIterator]();
    await call("session.send", { session: "a", text: "hello", uuid: "u1" });
    await call("session.send", { session: "a", text: "see", uuid: "u2", images: [{ mediaType: "image/png", data: "AAA" }] });
    expect((await it.next()).value).toMatchObject({ type: "user", uuid: "u1", message: { role: "user", content: "hello" }, parent_tool_use_id: null });
    expect((await it.next()).value.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      { type: "text", text: "see" },
    ]);
  });

  it("forwards messages and emits sessionEnded with an error when the stream throws", async () => {
    const { call } = setup();
    await call("session.start", { session: "a", cwd: "/w" });
    queries[0].push({ type: "assistant" });
    await tick();
    expect(events("message")).toEqual([{ event: "message", session: "a", message: { type: "assistant" } }]);
    queries[0].end(new Error("boom"));
    await tick();
    expect(events("sessionEnded")).toEqual([{ event: "sessionEnded", session: "a", error: "boom" }]);
    expect((await call("session.interrupt", { session: "a" })).error.code).toBe("closed");
  });

  it("ends without error on a clean stream end or on purpose", async () => {
    const { call } = setup();
    await call("session.start", { session: "a", cwd: "/w" });
    queries[0].end();
    await tick();
    expect(events("sessionEnded")).toEqual([{ event: "sessionEnded", session: "a" }]);
    await call("session.start", { session: "b", cwd: "/w" });
    await call("session.close", { session: "b" });
    await tick();
    expect(queries[1].close).toHaveBeenCalled();
    expect(events("sessionEnded")).toEqual([
      { event: "sessionEnded", session: "a" },
      { event: "sessionEnded", session: "b" },
    ]);
  });

  it("restarting a key closes the old one without announcing it", async () => {
    const { call } = setup();
    await call("session.start", { session: "a", cwd: "/w" });
    await call("session.start", { session: "a", cwd: "/w" });
    await tick();
    expect(queries[0].close).toHaveBeenCalled();
    expect(events("sessionEnded")).toEqual([]);
  });

  it("maps control methods onto the Query", async () => {
    const { call } = setup();
    await call("session.start", { session: "a", cwd: "/w" });
    const q = queries[0];
    await call("session.setPermissionMode", { session: "a", mode: "acceptEdits" });
    expect(q.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    await call("session.setModel", { session: "a" });
    expect(q.setModel).toHaveBeenCalledWith(undefined);
    await call("session.setEffort", { session: "a", effort: null });
    expect(q.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: null });
    expect((await call("session.contextUsage", { session: "a", detail: "summary" })).result).toEqual({ totalTokens: 1 });
    expect(q.getContextUsage).toHaveBeenCalledWith({ detail: "summary" });
    expect((await call("session.usage", { session: "a" })).result).toEqual({ cost: 1 });
    await call("session.mcpToggle", { session: "a", server: "s", enabled: false });
    expect(q.toggleMcpServer).toHaveBeenCalledWith("s", false);
    await call("session.mcpReconnect", { session: "a", server: "s" });
    expect(q.reconnectMcpServer).toHaveBeenCalledWith("s");
    await call("session.stopTask", { session: "a", taskId: "t" });
    expect(q.stopTask).toHaveBeenCalledWith("t");
    await call("session.interrupt", { session: "a" });
    expect(q.interrupt).toHaveBeenCalled();
    expect((await call("session.capabilities", { session: "a" })).result).toEqual({ commands: [1], models: [2], agents: [3] });
    expect((await call("session.mcpStatus", { session: "a" })).result).toEqual([]);
    expect((await call("session.reloadPlugins", { session: "a" })).result).toEqual({});
  });

  it("lists past sessions and messages by folder", async () => {
    const { call } = setup();
    expect((await call("sessions.list", { cwd: "/w" })).result).toEqual([{ sessionId: "s1", dir: "/w" }]);
    expect((await call("sessions.messages", { cwd: "/w", sessionId: "s1" })).result).toEqual([{ id: "s1", dir: "/w" }]);
  });
});

describe("options and stale sessions", () => {
  it("allows bypass only when asked", async () => {
    const { call } = setup();
    await call("session.start", { session: "a", cwd: "/w", allowBypass: true });
    expect(queryCalls[0].options.allowDangerouslySkipPermissions).toBe(true);
  });

  it("stays silent after a session was replaced or closed", async () => {
    const { call } = setup();
    await call("session.start", { session: "a", cwd: "/w" });
    await call("session.start", { session: "a", cwd: "/w" });
    queries[0].push({ type: "assistant", old: true });
    queryCalls[0].options.stderr("late");
    queryCalls[0].options.canUseTool("Bash", {}, { signal: new AbortController().signal, requestId: "z", toolUseID: "t" });
    await tick();
    expect(events("message")).toEqual([]);
    expect(events("stderr")).toEqual([]);
    expect(events("permission")).toEqual([]);
  });

  it("returns the agents of the last reloadPlugins", async () => {
    const { call } = setup();
    await call("session.start", { session: "a", cwd: "/w" });
    queries[0].reloadPlugins.mockResolvedValueOnce({ agents: [{ name: "new" }] } as any);
    await call("session.reloadPlugins", { session: "a" });
    expect((await call("session.capabilities", { session: "a" })).result.agents).toEqual([{ name: "new" }]);
  });
});

describe("permissions", () => {
  const ask = (session = 0, id = "r1", signal = new AbortController().signal) =>
    queryCalls[session].options.canUseTool("Bash", { command: "echo hi" }, { signal, requestId: id, toolUseID: "tu", agentID: "ag", title: "T", suggestions: [], defaultToNo: true, suppressAlwaysAllowRule: true });

  it("round-trips a prompt", async () => {
    const { call } = setup();
    await call("session.start", { session: "a", cwd: "/w" });
    const p = ask();
    expect(events("permission")[0]).toMatchObject({
      session: "a",
      request: { requestId: "r1", toolName: "Bash", input: { command: "echo hi" }, toolUseId: "tu", agentId: "ag", title: "T", defaultToNo: true, suppressAlwaysAllowRule: true },
    });
    const result = { behavior: "allow", updatedInput: { command: "echo yo" } };
    await call("session.permission", { session: "a", requestId: "r1", result });
    expect(await p).toEqual(result);
  });

  it("denies and announces when the CLI aborts", async () => {
    const { call } = setup();
    await call("session.start", { session: "a", cwd: "/w" });
    const ac = new AbortController();
    const p = ask(0, "r2", ac.signal);
    ac.abort();
    expect(await p).toMatchObject({ behavior: "deny" });
    expect(events("permissionCancelled")).toEqual([{ event: "permissionCancelled", session: "a", requestId: "r2" }]);
    // a late answer is harmless
    expect((await call("session.permission", { session: "a", requestId: "r2", result: { behavior: "allow" } })).result).toEqual({});
  });

  it("denies pending prompts when the session closes", async () => {
    const { call } = setup();
    await call("session.start", { session: "a", cwd: "/w" });
    const p = ask();
    await call("session.close", { session: "a" });
    expect(await p).toMatchObject({ behavior: "deny" });
  });
});

describe("shutdown", () => {
  it("closes every session", async () => {
    const { bridge, call } = setup();
    await call("session.start", { session: "a", cwd: "/w" });
    await call("session.start", { session: "b", cwd: "/w" });
    bridge.shutdown();
    expect(queries[0].close).toHaveBeenCalled();
    expect(queries[1].close).toHaveBeenCalled();
  });
});
