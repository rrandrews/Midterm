import { describe, expect, it } from "vitest";
import type { SDKMessage, SessionMessage } from "./protocol";
import { createSession, formatTokens, fromSessionMessages, parsePartialJson, reduce, RESULT_LIMIT } from "./reduce";
import type { ClaudeSession } from "./types";

const SESSION = "6a1c2a8e-3f4b-4f7e-9d1a-0c9b2e5d7f10";
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

/** Fixtures are shaped like the SDK's messages; only the fields the reducer reads are filled in. */
const msg = (message: Record<string, unknown>) => ({ uuid: uuid(), session_id: SESSION, ...message }) as unknown as SDKMessage;

const stream = (event: Record<string, unknown>, parent: string | null = null) => msg({ type: "stream_event", event, parent_tool_use_id: parent });

const usage = (input: number, cacheRead: number, cacheWrite: number, output = 10) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
});

const assistant = (id: string, block: Record<string, unknown>, parent: string | null = null, extra: Record<string, unknown> = {}) =>
  msg({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [block], stop_reason: null, usage: usage(6, 30_000, 1_200) },
    ...extra,
  });

const toolResult = (toolUseId: string, content: unknown, options: { isError?: boolean; structured?: unknown; parent?: string | null } = {}) =>
  msg({
    type: "user",
    parent_tool_use_id: options.parent ?? null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: options.isError }] },
    tool_use_result: options.structured,
  });

const result = (extra: Record<string, unknown> = {}) =>
  msg({
    type: "result",
    subtype: "success",
    duration_ms: 12_400,
    duration_api_ms: 9_800,
    is_error: false,
    num_turns: 4,
    result: "Done.",
    stop_reason: "end_turn",
    total_cost_usd: 0.42,
    usage: usage(40, 52_000, 3_000, 900),
    modelUsage: {
      "claude-opus-5-5": { inputTokens: 40, outputTokens: 900, cacheReadInputTokens: 52_000, cacheCreationInputTokens: 3_000, webSearchRequests: 0, costUSD: 0.4, contextWindow: 200_000, maxOutputTokens: 64_000 },
      "claude-haiku-4-5": { inputTokens: 1_200, outputTokens: 80, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.02, contextWindow: 200_000, maxOutputTokens: 32_000 },
    },
    permission_denials: [],
    ...extra,
  });

const NOW = 1_700_000_000_000;
const fresh = (): ClaudeSession => ({ ...createSession({ key: "k", paneId: "p", cwd: "/repo" }), status: "idle" });
const run = (messages: SDKMessage[], session: ClaudeSession = fresh()) => messages.reduce((current, message) => reduce(current, message, NOW), session);

describe("streaming", () => {
  const streamed = [
    stream({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: usage(6, 30_000, 1_200, 1) } }),
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The test is " } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "flaky." } }),
    stream({ type: "content_block_stop", index: 0 }),
  ];

  it("builds a thinking item from deltas and marks the turn running", () => {
    const session = run(streamed);
    expect(session.status).toBe("running");
    expect(session.turnStartedAt).toBe(NOW);
    expect(session.items).toEqual([{ kind: "thinking", id: "msg_1#0", text: "The test is flaky.", streaming: true }]);
    expect(session.contextTokens).toBe(31_206);
  });

  it("replaces the streamed block with the final assistant message", () => {
    const session = run([
      ...streamed,
      assistant("msg_1", { type: "thinking", thinking: "The test is flaky.", signature: "sig" }),
      stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Running " } }),
      stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "the tests." } }),
      stream({ type: "content_block_stop", index: 1 }),
      assistant("msg_1", { type: "text", text: "Running the tests." }),
    ]);
    expect(session.items).toEqual([
      { kind: "thinking", id: "msg_1#0", text: "The test is flaky.", streaming: false },
      { kind: "assistant", id: "msg_1#1", text: "Running the tests.", streaming: false },
    ]);
  });

  it("parses tool input while it streams, then runs the tool", () => {
    const start = [
      stream({ type: "message_start", message: { id: "msg_2", content: [], usage: usage(1, 2, 3) } }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_bash", name: "Bash", input: {} } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command": "bun te' } }),
    ];
    let session = run(start);
    expect(session.items).toEqual([{ kind: "tool", id: "tool:toolu_bash", toolUseId: "toolu_bash" }]);
    expect(session.tools.toolu_bash).toMatchObject({ name: "Bash", status: "streaming", input: { command: "bun te" }, parentToolUseId: null, startedAt: NOW });

    session = run(
      [
        stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'st", "description": "Run tests"}' } }),
        stream({ type: "content_block_stop", index: 0 }),
      ],
      session,
    );
    expect(session.tools.toolu_bash).toMatchObject({ status: "pending", input: { command: "bun test", description: "Run tests" } });

    session = run([assistant("msg_2", { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "bun test", description: "Run tests" } })], session);
    expect(session.tools.toolu_bash.status).toBe("running");
    expect(session.items).toHaveLength(1);

    session = run([msg({ type: "tool_progress", tool_use_id: "toolu_bash", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 2.1 })], session);
    expect(session.tools.toolu_bash.elapsed).toBe(2.1);

    const structured = { stdout: "64 pass\n0 fail", stderr: "", interrupted: false };
    session = run([toolResult("toolu_bash", "64 pass\n0 fail", { structured })], session);
    expect(session.tools.toolu_bash).toMatchObject({ status: "done", result: "64 pass\n0 fail", structured, isError: false, endedAt: NOW });
  });
});

