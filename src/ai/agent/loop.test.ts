import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentTurn, AgentTurnRequest } from "../../ipc/ai";
import type { RegisteredSkill, ToolResult, WriteConfirmation } from "../../plugins/skills";
import type { SkillTool } from "../../plugins/types";
import {
  type ConfirmAnswer,
  type Conversation,
  type ConversationHandle,
  type LoopDeps,
  MAX_ROUNDS,
  RESULT_LIMIT,
  clipMiddle,
  newConversation,
  resultContent,
  runTurn,
} from "./loop";
import { buildToolset } from "./tools";

const tool = (name: string, effect: SkillTool["effect"] = "read"): SkillTool => ({
  name,
  description: name,
  effect,
  inputSchema: { type: "object" },
  run: async () => null,
});

const skills: RegisteredSkill[] = [
  {
    id: "terminal.commands",
    pluginId: "terminal",
    enabled: true,
    skill: { id: "commands", title: "Terminal commands", description: "Commands.", instructions: "Load me.", tools: [tool("recent_blocks"), tool("run_command", "write")] },
  },
];
const READ = "terminal__commands__recent_blocks";
const WRITE = "terminal__commands__run_command";

type Step = AgentTurn | Error | ((request: AgentTurnRequest, onEvent: (event: AgentEvent) => void) => Promise<AgentTurn>);

const last = <T,>(list: readonly T[]): T | undefined => list[list.length - 1];
const turn = (fields: Partial<AgentTurn>): AgentTurn => ({ text: "", toolCalls: [], raw: `{"n":${Math.random()}}`, stop: "end", effortDropped: false, ...fields });
const call = (name: string, input: unknown = {}, id = `id-${name}-${Math.random()}`) => ({ id, name, input });

function setup(steps: Step[], options: { invoke?: LoopDeps["invoke"]; ask?: (signal: AbortSignal) => Promise<ConfirmAnswer> } = {}) {
  let conversation: Conversation = newConversation("c1", { provider: { id: "openai" }, model: "m" }, buildToolset(skills), "pane-1");
  const h: ConversationHandle = { get: () => conversation, update: (change) => (conversation = change(conversation)) };
  const requests: AgentTurnRequest[] = [];
  const cancelled: string[] = [];
  const invoked: { skillId: string; tool: string; input: unknown; paneId?: string }[] = [];
  let n = 0;
  const deps: LoopDeps = {
    turn: async (request, onEvent) => {
      requests.push(structuredClone({ ...request }));
      const step = steps.shift();
      if (!step) throw new Error("no more steps");
      if (step instanceof Error) throw step;
      if (typeof step === "function") return step(request, onEvent);
      if (step.text) onEvent({ type: "text", text: step.text });
      return step;
    },
    cancel: (id) => cancelled.push(id),
    invoke:
      options.invoke ??
      (async (skillId, toolName, input, { paneId, confirm }) => {
        invoked.push({ skillId, tool: toolName, input, paneId });
        if (toolName === "run_command") {
          const ok = await confirm!({ skill: skills[0], tool: tool(toolName, "write"), input });
          if (!ok) return { ok: false, error: "The user did not allow this action" };
        }
        return { ok: true, result: { ran: toolName } };
      }),
    ask: async (_call, signal) => (options.ask ? options.ask(signal) : "allow"),
    contextLine: async () => "[Context — OS: macOS; token=sk-ant-0123456789abcdefghij]",
    newRequestId: () => `r${++n}`,
  };
  const controller = new AbortController();
  return { h, deps, requests, cancelled, invoked, controller, run: (text: string | null) => runTurn(h, text, deps, controller.signal) };
}

