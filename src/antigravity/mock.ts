import type {
  AvailableCommand,
  ContentBlock,
  SessionConfigOption,
  SessionInfo,
  SessionUpdate,
} from "@agentclientprotocol/sdk/unstable";

/*
 * Browser-dev & unit-test mock ACP v1 agent: speaks authentic JSON-RPC 2.0
 * ACP messages over the same line interface as `agy acp`, so `AcpClient`,
 * `reduceUpdate`, `store.ts`, and the full UI are exercised end-to-end.
 *
 * Speed multiplier: `localStorage["midterm.antigravityMockSpeed"] = "10"`.
 * Keyword triggers after the showcase turn: "plan", "ask", "compact", "auth",
 * "error".
 */

type RpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

const COMMANDS: AvailableCommand[] = [
  { name: "review", description: "Review staged or unstaged changes for bugs" },
  { name: "plan", description: "Draft an implementation plan before editing", input: { hint: "[goal]" } },
  { name: "compact", description: "Compact the conversation context" },
  { name: "doctor", description: "Check Antigravity environment and MCP health" },
];

function initialConfigOptions(): SessionConfigOption[] {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Ask before edits", description: "Ask before modifying files or running commands" },
        { value: "accept-edits", name: "Accept edits", description: "Apply file edits automatically; ask for commands" },
        { value: "plan", name: "Plan mode", description: "Read-only exploration and planning" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gemini-4-neon",
      options: [
        {
          group: "gemini",
          name: "Gemini",
          options: [
            { value: "gemini-4-neon", name: "Gemini 4 Neon", description: "Flagship reasoning and coding model" },
            { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", description: "Fast everyday coding model" },
            { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash", description: "Ultra-low latency" },
          ],
        },
      ],
    },
    {
      id: "thought_level",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra high" },
      ],
    },
    {
      id: "sandbox",
      name: "Terminal sandbox",
      category: "_antigravity_sandbox",
      type: "boolean",
      currentValue: false,
      description: "Isolate shell commands in the Antigravity sandbox",
    },
  ];
}

function mockSpeed(): number {
  try {
    const raw = globalThis.localStorage?.getItem("midterm.antigravityMockSpeed");
    const parsed = raw ? Number(raw) : 1;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  } catch {
    return 1;
  }
}