describe("assistant messages without streaming", () => {
  it("adds each block once, even when a message repeats", () => {
    const text = assistant("msg_9", { type: "text", text: "Hello" });
    const session = run([text, text]);
    expect(session.items.filter((item) => item.kind === "assistant")).toHaveLength(1);
  });

  it("shows an API error as an error notice", () => {
    const session = run([assistant("msg_err", { type: "text", text: "API Error: 529 Overloaded" }, null, { error: "overloaded" })]);
    expect(session.items).toEqual([{ kind: "notice", id: "msg_err#error", tone: "error", text: "API Error: 529 Overloaded" }]);
  });

  it("takes TodoWrite's list as the session's to-dos", () => {
    const todos = [
      { content: "Reproduce the failure", status: "completed", activeForm: "Reproducing the failure" },
      { content: "Fix the race", status: "in_progress", activeForm: "Fixing the race" },
      { content: "Bogus", status: "unknown" },
    ];
    const session = run([assistant("msg_t", { type: "tool_use", id: "toolu_todo", name: "TodoWrite", input: { todos } })]);
    expect(session.todos).toEqual([
      { content: "Reproduce the failure", status: "completed", activeForm: "Reproducing the failure" },
      { content: "Fix the race", status: "in_progress", activeForm: "Fixing the race" },
    ]);
  });
});

describe("task list tools", () => {
  const call = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) => assistant(`msg_${id}`, { type: "tool_use", id, name, input }, parent);

  it("build the to-dos from TaskCreate and TaskUpdate", () => {
    const session = run([
      call("c1", "TaskCreate", { subject: "Reproduce the failure", description: "Run the tests", activeForm: "Reproducing the failure" }),
      toolResult("c1", "Task #1 created successfully: Reproduce the failure", { structured: { task: { id: "1", subject: "Reproduce the failure" } } }),
      call("c2", "TaskCreate", { subject: "Fix the race", description: "Change drain()" }),
      // No structured result (a resumed transcript): the id comes from the text.
      toolResult("c2", "Task #2 created successfully: Fix the race"),
      call("c3", "TaskCreate", { subject: "Delete me", description: "" }),
      toolResult("c3", "Task #3 created successfully: Delete me"),
      call("u1", "TaskUpdate", { taskId: "1", status: "completed" }),
      toolResult("u1", "Updated task #1 status", { structured: { success: true, taskId: "1", updatedFields: ["status"] } }),
      call("u2", "TaskUpdate", { taskId: "2", status: "in_progress", subject: "Fix the drain race" }),
      toolResult("u2", "Updated task #2 status, subject"),
      call("u3", "TaskUpdate", { taskId: "3", status: "deleted" }),
      toolResult("u3", "Updated task #3 deleted"),
      // A failed update changes nothing.
      call("u4", "TaskUpdate", { taskId: "2", status: "completed" }),
      toolResult("u4", "Task not found", { isError: true }),
    ]);
    expect(session.todos).toEqual([
      { id: "1", content: "Reproduce the failure", status: "completed", activeForm: "Reproducing the failure" },
      { id: "2", content: "Fix the drain race", status: "in_progress", activeForm: undefined },
    ]);
  });

  it("take TaskList's list, keeping known active forms, and ignore subagents' tasks", () => {
    let session = run([
      call("c1", "TaskCreate", { subject: "A", description: "", activeForm: "Doing A" }),
      toolResult("c1", "Task #1 created successfully: A"),
      call("sub", "TaskCreate", { subject: "Subagent task", description: "" }, "toolu_agent"),
      toolResult("sub", "Task #9 created successfully: Subagent task", { parent: "toolu_agent" }),
    ]);
    expect(session.todos.map((todo) => todo.content)).toEqual(["A"]);
    session = run(
      [
        call("l", "TaskList", {}),
        toolResult("l", "#1 [in_progress] A\n#2 [pending] B", {
          structured: { tasks: [{ id: "1", subject: "A", status: "in_progress", blockedBy: [] }, { id: "2", subject: "B", status: "pending", blockedBy: [] }] },
        }),
      ],
      session,
    );
    expect(session.todos).toEqual([
      { id: "1", content: "A", status: "in_progress", activeForm: "Doing A" },
      { id: "2", content: "B", status: "pending", activeForm: undefined },
    ]);
  });
});

