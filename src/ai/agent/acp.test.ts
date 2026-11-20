import { describe, expect, it } from "vitest";
import type { AcpEvent, AcpPromptRequest, AcpStop, AcpToolResult } from "../../ipc/ai";
import type { RegisteredSkill, ToolResult } from "../../plugins/skills";
import type { SkillTool } from "../../plugins/types";
import { type AcpDeps, CONTINUE_PROMPT, MAX_ACP_TOOL_CALLS, SESSION_LOST, runAcpTurn } from "./acp";
import { type ConfirmAnswer, type Conversation, type ConversationHandle, type TranscriptItem, newConversation } from "./loop";
import { ACP_PROMPT_LINE, buildToolset } from "./tools";

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

/** A scripted prompt: emits events, may wait for tool results or a cancel, then stops. */
type Script = (io: {
  request: AcpPromptRequest;
  emit: (event: AcpEvent) => void;
  /** Emits a tool call and resolves with its result. */
  call: (name: string, input?: unknown, callId?: string) => Promise<AcpToolResult>;
  /** Resolves when the driver cancels this prompt. */
  cancelled: Promise<void>;
}) => Promise<AcpStop>;

const last = <T,>(list: readonly T[]): T | undefined => list[list.length - 1];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const types = (items: readonly TranscriptItem[]) => items.map((item) => item.type);
const tools = (items: readonly TranscriptItem[]) => items.filter((item): item is Extract<TranscriptItem, { type: "tool" }> => item.type === "tool");