describe("runTurn", () => {
  it("answers in one round, with a redacted context line on the first message only", async () => {
    const t = setup([turn({ text: "Hello" }), turn({ text: "Again" })]);
    await t.run("hi");
    const c = t.h.get();
    expect(c.status).toBe("idle");
    const first = (c.messages[0] as { text: string }).text;
    expect(first.startsWith("[Context — OS: macOS; token=[redacted]")).toBe(true);
    expect(first.endsWith("\n\nhi")).toBe(true);
    expect(first).not.toContain("sk-ant");
    expect(c.messages[1]).toEqual({ role: "assistant", raw: expect.any(String) });
    expect(c.items.map((item) => item.type)).toEqual(["user", "assistant"]);
    await t.run("more");
    expect(t.h.get().messages[2]).toEqual({ role: "user", text: "more" });
    expect(t.requests[1].messages).toHaveLength(3);
    expect(t.requests[0].maxTokens).toBe(4096);
    expect(t.requests[0].tools).toEqual(c.toolset.tools);
  });

  it("runs several rounds of tools in order and replays raw turns verbatim", async () => {
    const first = turn({ toolCalls: [call("load_skill", { skill: "terminal.commands" }, "a"), call(READ, { count: 2 }, "b")], stop: "tools", raw: '{"x": 1 }' });
    const t = setup([first, turn({ text: "Done" })]);
    await t.run("look");
    const c = t.h.get();
    expect(t.requests[1].messages[1]).toEqual({ role: "assistant", raw: '{"x": 1 }' });
    const results = (c.messages[2] as { results: { id: string; content: string }[] }).results;
    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(JSON.parse(results[0].content)).toMatchObject({ skill: "terminal.commands", instructions: "Load me.", tools: [READ, WRITE] });
    expect(JSON.parse(results[1].content)).toEqual({ ran: "recent_blocks" });
    expect(t.invoked).toEqual([{ skillId: "terminal.commands", tool: "recent_blocks", input: { count: 2 }, paneId: "pane-1" }]);
    expect(c.items.map((item) => item.type)).toEqual(["user", "skill", "tool", "assistant"]);
  });

  it("asks before write tools: allow, allow for the conversation, deny", async () => {
    const answers: ConfirmAnswer[] = ["always", "deny"];
    const t = setup(
      [
        turn({ toolCalls: [call(WRITE, { command: "ls" })], stop: "tools" }),
        turn({ toolCalls: [call(WRITE, { command: "pwd" })], stop: "tools" }),
        turn({ text: "ok" }),
      ],
      { ask: async () => answers.shift()! },
    );
    await t.run("go");
    // The second call was allowed by "always" without asking.
    expect(answers).toEqual(["deny"]);
    expect(t.h.get().allowed).toEqual([WRITE]);
    const tools = t.h.get().items.filter((item) => item.type === "tool");
    expect(tools.map((item) => item.status)).toEqual(["done", "done"]);

    const d = setup([turn({ toolCalls: [call(WRITE, { command: "rm" }, "w")], stop: "tools" }), turn({ text: "Understood" })], { ask: async () => "deny" });
    await d.run("delete");
    const row = d.h.get().items.find((item) => item.type === "tool");
    expect(row).toMatchObject({ status: "denied" });
    const result = (d.h.get().messages[2] as { results: { content: string; isError?: boolean }[] }).results[0];
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({ error: "The user denied this action." });
  });

  it("flags invalid input and unknown tools as error results", async () => {
    const t = setup([
      turn({ toolCalls: [{ id: "i", name: READ, input: null, invalid: "{oops" }, call("nope__x__y", {}, "u")], stop: "tools" }),
      turn({ text: "sorry" }),
    ]);
    await t.run("x");
    const results = (t.h.get().messages[2] as { results: { content: string; isError?: boolean }[] }).results;
    expect(JSON.parse(results[0].content)).toMatchObject({ INVALID_JSON: expect.any(String), arguments: "{oops" });
    expect(results[1].isError).toBe(true);
    expect(t.invoked).toEqual([]);
  });

  it("cancels during a turn without appending it", async () => {
    let t!: ReturnType<typeof setup>;
    t = setup([
      (_request, onEvent) =>
        new Promise((_resolve, reject) => {
          onEvent({ type: "text", text: "Partial" });
          t.controller.signal.addEventListener("abort", () => reject({ kind: "cancelled", message: "Cancelled" }));
          setTimeout(() => t.controller.abort(), 5);
        }),
    ]);
    await t.run("long");
    const c = t.h.get();
    expect(t.cancelled).toEqual(["r1"]);
    expect(c.messages).toHaveLength(1);
    expect(c.items.find((item) => item.type === "assistant")).toMatchObject({ text: "Partial", stopped: true, streaming: false });
    expect(last(c.items)?.type).toBe("assistant");
    expect(c.status).toBe("idle");
  });

  it("cancels during tools: every call still gets a result", async () => {
    let t!: ReturnType<typeof setup>;
    const invoke: LoopDeps["invoke"] = async () => {
      t.controller.abort();
      return new Promise<ToolResult>(() => {});
    };
    t = setup([turn({ toolCalls: [call(READ, {}, "a"), call(READ, {}, "b")], stop: "tools" })], { invoke });
    await t.run("x");
    const c = t.h.get();
    const results = (c.messages[2] as { results: { id: string; content: string }[] }).results;
    expect(results.map((r) => [r.id, JSON.parse(r.content).error])).toEqual([
      ["a", "Cancelled by the user"],
      ["b", "Cancelled by the user"],
    ]);
    expect(c.items.filter((item) => item.type === "tool").map((item) => item.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("declines a pending confirmation on Stop", async () => {
    let t!: ReturnType<typeof setup>;
    t = setup([turn({ toolCalls: [call(WRITE, { command: "ls" }, "w")], stop: "tools" })], {
      ask: (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve("deny"));
          setTimeout(() => t.controller.abort(), 5);
        }),
    });
    await t.run("x");
    const results = (t.h.get().messages[2] as { results: { content: string }[] }).results;
    expect(JSON.parse(results[0].content).error).toBe("Cancelled by the user");
    expect(t.h.get().messages).toHaveLength(3);
  });

  it("does not run calls of a reply cut off at the token limit", async () => {
    const t = setup([turn({ text: "I will", toolCalls: [call(READ, {}, "a")], stop: "length" })]);
    await t.run("x");
    const c = t.h.get();
    const results = (c.messages[2] as { results: { content: string; isError?: boolean }[] }).results;
    expect(JSON.parse(results[0].content).error).toBe("Not run: the reply was cut off");
    expect(t.invoked).toEqual([]);
    expect(last(c.items)?.type).toBe("error");
    expect(c.resume).toBe("retry");
  });

  it("stops after the round cap and continues from the history", async () => {
    const steps: Step[] = Array.from({ length: MAX_ROUNDS }, () => turn({ toolCalls: [call(READ)], stop: "tools" }));
    const t = setup([...steps, turn({ text: "finally" })]);
    await t.run("loop");
    expect(t.requests).toHaveLength(MAX_ROUNDS);
    expect(t.h.get().resume).toBe("continue");
    expect(last(t.h.get().items)).toMatchObject({ type: "note", text: `Stopped after ${MAX_ROUNDS} steps.` });
    await t.run(null);
    expect(last(t.h.get().items)).toMatchObject({ type: "assistant", text: "finally" });
    expect(t.h.get().resume).toBeUndefined();
  });

  it("leaves the history unchanged when a turn fails, and retries", async () => {
    const t = setup([new Error("boom"), turn({ text: "fine" })]);
    await t.run("x");
    let c = t.h.get();
    expect(c.messages).toHaveLength(1);
    expect(last(c.items)).toMatchObject({ type: "error", message: "boom" });
    expect(c.resume).toBe("retry");
    await t.run(null);
    c = t.h.get();
    expect(c.messages).toHaveLength(2);
    expect(t.requests[1].messages).toEqual(t.requests[0].messages);
  });

  it("redacts and clips tool results", async () => {
    const big = `token=sk-ant-0123456789abcdefghijkl ${"y".repeat(RESULT_LIMIT * 2)}`;
    const invoke: LoopDeps["invoke"] = async () => ({ ok: true, result: { output: big } });
    const t = setup([turn({ toolCalls: [call(READ, {}, "a")], stop: "tools" }), turn({ text: "ok" })], { invoke });
    await t.run("x");
    const content = (t.h.get().messages[2] as { results: { content: string }[] }).results[0].content;
    expect(content.length).toBeLessThanOrEqual(RESULT_LIMIT);
    expect(content).not.toContain("sk-ant-0123");
    expect(content).toContain("characters left out");
    expect(clipMiddle("short")).toBe("short");
  });

  it("redacts quoted credentials in tool output before JSON escapes them", () => {
    const file = 'config:\nAPI_KEY="hunter2-very-secret"\nexport GITHUB_TOKEN="abc123def456"\n';
    const content = resultContent({ content: file });
    expect(content).not.toContain("hunter2-very-secret");
    expect(content).not.toContain("abc123def456");
  });

  it("passes its own confirm through to the skill call", async () => {
    let seen: WriteConfirmation | undefined;
    const invoke: LoopDeps["invoke"] = async (_s, _t, _i, options) => {
      seen = options.confirm;
      return { ok: true, result: null };
    };
    const t = setup([turn({ toolCalls: [call(READ)], stop: "tools" }), turn({ text: "ok" })], { invoke });
    await t.run("x");
    expect(typeof seen).toBe("function");
  });
});