describe("tool results", () => {
  const withTool = (name = "Bash") => run([assistant("msg_r", { type: "tool_use", id: "toolu_x", name, input: { command: "rm -rf build" } })]);

  it("clips long results", () => {
    const session = run([toolResult("toolu_x", [{ type: "text", text: "x".repeat(RESULT_LIMIT + 10) }, { type: "image", source: {} }])], withTool());
    expect(session.tools.toolu_x.result?.length).toBeLessThan(RESULT_LIMIT + 20);
    expect(session.tools.toolu_x.result?.endsWith("(clipped)")).toBe(true);
  });

  it("tells errors, denials and interruptions apart", () => {
    const error = run([toolResult("toolu_x", "exit code 1", { isError: true })], withTool());
    expect(error.tools.toolu_x.status).toBe("error");
    const denied = run([toolResult("toolu_x", "The user doesn't want to proceed with this tool use. The tool use was rejected.", { isError: true })], withTool());
    expect(denied.tools.toolu_x.status).toBe("denied");
    const interrupted = run([toolResult("toolu_x", "[Request interrupted by user for tool use]", { isError: true })], withTool());
    expect(interrupted.tools.toolu_x.status).toBe("cancelled");
  });

  it("marks a tool denied by permission_denied", () => {
    const session = run([msg({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "toolu_x", message: "Denied by rule" })], withTool());
    expect(session.tools.toolu_x.status).toBe("denied");
  });
});