function setup(scripts: (Script | Error)[], options: { invoke?: AcpDeps["invoke"]; ask?: (signal: AbortSignal) => Promise<ConfirmAnswer> } = {}) {
  let conversation: Conversation = newConversation("c1", { provider: { id: "claude-code" }, model: "" }, buildToolset(skills, { acp: true }), "pane-1", "acp");
  const h: ConversationHandle = { get: () => conversation, update: (change) => (conversation = change(conversation)) };
  const requests: AcpPromptRequest[] = [];
  const results: AcpToolResult[] = [];
  const cancelled: string[] = [];
  const invoked: { tool: string; input: unknown }[] = [];
  const waiting = new Map<string, (result: AcpToolResult) => void>();
  const cancels = new Map<string, () => void>();
  let n = 0;
  let calls = 0;
  const deps: AcpDeps = {
    prompt: async (request, onEvent) => {
      requests.push(structuredClone(request));
      const script = scripts.shift();
      if (!script) throw new Error("no more scripts");
      if (script instanceof Error) throw script;
      const cancelledPromise = new Promise<void>((resolve) => cancels.set(request.requestId, resolve));
      return {
        stop: await script({
          request,
          emit: onEvent,
          call: (name, input = {}, callId = `call-${++calls}`) =>
            new Promise((resolve) => {
              waiting.set(callId, resolve);
              onEvent({ type: "toolCall", callId, name, input });
            }),
          cancelled: cancelledPromise,
        }),
      };
    },
    toolResult: async (result) => {
      results.push(result);
      waiting.get(result.callId)?.(result);
      waiting.delete(result.callId);
    },
    cancel: (requestId) => {
      cancelled.push(requestId);
      cancels.get(requestId)?.();
    },
    invoke:
      options.invoke ??
      (async (_skillId, toolName, input, { confirm }) => {
        invoked.push({ tool: toolName, input });
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
  return { h, deps, requests, results, cancelled, invoked, controller, run: (text: string | null) => runAcpTurn(h, text, deps, controller.signal) };
}

describe("runAcpTurn", () => {
  it("streams an answer; the first prompt carries the redacted context line and the frozen system and tools", async () => {
    const t = setup([
      async ({ emit }) => {
        emit({ type: "text", text: "\nHel" });
        emit({ type: "text", text: "lo " });
        return "end";
      },
      async ({ emit }) => {
        emit({ type: "text", text: "Again" });
        return "end";
      },
    ]);
    await t.run("hi");
    const c = t.h.get();
    expect(c.status).toBe("idle");
    expect(types(c.items)).toEqual(["user", "assistant"]);
    expect(c.items[1]).toMatchObject({ text: "Hello", streaming: false });
    const first = t.requests[0];
    expect(first.conversationId).toBe("c1");
    expect(first.text.startsWith("[Context — OS: macOS; token=[redacted]")).toBe(true);
    expect(first.text.endsWith("\n\nhi")).toBe(true);
    expect(first.system).toContain(ACP_PROMPT_LINE);
    expect(first.tools).toEqual(c.toolset.tools);
    await t.run("more");
    expect(t.requests[1].text).toBe("more");
    expect(t.h.get().messages).toHaveLength(2);
  });

  it("runs tool calls one at a time, in order, and starts a new answer after a tool row", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const invoke: AcpDeps["invoke"] = async (_s, toolName, input) => {
      const label = (input as { n: number }).n;
      order.push(`start ${label}`);
      if (label === 1) await gate;
      order.push(`end ${label}`);
      return { ok: true, result: { ran: toolName, n: label } };
    };
    const t = setup(
      [
        async ({ emit, call }) => {
          emit({ type: "text", text: "Looking" });
          // The CLI sends both at once (parallel calls); the driver runs them one after the other.
          const both = Promise.all([call(READ, { n: 1 }, "a"), call(READ, { n: 2 }, "b")]);
          await tick();
          expect(order).toEqual(["start 1"]);
          release();
          await both;
          emit({ type: "text", text: "Done" });
          return "end";
        },
      ],
      { invoke },
    );
    await t.run("look");
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
    expect(t.results.map((r) => [r.callId, JSON.parse(r.content).n, r.isError])).toEqual([
      ["a", 1, false],
      ["b", 2, false],
    ]);
    const c = t.h.get();
    expect(types(c.items)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    expect(c.items[1]).toMatchObject({ text: "Looking", streaming: false });
    expect(last(c.items)).toMatchObject({ text: "Done", streaming: false });
  });

  it("loads skills through the shared tool path", async () => {
    const t = setup([
      async ({ call }) => {
        const result = await call("load_skill", { skill: "terminal.commands" });
        expect(JSON.parse(result.content)).toMatchObject({ skill: "terminal.commands", instructions: "Load me.", tools: [READ, WRITE] });
        return "end";
      },
    ]);
    await t.run("x");
    expect(types(t.h.get().items)).toEqual(["user", "skill"]);
  });

  it("asks before write tools: allow, allow for the conversation, deny", async () => {
    const answers: ConfirmAnswer[] = ["allow", "always"];
    const t = setup(
      [
        async ({ call }) => {
          await call(WRITE, { command: "ls" });
          await call(WRITE, { command: "pwd" });
          await call(WRITE, { command: "id" });
          return "end";
        },
      ],
      { ask: async () => answers.shift()! },
    );
    await t.run("go");
    expect(answers).toEqual([]);
    expect(t.h.get().allowed).toEqual([WRITE]);
    expect(t.invoked).toHaveLength(3);
    expect(tools(t.h.get().items).map((item) => item.status)).toEqual(["done", "done", "done"]);

    const d = setup(
      [
        async ({ call, emit }) => {
          const result = await call(WRITE, { command: "rm -rf x" });
          expect(result.isError).toBe(true);
          expect(JSON.parse(result.content)).toEqual({ error: "The user denied this action." });
          emit({ type: "text", text: "Understood" });
          return "end";
        },
      ],
      { ask: async () => "deny" },
    );
    await d.run("delete");
    expect(tools(d.h.get().items)[0].status).toBe("denied");
    expect(last(d.h.get().items)).toMatchObject({ type: "assistant", text: "Understood" });
  });

  it("declines a pending confirmation on Stop and cancels the prompt", async () => {
    let t!: ReturnType<typeof setup>;
    t = setup(
      [
        async ({ call, cancelled }) => {
          void call(WRITE, { command: "ls" }, "w");
          await cancelled;
          return "cancelled";
        },
      ],
      {
        ask: (signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve("deny"));
            setTimeout(() => t.controller.abort(), 5);
          }),
      },
    );
    await t.run("x");
    const c = t.h.get();
    expect(t.cancelled).toEqual(["r1"]);
    expect(tools(c.items)[0].status).toBe("cancelled");
    expect(JSON.parse(tools(c.items)[0].result!).error).toBe("Cancelled by the user");
    expect(last(c.items)).toMatchObject({ type: "note", text: "Stopped." });
    expect(c.status).toBe("idle");
  });

  it("marks a partial answer stopped when Stop cancels mid-answer", async () => {
    let t!: ReturnType<typeof setup>;
    t = setup([
      async ({ emit, cancelled }) => {
        emit({ type: "text", text: "Partial" });
        setTimeout(() => t.controller.abort(), 5);
        await cancelled;
        return "cancelled";
      },
    ]);
    await t.run("long");
    expect(last(t.h.get().items)).toMatchObject({ type: "assistant", text: "Partial", stopped: true, streaming: false });
  });

  it("marks an answer cut off at the token limit", async () => {
    const t = setup([
      async ({ emit }) => {
        emit({ type: "text", text: "I will" });
        return "length";
      },
    ]);
    await t.run("x");
    expect(last(t.h.get().items)).toMatchObject({ type: "assistant", text: "I will", cut: true });
    expect(t.h.get().resume).toBeUndefined();
  });

  it("shows a failed prompt's error, and Retry sends the same prompt again", async () => {
    const t = setup([
      Object.assign(new Error("ignored"), { kind: "network", message: "The adapter is not installed" }),
      async ({ emit }) => {
        emit({ type: "text", text: "fine" });
        return "end";
      },
    ]);
    await t.run("x");
    let c = t.h.get();
    expect(last(c.items)).toMatchObject({ type: "error", message: "The adapter is not installed" });
    expect(c.resume).toBe("retry");
    expect(c.messages).toHaveLength(0);
    await t.run(null);
    c = t.h.get();
    expect(t.requests[1].text).toBe(t.requests[0].text);
    expect(t.requests[1].text.startsWith("[Context")).toBe(true);
    expect(c.resume).toBeUndefined();
    expect(c.messages).toHaveLength(1);
    expect(last(c.items)).toMatchObject({ type: "assistant", text: "fine" });
  });

  it("maps a refusal to an error with Retry and the CLI's request limit to a note with Continue", async () => {
    const t = setup([async () => "refused", async () => "maxRequests", async () => "end"]);
    await t.run("x");
    expect(last(t.h.get().items)).toMatchObject({ type: "error", message: "The model refused this request." });
    expect(t.h.get().resume).toBe("retry");
    await t.run("y");
    expect(last(t.h.get().items)).toMatchObject({ type: "note" });
    expect(t.h.get().resume).toBe("continue");
    await t.run(null);
    expect(t.requests[2].text).toBe(CONTINUE_PROMPT);
  });

  it("shows tools the CLI ran itself as one muted row per id", async () => {
    const t = setup([
      async ({ emit }) => {
        emit({ type: "text", text: "Before" });
        emit({ type: "foreignTool", id: "f1", title: "Bash", status: "running" });
        emit({ type: "foreignTool", id: "f1", title: "", status: "denied" });
        emit({ type: "text", text: "After" });
        return "end";
      },
    ]);
    await t.run("x");
    const c = t.h.get();
    expect(types(c.items)).toEqual(["user", "assistant", "foreign", "assistant"]);
    expect(c.items[2]).toMatchObject({ foreignId: "f1", title: "Bash", status: "denied" });
    expect(t.invoked).toEqual([]);
  });

  it(`cancels after ${MAX_ACP_TOOL_CALLS} tool calls, with a note and Continue`, async () => {
    const t = setup([
      async ({ call, cancelled }) => {
        for (let i = 0; i < MAX_ACP_TOOL_CALLS; i++) await call(READ);
        const over = await call(READ, {}, "over");
        expect(over.isError).toBe(true);
        await cancelled;
        return "cancelled";
      },
      async () => "end",
    ]);
    await t.run("loop");
    const c = t.h.get();
    expect(t.invoked).toHaveLength(MAX_ACP_TOOL_CALLS);
    expect(t.cancelled).toEqual(["r1"]);
    expect(last(tools(c.items))?.status).toBe("skipped");
    expect(last(c.items)).toMatchObject({ type: "note", text: `Stopped after ${MAX_ACP_TOOL_CALLS} tool calls.` });
    expect(c.resume).toBe("continue");
    await t.run(null);
    expect(t.requests[1].text).toBe(CONTINUE_PROMPT);
    expect(t.h.get().resume).toBeUndefined();
  });

  it("declines a confirmation still pending when the prompt ends on its own", async () => {
    let asked: AbortSignal | undefined;
    const invoke: AcpDeps["invoke"] = async (_s, _t, input, { confirm }) => {
      const ok = await confirm!({ skill: skills[0], tool: tool("run_command", "write"), input });
      return ok ? ({ ok: true, result: null } satisfies ToolResult) : { ok: false, error: "no" };
    };
    const t = setup(
      [
        async ({ emit }) => {
          emit({ type: "toolCall", callId: "w", name: WRITE, input: { command: "ls" } });
          await tick();
          return "end";
        },
      ],
      {
        invoke,
        ask: (signal) => {
          asked = signal;
          return new Promise((resolve) => signal.addEventListener("abort", () => resolve("deny")));
        },
      },
    );
    await t.run("x");
    expect(asked?.aborted).toBe(true);
    expect(tools(t.h.get().items)[0].status).toBe("cancelled");
    // The prompt was over: no late result.
    expect(t.results).toEqual([]);
  });

  it("drops a call the agent withdraws: a pending confirmation is declined, nothing runs, no result", async () => {
    let asked: AbortSignal | undefined;
    const t = setup(
      [
        async ({ emit }) => {
          emit({ type: "toolCall", callId: "w", name: WRITE, input: { command: "rm x" } });
          await new Promise((resolve) => setTimeout(resolve, 5));
          emit({ type: "toolCallCancelled", callId: "w" });
          await tick();
          emit({ type: "text", text: "Never mind." });
          return "end";
        },
      ],
      {
        ask: (signal) => {
          asked = signal;
          return new Promise((resolve) => signal.addEventListener("abort", () => resolve("deny")));
        },
      },
    );
    await t.run("x");
    const c = t.h.get();
    expect(asked?.aborted).toBe(true);
    expect(tools(c.items)[0]).toMatchObject({ status: "cancelled" });
    expect(JSON.parse(tools(c.items)[0].result!).error).toBe("Withdrawn by the CLI");
    expect(t.results).toEqual([]);
    expect(t.cancelled).toEqual([]);
    expect(last(c.items)).toMatchObject({ type: "assistant", text: "Never mind." });
  });

  it("skips a call withdrawn before its turn in the queue", async () => {
    let asked = false;
    const t = setup(
      [
        async ({ emit }) => {
          emit({ type: "toolCall", callId: "w", name: WRITE, input: { command: "ls" } });
          emit({ type: "toolCallCancelled", callId: "w" });
          await tick();
          return "end";
        },
      ],
      {
        ask: async () => {
          asked = true;
          return "allow";
        },
      },
    );
    await t.run("x");
    expect(asked).toBe(false);
    expect(t.invoked).toEqual([]);
    expect(tools(t.h.get().items)[0].status).toBe("cancelled");
    expect(t.results).toEqual([]);
  });

  it("notes a new session for a conversation that had one", async () => {
    const t = setup([
      async ({ emit }) => {
        emit({ type: "sessionStarted" });
        emit({ type: "text", text: "First." });
        return "end";
      },
      async ({ emit }) => {
        emit({ type: "sessionStarted" });
        emit({ type: "text", text: "Fresh." });
        return "end";
      },
    ]);
    await t.run("one");
    expect(t.h.get().items.some((item) => item.type === "note")).toBe(false);
    await t.run("two");
    expect(types(t.h.get().items)).toEqual(["user", "assistant", "user", "note", "assistant"]);
    expect(t.h.get().items[3]).toMatchObject({ text: SESSION_LOST });
  });

  it("cancels the prompt and shows the error when a tool result cannot be delivered", async () => {
    const t = setup([
      async ({ emit, cancelled }) => {
        emit({ type: "toolCall", callId: "r", name: READ, input: {} });
        await cancelled;
        return "cancelled";
      },
    ]);
    t.deps.toolResult = async () => {
      throw { kind: "other", message: "the session is gone" };
    };
    await t.run("x");
    const c = t.h.get();
    expect(t.cancelled).toEqual(["r1"]);
    expect(last(c.items)).toMatchObject({ type: "error", message: "Could not send a tool result to the CLI: the session is gone" });
    expect(c.resume).toBe("continue");
    expect(c.status).toBe("idle");
  });
});