export function openMockAcp(
  onLine: (line: string) => void,
  options: { cwd: string; speed?: number },
): { send(line: string): void; close(): void } {
  let closed = false;
  let seq = 1;
  let configOptions = initialConfigOptions();
  let currentSessionId = "";
  let turnCount = 0;
  let usageUsed = 28_400;
  const usageSize = 1_000_000;
  let activeCancel: (() => void) | undefined;
  const pendingClientReqs = new Map<number, (msg: RpcMessage) => void>();

  const pastSessions: SessionInfo[] = [
    {
      sessionId: "mock-sess-prev-1",
      cwd: options.cwd,
      title: "Fix flaky terminal resize race",
      updatedAt: new Date(Date.now() - 25 * 60_000).toISOString(),
    },
    {
      sessionId: "mock-sess-prev-2",
      cwd: options.cwd,
      title: "Add keyboard navigation to command palette",
      updatedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
    },
  ];

  const emit = (msg: Record<string, unknown>) => {
    if (closed) return;
    queueMicrotask(() => {
      if (!closed) onLine(JSON.stringify({ jsonrpc: "2.0", ...msg }));
    });
  };

  const reply = (id: number | string | undefined, result: unknown) => {
    if (id !== undefined) emit({ id, result });
  };

  const replyError = (id: number | string | undefined, code: number, message: string) => {
    if (id !== undefined) emit({ id, error: { code, message } });
  };

  const update = (sessionId: string, payload: SessionUpdate) => {
    emit({ method: "session/update", params: { sessionId, update: payload } });
  };

  const askClient = (method: string, params: Record<string, unknown>): Promise<RpcMessage> => {
    const id = 10_000 + seq++;
    return new Promise((resolve) => {
      pendingClientReqs.set(id, resolve);
      emit({ id, method, params });
    });
  };

  const wait = (ms: number, aborted: () => boolean) =>
    new Promise<boolean>((resolve) => {
      const scaled = Math.max(0, Math.round(ms / (options.speed ?? mockSpeed())));
      if (scaled === 0) {
        resolve(!aborted() && !closed);
        return;
      }
      const timer = setTimeout(() => resolve(!aborted() && !closed), scaled);
      const prevCancel = activeCancel;
      activeCancel = () => {
        clearTimeout(timer);
        prevCancel?.();
        resolve(false);
      };
    });

  async function runTurn(reqId: number | string | undefined, sessionId: string, blocks: ContentBlock[]) {
    turnCount++;
    let cancelled = false;
    activeCancel = () => {
      cancelled = true;
    };
    const isAborted = () => cancelled || closed;
    const text = blocks
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const lower = text.toLowerCase();

    if (lower.includes("auth")) {
      replyError(reqId, -32000, "Authentication required. Sign in with `agy acp --login`.");
      return;
    }
    if (lower.includes("error")) {
      replyError(reqId, -32603, "Simulated model failure from mock agent.");
      return;
    }

    if (turnCount === 1) {
      update(sessionId, {
        sessionUpdate: "session_info_update",
        title: text.length > 42 ? `${text.slice(0, 42)}…` : text || "Antigravity session",
      });
    }

    // Stream thinking
    const thoughtChunks = ["Inspecting the workspace ", "and checking the relevant files ", "to prepare a minimal fix…"];
    for (const chunk of thoughtChunks) {
      if (!(await wait(60, isAborted))) return reply(reqId, { stopReason: "cancelled" });
      update(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        messageId: `t-${turnCount}`,
        content: { type: "text", text: chunk },
      });
    }

    // Plan update
    update(sessionId, {
      sessionUpdate: "plan",
      entries: [
        { content: "Inspect target module", priority: "high", status: "completed" },
        { content: "Apply focused patch", priority: "high", status: "in_progress" },
        { content: "Run test suite", priority: "medium", status: "pending" },
      ],
    });

    if (lower.includes("compact")) {
      update(sessionId, { sessionUpdate: "compaction_update", compactionId: `cmp-${turnCount}`, status: "in_progress" });
      if (!(await wait(120, isAborted))) return reply(reqId, { stopReason: "cancelled" });
      update(sessionId, {
        sessionUpdate: "compaction_summary_chunk",
        compactionId: `cmp-${turnCount}`,
        content: { type: "text", text: "Compacted earlier turns into a concise workspace summary (freed 18k tokens)." },
      });
      update(sessionId, { sessionUpdate: "compaction_update", compactionId: `cmp-${turnCount}`, status: "completed" });
      usageUsed = Math.max(12_000, usageUsed - 18_000);
      update(sessionId, { sessionUpdate: "usage_update", used: usageUsed, size: usageSize });
    }

    if (lower.includes("ask")) {
      const ans = await askClient("elicitation/create", {
        sessionId,
        mode: "form",
        message: "Which verification scope should Antigravity run?",
        requestedSchema: {
          type: "object",
          properties: {
            scope: { type: "string", title: "Test scope", enum: ["unit", "integration", "all"], default: "unit" },
            strict: { type: "boolean", title: "Fail on warnings", default: true },
          },
          required: ["scope"],
        },
      });
      const res = (ans.result ?? {}) as { action?: string; content?: Record<string, unknown> };
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: `m-${turnCount}`,
        content: {
          type: "text",
          text:
            res.action === "accept"
              ? `Got it — using **${String(res.content?.scope ?? "unit")}** scope${res.content?.strict ? " (strict)" : ""}.`
              : "No problem, skipping the optional configuration.",
        },
      });
      reply(reqId, { stopReason: "end_turn" });
      return;
    }

    // Read tool call
    const readId = `tc-read-${turnCount}`;
    const sampleFile = `${options.cwd.replace(/\/$/, "")}/src/run.ts`;
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: readId,
      title: "Read src/run.ts",
      kind: "read",
      status: "in_progress",
      locations: [{ path: sampleFile, line: 12 }],
      rawInput: { path: sampleFile, startLine: 1, endLine: 40 },
    });
    if (!(await wait(90, isAborted))) return reply(reqId, { stopReason: "cancelled" });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: readId,
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "export function run(x: number) {\n  return x + 1;\n}" } }],
    });

    // Edit tool call with native ACP Diff
    const editId = `tc-edit-${turnCount}`;
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: editId,
      title: "Edit src/run.ts",
      kind: "edit",
      status: "in_progress",
      locations: [{ path: sampleFile, line: 2 }],
    });
    if (!(await wait(90, isAborted))) return reply(reqId, { stopReason: "cancelled" });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: editId,
      status: "completed",
      content: [
        {
          type: "diff",
          path: sampleFile,
          oldText: "export function run(x: number) {\n  return x + 1;\n}\n",
          newText: "export function run(x: number) {\n  if (!Number.isFinite(x)) throw new RangeError(\"expected finite number\");\n  return x + 1;\n}\n",
        },
      ],
    });

    // Execute tool with permission request on turn 1 or when asked
    if (turnCount === 1 || lower.includes("test")) {
      const execId = `tc-exec-${turnCount}`;
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: execId,
        title: "bun test",
        kind: "execute",
        status: "pending",
        rawInput: { command: "bun test" },
      });
      const perm = await askClient("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: execId, title: "Run `bun test`", kind: "execute", rawInput: { command: "bun test" } },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow_always", name: "Always allow bun test", kind: "allow_always" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      });
      const outcome = ((perm.result as { outcome?: { outcome?: string; optionId?: string } }) ?? {}).outcome;
      const allowed = outcome?.outcome === "selected" && outcome.optionId?.startsWith("allow");
      if (!allowed) {
        update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: execId,
          status: "failed",
          content: [{ type: "content", content: { type: "text", text: "Command rejected by user." } }],
        });
      } else {
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: execId, status: "in_progress" });
        if (!(await wait(120, isAborted))) return reply(reqId, { stopReason: "cancelled" });
        update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: execId,
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "12 pass\n0 fail\nRan 12 tests in 48ms" } }],
        });
      }
    }

    update(sessionId, {
      sessionUpdate: "plan",
      entries: [
        { content: "Inspect target module", priority: "high", status: "completed" },
        { content: "Apply focused patch", priority: "high", status: "completed" },
        { content: "Run test suite", priority: "medium", status: "completed" },
      ],
    });

    const answer = [
      "Updated `src/run.ts` to validate finite inputs before returning.\n\n",
      "- Added a `Number.isFinite(x)` guard in `run()`\n",
      "- Verified the change with the test suite\n",
    ];
    for (const part of answer) {
      if (!(await wait(50, isAborted))) return reply(reqId, { stopReason: "cancelled" });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: `m-${turnCount}`,
        content: { type: "text", text: part },
      });
    }

    usageUsed += 6_420;
    update(sessionId, {
      sessionUpdate: "usage_update",
      used: usageUsed,
      size: usageSize,
      cost: { amount: Number((turnCount * 0.03).toFixed(2)), currency: "USD" },
    });

    reply(reqId, {
      stopReason: "end_turn",
      usage: { inputTokens: 5_100, outputTokens: 820, thoughtTokens: 500, totalTokens: 6_420 },
    });
  }

  return {
    send(line: string) {
      if (closed) return;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }

      // Response to one of our agent-initiated requests
      if (typeof msg.id === "number" && !msg.method && pendingClientReqs.has(msg.id)) {
        const resolve = pendingClientReqs.get(msg.id)!;
        pendingClientReqs.delete(msg.id);
        resolve(msg);
        return;
      }

      const params = msg.params ?? {};
      switch (msg.method) {
        case "initialize":
          reply(msg.id, {
            protocolVersion: 1,
            agentInfo: { name: "antigravity-mock", title: "Antigravity (Mock)", version: "1.5.12" },
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true, embeddedContext: true },
              sessionCapabilities: { list: {}, delete: {}, resume: {}, close: {} },
            },
          });
          break;

        case "session/new":
          currentSessionId = `mock-sess-${seq++}`;
          reply(msg.id, { sessionId: currentSessionId, configOptions });
          update(currentSessionId, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS });
          update(currentSessionId, { sessionUpdate: "usage_update", used: usageUsed, size: usageSize });
          break;

        case "session/list":
          reply(msg.id, { sessions: pastSessions });
          break;

        case "session/load": {
          const sid = String(params.sessionId ?? "mock-sess-prev-1");
          currentSessionId = sid;
          const info = pastSessions.find((s) => s.sessionId === sid);
          update(sid, { sessionUpdate: "session_info_update", title: info?.title ?? "Restored session" });
          update(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Can you check why the resize observer raced?" } });
          update(sid, {
            sessionUpdate: "agent_message_chunk",
            messageId: "replay-1",
            content: { type: "text", text: "I debounced the resize observer and added a unit test covering back-to-back splits." },
          });
          update(sid, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS });
          update(sid, { sessionUpdate: "usage_update", used: 42_000, size: usageSize });
          reply(msg.id, { configOptions });
          break;
        }

        case "session/resume":
          currentSessionId = String(params.sessionId ?? `mock-sess-${seq++}`);
          reply(msg.id, { configOptions });
          break;

        case "session/delete": {
          const idx = pastSessions.findIndex((s) => s.sessionId === params.sessionId);
          if (idx >= 0) pastSessions.splice(idx, 1);
          reply(msg.id, {});
          break;
        }

        case "session/close":
          reply(msg.id, {});
          break;

        case "session/set_config_option": {
          const configId = String(params.configId ?? "");
          const value = params.value;
          configOptions = configOptions.map((opt) => {
            if (opt.id !== configId) return opt;
            if (opt.type === "boolean" && typeof value === "boolean") return { ...opt, currentValue: value };
            if (opt.type === "select" && typeof value === "string") return { ...opt, currentValue: value };
            return opt;
          });
          reply(msg.id, { configOptions });
          update(currentSessionId, { sessionUpdate: "config_option_update", configOptions });
          break;
        }

        case "session/set_mode": {
          const modeId = String(params.modeId ?? "default");
          configOptions = configOptions.map((opt) =>
            opt.type === "select" && opt.id === "mode" ? { ...opt, currentValue: modeId } : opt,
          );
          reply(msg.id, {});
          update(currentSessionId, { sessionUpdate: "current_mode_update", currentModeId: modeId });
          break;
        }

        case "session/prompt": {
          const sid = String(params.sessionId ?? currentSessionId);
          const blocks = Array.isArray(params.prompt) ? (params.prompt as ContentBlock[]) : [];
          void runTurn(msg.id, sid, blocks);
          break;
        }

        case "session/cancel":
          activeCancel?.();
          break;

        default:
          replyError(msg.id, -32601, `Unknown mock method: ${String(msg.method)}`);
      }
    },
    close() {
      closed = true;
      activeCancel?.();
      pendingClientReqs.clear();
    },
  };
}