describe("subagents", () => {
  it("routes messages with a parent to that call's transcript and tracks the task", () => {
    const session = run([
      assistant("msg_a", { type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "Find timer races", prompt: "Look for setTimeout", subagent_type: "Explore" } }),
      msg({ type: "system", subtype: "task_started", task_id: "task_1", tool_use_id: "toolu_agent", description: "Find timer races", subagent_type: "Explore", task_type: "local_agent", prompt: "Look for setTimeout" }),
      msg({ type: "user", parent_tool_use_id: "toolu_agent", message: { role: "user", content: [{ type: "text", text: "Look for setTimeout" }] } }),
      assistant("msg_sub1", { type: "text", text: "Searching…" }, "toolu_agent"),
      assistant("msg_sub1", { type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "setTimeout" } }, "toolu_agent"),
      toolResult("toolu_grep", "Found 3 files", { parent: "toolu_agent", structured: { mode: "files_with_matches", numFiles: 3, filenames: ["a.ts", "b.ts", "c.ts"] } }),
      msg({ type: "system", subtype: "task_progress", task_id: "task_1", description: "Find timer races", usage: { total_tokens: 12_000, tool_uses: 1, duration_ms: 3_000 }, last_tool_name: "Grep", summary: "Reading a.ts" }),
      msg({ type: "system", subtype: "task_notification", task_id: "task_1", status: "completed", output_file: "/tmp/t", summary: "Three races", usage: { total_tokens: 18_000, tool_uses: 3, duration_ms: 9_000 } }),
    ]);
    expect(session.items.map((item) => item.id)).toEqual(["tool:toolu_agent"]);
    expect(session.subTranscripts.toolu_agent.map((item) => item.kind)).toEqual(["user", "assistant", "tool"]);
    expect(session.tools.toolu_grep).toMatchObject({ parentToolUseId: "toolu_agent", status: "done" });
    expect(session.tasks.task_1).toMatchObject({
      toolUseId: "toolu_agent",
      subagentType: "Explore",
      status: "completed",
      totalTokens: 18_000,
      toolUses: 3,
      lastToolName: "Grep",
      summary: "Three races",
      endedAt: NOW,
    });
    // A subagent's usage does not move the main context estimate.
    expect(session.contextTokens).toBe(31_206);
  });

  it("applies task_updated patches and skips ambient tasks", () => {
    const session = run([
      msg({ type: "system", subtype: "task_started", task_id: "t", description: "Build", task_type: "local_bash" }),
      msg({ type: "system", subtype: "task_started", task_id: "watch", description: "Watcher", ambient: true }),
      msg({ type: "system", subtype: "task_updated", task_id: "t", patch: { status: "failed", error: "exit 2", is_backgrounded: true, end_time: 5 } }),
    ]);
    expect(Object.keys(session.tasks)).toEqual(["t"]);
    expect(session.tasks.t).toMatchObject({ status: "failed", error: "exit 2", backgrounded: true, endedAt: 5 });
  });

  it("keeps a task's description when progress reports its current activity", () => {
    const session = run([
      msg({ type: "system", subtype: "task_started", task_id: "t", description: "Inventory files in demo folder", task_type: "local_agent" }),
      msg({ type: "system", subtype: "task_progress", task_id: "t", description: "Reading test.js", usage: { total_tokens: 900, tool_uses: 2, duration_ms: 1_000 }, last_tool_name: "Read" }),
    ]);
    expect(session.tasks.t).toMatchObject({ description: "Inventory files in demo folder", summary: "Reading test.js", lastToolName: "Read" });
  });
});

describe("results", () => {
  it("leaves out the first cost after a resume (its total includes earlier spend)", () => {
    const resumed = { ...createSession({ key: "k", paneId: "p", cwd: "/repo", sessionId: "old" }), status: "idle" as const };
    let session = run([result({ total_cost_usd: 3.1 })], resumed);
    expect(session.items[session.items.length - 1]).toMatchObject({ kind: "result", costUsd: 0 });
    session = run([result({ total_cost_usd: 3.4 })], session);
    expect((session.items[session.items.length - 1] as { costUsd: number }).costUsd).toBeCloseTo(0.3);
  });

  it("adds totals and a result item, and goes idle", () => {
    const session = run([
      stream({ type: "message_start", message: { id: "msg_1", content: [], usage: usage(1, 1, 1) } }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } }),
      assistant("msg_2", { type: "tool_use", id: "toolu_open", name: "Read", input: { file_path: "/repo/a.ts" } }),
      result(),
    ]);
    expect(session.status).toBe("idle");
    expect(session.turnStartedAt).toBeUndefined();
    expect(session.totals).toMatchObject({ costUsd: 0.42, durationMs: 12_400, turns: 4, inputTokens: 1_240, outputTokens: 980, cacheReadTokens: 52_000 });
    expect(session.totals.byModel["claude-opus-5-5"].contextWindow).toBe(200_000);
    expect(session.contextWindow).toBe(200_000);
    expect(session.items[session.items.length - 1]).toMatchObject({ kind: "result", costUsd: 0.42, durationMs: 12_400, isError: false });
    // Nothing is left streaming or running.
    expect(session.items[0]).toMatchObject({ kind: "assistant", streaming: false });
    expect(session.tools.toolu_open.status).toBe("cancelled");
    expect(session.streams).toBeUndefined();
  });

  it("counts a turn's own cost and reports errors", () => {
    let session = run([result()]);
    session = run([result({ subtype: "error_during_execution", is_error: true, total_cost_usd: 0.5, errors: ["Something broke"] })], session);
    const items = session.items.slice(-2);
    expect(items[0]).toMatchObject({ kind: "notice", tone: "error", text: "Something broke" });
    expect(items[1]).toMatchObject({ kind: "result", isError: true });
    expect((items[1] as { costUsd: number }).costUsd).toBeCloseTo(0.08);
  });

  it("says when a turn was interrupted, once", () => {
    const interrupted = result({ subtype: "error_during_execution", is_error: true, errors: [] });
    const quiet = run([interrupted]);
    expect(quiet.items.filter((item) => item.kind === "notice")).toEqual([expect.objectContaining({ tone: "warn", text: "Interrupted" })]);
    const marked = run([msg({ type: "user", parent_tool_use_id: null, message: { role: "user", content: "[Request interrupted by user]" } }), interrupted]);
    expect(marked.items.filter((item) => item.kind === "notice")).toHaveLength(1);
  });

  it("stays running while queued turns follow", () => {
    const session = run([result({ queued_turn_count: 1 })], { ...fresh(), status: "running" });
    expect(session.status).toBe("running");
  });
});

describe("queued messages", () => {
  it("are folded in by the uuids on the next turn's first frame", () => {
    const base = fresh();
    base.items = [
      { kind: "user", id: "u1", text: "Fix it" },
      { kind: "assistant", id: "m#0", text: "Working", streaming: false },
      { kind: "user", id: "u2", text: "Also the docs", queued: true },
    ];
    const session = run([assistant("msg_n", { type: "text", text: "Sure, the docs too." }, null, { user_message_uuid: "u2", user_message_uuids: ["u2"] })], base);
    expect(session.items.map((item) => item.id)).toEqual(["u1", "m#0", "u2", expect.stringMatching(/^msg_n#/)]);
    expect(session.items[2]).toMatchObject({ queued: false });
  });
});

describe("system messages", () => {
  it("starts the transcript over on any conversation reset", () => {
    for (const [trigger, text] of [["clear", "Conversation cleared"], ["plan_mode_exit", "Started a fresh conversation with the approved plan"], ["something_new", "Conversation reset"]]) {
      const session = run([assistant("msg_1", { type: "text", text: "Before" }), msg({ type: "conversation_reset", trigger })]);
      expect(session.items).toEqual([expect.objectContaining({ kind: "notice", text })]);
    }
  });

  it("takes the session id, model, mode and MCP servers from init", () => {
    const session = run([
      msg({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-5-5", permissionMode: "acceptEdits", mcp_servers: [{ name: "linear", status: "connected" }], cwd: "/repo", tools: [], slash_commands: [] }),
    ]);
    expect(session).toMatchObject({ sessionId: "sess-1", resolvedModel: "claude-opus-5-5", permissionMode: "acceptEdits", mcpServers: [{ name: "linear", status: "connected" }] });
  });

  it("shows compaction as one line that resolves", () => {
    let session = run([msg({ type: "system", subtype: "status", status: "compacting" })]);
    expect(session.compacting).toBe(true);
    expect(session.items).toEqual([expect.objectContaining({ kind: "notice", text: "Compacting the conversation…" })]);
    session = run([msg({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 152_000, post_tokens: 18_400 } })], session);
    expect(session.items).toHaveLength(1);
    expect(session.items[0]).toMatchObject({ text: "Conversation compacted · 152k → 18k tokens" });
    expect(session.compacting).toBe(false);
    expect(session.contextTokens).toBe(18_400);
  });

  it("coalesces API retries and shows local command output", () => {
    const retry = (attempt: number) => msg({ type: "system", subtype: "api_retry", attempt, max_retries: 10, retry_delay_ms: 2_000, error_status: 529, error: "overloaded" });
    const session = run([retry(1), retry(2), msg({ type: "system", subtype: "local_command_output", content: "Total cost: $0.42" })]);
    expect(session.items).toHaveLength(2);
    expect(session.items[0]).toMatchObject({ tone: "warn", text: "API error 529 (overloaded). Retrying in 2s · attempt 2 of 10" });
    expect(session.items[1]).toMatchObject({ kind: "command", text: "Total cost: $0.42" });
  });

  it("follows permission mode changes and keeps the rate limit info", () => {
    const session = run([
      msg({ type: "system", subtype: "status", status: null, permissionMode: "plan" }),
      msg({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.8, rateLimitType: "five_hour" } }),
    ]);
    expect(session.permissionMode).toBe("plan");
    expect(session.rateLimit).toMatchObject({ status: "allowed_warning" });
  });

  it("turns an interrupt marker into a notice", () => {
    const session = run([msg({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } })]);
    expect(session.items).toEqual([expect.objectContaining({ kind: "notice", tone: "warn", text: "Interrupted" })]);
  });
});

describe("unknown messages", () => {
  it("are ignored", () => {
    const before = fresh();
    const after = run([
      msg({ type: "command_lifecycle", phase: "start" }),
      msg({ type: "system", subtype: "thinking_tokens", estimated_tokens: 40, estimated_tokens_delta: 4 }),
      msg({ type: "system", subtype: "hook_started", hook_id: "h", hook_name: "fmt", hook_event: "PostToolUse" }),
      msg({ type: "system", subtype: "something_new" }),
    ], before);
    expect(after).toBe(before);
  });
});

describe("fromSessionMessages", () => {
  const saved = (type: "user" | "assistant", message: unknown, parent: string | null = null): SessionMessage => ({
    type,
    uuid: uuid(),
    session_id: SESSION,
    message,
    parent_tool_use_id: parent,
    parent_agent_id: null,
  });

  it("keeps a message that is only images", () => {
    const loaded = fromSessionMessages([saved("user", { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] })], NOW);
    expect(loaded.items).toEqual([expect.objectContaining({ kind: "user", text: "", images: [{ mediaType: "image/png", data: "AAAA" }] })]);
  });

  it("rebuilds the transcript with nothing left running", () => {
    const loaded = fromSessionMessages(
      [
        saved("user", { role: "user", content: "Why does the queue test flake?" }),
        saved("assistant", { id: "msg_a", role: "assistant", content: [{ type: "text", text: "Let me look." }] }),
        saved("assistant", { id: "msg_a", role: "assistant", content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/repo/q.ts" } }] }),
        saved("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "     1\texport {}" }] }),
        saved("assistant", { id: "msg_b", role: "assistant", content: [{ type: "tool_use", id: "toolu_never", name: "Bash", input: { command: "bun test" } }] }),
        saved("user", { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the plan</command-args>" }),
        saved("user", { role: "user", content: "<local-command-stdout>Compacted.</local-command-stdout>" }),
        saved("user", { role: "user", content: "<system-reminder>internal</system-reminder>" }),
        saved("assistant", { id: "msg_c", role: "assistant", content: [{ type: "text", text: "The drain loop races the timer." }], usage: usage(10, 40_000, 500) }),
      ],
      NOW,
    );
    expect(loaded.items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "tool", "user", "command", "assistant"]);
    expect(loaded.items[4]).toMatchObject({ text: "/compact keep the plan" });
    expect(loaded.tools.toolu_read.status).toBe("done");
    expect(loaded.tools.toolu_never.status).toBe("cancelled");
    expect(loaded.contextTokens).toBe(40_510);
  });
});

describe("helpers", () => {
  it("parses partial JSON", () => {
    expect(parsePartialJson("")).toEqual({});
    expect(parsePartialJson('{"comm')).toEqual({});
    expect(parsePartialJson('{"command": "ls -')).toEqual({ command: "ls -" });
    expect(parsePartialJson('{"a": 1, "b"')).toEqual({ a: 1 });
    expect(parsePartialJson('{"a": 1, "b":')).toEqual({ a: 1 });
    expect(parsePartialJson('{"todos": [{"content": "x", "status"')).toEqual({ todos: [{ content: "x" }] });
    expect(parsePartialJson('{"path": "C:\\\\')).toEqual({ path: "C:\\" });
    expect(parsePartialJson('{"a": tr')).toBeUndefined();
  });

  it("formats token counts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1_200)).toBe("1.2k");
    expect(formatTokens(152_000)).toBe("152k");
    expect(formatTokens(1_000_000)).toBe("1M");
  });
});
