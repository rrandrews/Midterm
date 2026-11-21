import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import { mockRequest } from "./mockData";
import {
  type AccountInfo,
  type AgentInfo,
  BRIDGE_PROTOCOL,
  type BridgeError,
  type BridgeParams,
  type ContextUsage,
  type EffortLevel,
  type McpServerStatus,
  type ModelInfo,
  type PermissionMode,
  type PermissionRequest,
  type PermissionResult,
  type PlanUsage,
  type ReloadPluginsResult,
  type SessionInit,
  type SessionMessage,
  type SlashCommand,
} from "./protocol";

/*
 * A scripted stand-in for the Claude Code bridge, used when the webview runs
 * outside Tauri (`bun run dev` in a browser). It speaks the protocol of
 * protocol.ts: answers requests, and plays turns as realistic SDK message
 * sequences (streamed thinking/text/tool input, tool results, a subagent,
 * permission prompts, plan and question prompts, compaction, retries).
 * Plugin, marketplace, config and session-list requests come from
 * ./mockData. `localStorage["midterm.claudeMockSpeed"]` divides every delay
 * (10 makes turns nearly instant). See docs/claude-code.md.
 */

type Json = Record<string, unknown>;

const ABORT = Symbol("abort");
const OPUS = "claude-opus-5-5";
const HAIKU = "claude-haiku-4-5";
const CC_VERSION = "2.3.14";
const BASE_CONTEXT = 29000; // the fixed categories of the context usage
const STUB_PATH = "/Users/you/.claude/plugins/cache";

/* ---- Static data ---- */

const COMMANDS: SlashCommand[] = [
  { name: "compact", description: "Clear conversation history but keep a summary in context", argumentHint: "[instructions]" },
  { name: "context", description: "Visualize current context usage as a colored grid", argumentHint: "" },
  { name: "cost", description: "Show the total cost and duration of the current session", argumentHint: "", aliases: ["usage"] },
  { name: "review", description: "Review a pull request", argumentHint: "[pr-number]" },
  { name: "init", description: "Initialize a new CLAUDE.md file with codebase documentation", argumentHint: "" },
  { name: "pr-comments", description: "Get comments from a GitHub pull request", argumentHint: "[pr-number]" },
  { name: "security-review", description: "Complete a security review of the pending changes on the current branch", argumentHint: "" },
  { name: "memory", description: "Edit Claude memory files", argumentHint: "" },
  { name: "agents", description: "Manage agent configurations", argumentHint: "" },
  { name: "mcp", description: "Manage MCP servers", argumentHint: "" },
  { name: "model", description: "Set the AI model for Claude Code", argumentHint: "[model]" },
  { name: "config", description: "Open config panel", argumentHint: "" },
  { name: "commit-commands:commit", description: "Create a git commit (plugin:commit-commands)", argumentHint: "" },
  { name: "frontend-design:frontend-design", description: "Create distinctive, production-grade frontend interfaces (plugin:frontend-design)", argumentHint: "[brief]" },
  { name: "deploy", description: "Deploy the current branch to an environment (project)", argumentHint: "<staging|production> [--dry-run]" },
];

const MODELS: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Most capable for complex work",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
  },
  {
    value: "opus",
    resolvedModel: OPUS,
    displayName: "Opus 5.5",
    description: "Opus 5.5 · Most capable for complex work",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet 5",
    description: "Sonnet 5 · Best for everyday tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
    supportsAdaptiveThinking: true,
  },
  { value: "haiku", resolvedModel: HAIKU, displayName: "Haiku 4.5", description: "Haiku 4.5 · Fastest for quick answers" },
];

const AGENTS: AgentInfo[] = [
  { name: "general-purpose", description: "General-purpose agent for researching complex questions and executing multi-step tasks", model: "inherit" },
  { name: "Explore", description: "Fast agent for exploring codebases: find files, search code, answer questions", model: "haiku" },
  { name: "code-reviewer", description: "Reviews code for bugs, logic errors and adherence to project conventions", model: "sonnet" },
];

const ACCOUNT: AccountInfo = {
  email: "you@example.com",
  organization: "Personal",
  subscriptionType: "max",
  tokenSource: "claude.ai",
  apiKeySource: "none",
  apiProvider: "firstParty",
};

const TOOLS = ["Task", "Bash", "Glob", "Grep", "ExitPlanMode", "Read", "Edit", "Write", "NotebookEdit", "WebFetch", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "WebSearch", "AskUserQuestion", "mcp__linear__list_issues", "mcp__context7__query-docs"];
const SKILLS = ["commit-commands:commit", "frontend-design:frontend-design", "deploy"];
const PLUGINS = [
  { name: "commit-commands", path: `${STUB_PATH}/commit-commands`, version: "1.4.0" },
  { name: "frontend-design", path: `${STUB_PATH}/frontend-design`, version: "0.9.2" },
];

const MCP_SERVERS: McpServerStatus[] = [
  {
    name: "linear",
    status: "connected",
    serverInfo: { name: "linear", version: "1.2.0" },
    scope: "user",
    tools: ["list_issues", "get_issue", "save_issue", "save_comment", "list_projects", "list_teams"].map((name) => ({ name, description: `Linear ${name.replace("_", " ")}` })),
  },
  {
    name: "context7",
    status: "connected",
    serverInfo: { name: "context7", version: "2.0.1" },
    scope: "user",
    tools: [{ name: "resolve-library-id" }, { name: "query-docs" }],
  },
  { name: "sentry", status: "failed", scope: "project", error: "Connection closed before the server answered (spawn npx ENOENT)", tools: [] },
];

/* ---- The showcase project (turn 1) ---- */

const WORKER_LINES = [
  'import type { Scheduler } from "./scheduler";',
  'import type { Job, JobResult } from "./types";',
  "",
  "const DRAIN_INTERVAL_MS = 50;",
  "",
  "export class Worker {",
  "  private queue: Job[] = [];",
  "  private running = 0;",
  "  private draining = false;",
  "  private timer: ReturnType<typeof setTimeout> | undefined;",
  "",
  "  constructor(",
  "    private readonly scheduler: Scheduler,",
  "    private readonly concurrency = 4,",
  "  ) {}",
  "",
  "  push(job: Job): void {",
  "    this.queue.push(job);",
  "    this.schedule();",
  "  }",
  "",
  "  private schedule(): void {",
  "    if (this.timer) return;",
  "    this.timer = setTimeout(() => this.drain(), DRAIN_INTERVAL_MS);",
  "  }",
  "",
  "  async drain(): Promise<void> {",
  "    this.timer = undefined;",
  "    if (this.draining) return;",
  "    this.draining = true;",
  "    while (this.queue.length > 0 && this.running < this.concurrency) {",
  "      const job = this.queue.shift()!;",
  "      this.running++;",
  "      this.run(job).finally(() => this.running--);",
  "    }",
  "    this.draining = false;",
  "    if (this.queue.length > 0) this.schedule();",
  "  }",
  "",
  "  private async run(job: Job): Promise<JobResult> {",
  "    const result = await this.scheduler.execute(job);",
  "    return result;",
  "  }",
  "",
  "  close(): void {",
  "    if (this.timer) clearTimeout(this.timer);",
  "    this.queue.length = 0;",
  "  }",
  "}",
];
const EDIT_OLD = ["      this.running++;", "      this.run(job).finally(() => this.running--);", "    }", "    this.draining = false;"];
const EDIT_NEW = ["      this.running++;", "      void this.run(job).finally(() => {", "        this.running--;", "        this.schedule();", "      });", "    }", "    this.draining = false;"];
const SCHEDULER_LINES = [
  'import type { Job, JobResult } from "./types";',
  "",
  "export class Scheduler {",
  "  private delays = new Map<string, ReturnType<typeof setTimeout>>();",
  "",
  "  async execute(job: Job): Promise<JobResult> {",
  "    await new Promise<void>((resolve) => setTimeout(resolve, job.delayMs ?? 0));",
  "    return job.run();",
  "  }",
  "",
  "  cancel(id: string): void {",
  "    clearTimeout(this.delays.get(id));",
  "  }",
  "}",
];
const TEST_NAMES = [
  "runs queued jobs in order",
  "respects the concurrency limit",
  "retries a failed job once",
  "drains jobs pushed while another drain is running",
  "stops cleanly on close()",
  "ignores jobs pushed after close()",
  "reports the queue length",
  "passes the job id to the scheduler",
];

/* ---- Small helpers ---- */

class BridgeFail extends Error {
  constructor(
    message: string,
    readonly code: BridgeError["code"],
  ) {
    super(message);
  }
}

const rnd = (min: number, max: number) => min + Math.random() * (max - min);
const rid = (prefix: string) => prefix + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
const uuid = () => crypto.randomUUID();
const tokensOf = (text: string) => Math.max(1, Math.ceil(text.length / 3.6));
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const catN = (lines: string[], start = 1) => lines.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join("\n");
const record = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {});

function readSpeed(): number {
  try {
    return Number(globalThis.localStorage?.getItem("midterm.claudeMockSpeed")) || 1;
  } catch {
    return 1;
  }
}

/** Splits text into 2-4 word chunks, keeping all whitespace. */
function wordChunks(text: string): string[] {
  const words = text.match(/\S+\s*/g) ?? [];
  const out: string[] = [];
  for (let i = 0, step = 2; i < words.length; i += step, step = 2 + (out.length % 3)) out.push(words.slice(i, i + step).join(""));
  return out;
}

function fragments(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    const n = Math.floor(rnd(8, 17));
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

/** A structuredPatch hunk for replacing `oldLines` at 0-based `at` in `file`, with 3 lines of context. */
function structuredPatch(file: string[], at: number, oldLines: string[], newLines: string[]) {
  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (suf < oldLines.length - pre && suf < newLines.length - pre && oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]) suf++;
  const oldMid = oldLines.slice(pre, oldLines.length - suf);
  const newMid = newLines.slice(pre, newLines.length - suf);
  const start = at + pre;
  const before = file.slice(Math.max(0, start - 3), start);
  const after = file.slice(at + oldLines.length - suf, at + oldLines.length - suf + 3);
  const lines = [...before.map((l) => ` ${l}`), ...oldMid.map((l) => `-${l}`), ...newMid.map((l) => `+${l}`), ...after.map((l) => ` ${l}`)];
  const oldStart = start - before.length + 1;
  return [
    {
      oldStart,
      oldLines: before.length + oldMid.length + after.length,
      newStart: oldStart,
      newLines: before.length + newMid.length + after.length,
      lines,
    },
  ];
}

function testOutput(cwd: string, failing: boolean): string {
  const lines = ["bun test v1.2.8 (4a1c0f7e)", "", "src/queue/worker.test.ts:"];
  TEST_NAMES.forEach((name, i) => {
    if (failing && i === 3) {
      lines.push(
        " 53 |     for (let i = 0; i < 8; i++) worker.push(job(i));",
        " 54 |     await sleep(200);",
        " 55 |     expect(done).toHaveLength(8);",
        "                       ^",
        "error: expect(received).toHaveLength(expected)",
        "",
        "Expected length: 8",
        "Received length: 6",
        "",
        `      at <anonymous> (${cwd}/src/queue/worker.test.ts:55:19)`,
        `(fail) Worker > ${name} [201.55ms]`,
      );
    } else lines.push(`(pass) Worker > ${name} [${rnd(0.5, 12).toFixed(2)}ms]`);
  });
  lines.push("", failing ? " 7 pass" : " 8 pass", failing ? " 1 fail" : " 0 fail", failing ? " 17 expect() calls" : " 19 expect() calls", `Ran 8 tests across 1 file. [${failing ? 231 : 254}.00ms]`);
  return lines.join("\n");
}

/* ---- Session state ---- */

type Session = {
  key: string;
  /** This session's MCP servers (toggles and reconnects change them). */
  mcp: McpServerStatus[];
  cwd: string;
  sessionId: string;
  model: string;
  effort: EffortLevel | null;
  mode: PermissionMode;
  turns: number;
  turn?: Turn;
  queue: { text: string; uuid: string }[];
  /** Estimated context tokens (what the last API message would have read). */
  ctx: number;
  messageTokens: number;
  usage: Record<string, ModelUsage>;
  durationMs: number;
  apiMs: number;
  linesAdded: number;
  linesRemoved: number;
  perms: Map<string, (result: PermissionResult) => void>;
  tasks: Map<string, { stopped: boolean; stop(): void }>;
  closed: boolean;
};

function newUsage(window = 200000): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: window, maxOutputTokens: 64000 };
}

const totalCost = (s: Session) => Object.values(s.usage).reduce((sum, u) => sum + u.costUSD, 0);
const modelId = (s: Session) => ({ sonnet: "claude-sonnet-5", haiku: HAIKU }[s.model] ?? OPUS);

type Block =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Json };

const tool = (name: string, input: Json): Extract<Block, { type: "tool_use" }> => ({ type: "tool_use", id: rid("toolu_"), name, input });

/* ---- A playing turn ---- */

/** One turn of a session: a cancellable timeline plus helpers that emit SDK messages. */
class Turn {
  aborted = false;
  readonly open = new Map<string, string | null>(); // tool_use id -> parent tool_use id
  permId?: string;
  private waiters = new Set<{ cancel(): void }>();
  private speed = readSpeed();
  private readonly t0 = performance.now();
  private stampedAssistant = false;
  private stampedStream = false;
  private added: number;
  private apiCount = 0;
  private readonly tot = { input: 0, output: 0, read: 0, create: 0 };

  constructor(
    readonly s: Session,
    readonly uuid: string,
    private readonly write: (event: Json) => void,
  ) {
    this.added = s.turns === 0 ? 24000 : 1500;
  }

  /** Cancellable sleep (scaled by the speed); rejects with ABORT once the turn is cancelled. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.aborted) return reject(ABORT);
      const waiter = {
        cancel: () => {
          clearTimeout(handle);
          reject(ABORT);
        },
      };
      const handle = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve();
      }, ms / this.speed);
      this.waiters.add(waiter);
    });
  }

  /** Calls `fn` every `ms` until the returned stop function runs or the turn is cancelled. */
  every(ms: number, fn: () => void): () => void {
    let handle: ReturnType<typeof setTimeout>;
    const waiter = { cancel: () => clearTimeout(handle) };
    const tick = () => {
      fn();
      handle = setTimeout(tick, ms / this.speed);
    };
    handle = setTimeout(tick, ms / this.speed);
    this.waiters.add(waiter);
    return () => {
      waiter.cancel();
      this.waiters.delete(waiter);
    };
  }

  cancel(): void {
    this.aborted = true;
    for (const waiter of [...this.waiters]) waiter.cancel();
    this.waiters.clear();
  }

  /** Emits an SDK message of this session. */
  msg(message: Json): void {
    this.write({ event: "message", session: this.s.key, message: { uuid: uuid(), session_id: this.s.sessionId, ...message } });
  }

  private stamp(kind: "assistant" | "stream"): Json {
    if (kind === "assistant" ? this.stampedAssistant : this.stampedStream) return {};
    if (kind === "assistant") this.stampedAssistant = true;
    else this.stampedStream = true;
    return { user_message_uuid: this.uuid, user_message_uuids: [this.uuid] };
  }

  status(status: "requesting" | "compacting" | null, extra: Json = {}): void {
    this.msg({ type: "system", subtype: "status", status, ...extra });
  }

  init(): void {
    const s = this.s;
    this.msg({
      type: "system",
      subtype: "init",
      cwd: s.cwd,
      model: modelId(s),
      permissionMode: s.mode,
      tools: TOOLS,
      mcp_servers: s.mcp.map((m) => ({ name: m.name, status: m.status })),
      slash_commands: COMMANDS.map((c) => c.name),
      skills: SKILLS,
      plugins: PLUGINS,
      agents: AGENTS.map((a) => a.name),
      claude_code_version: CC_VERSION,
      apiKeySource: "none",
      output_style: "default",
    });
    this.status("requesting");
    if (s.turns === 0) {
      this.msg({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: Math.floor((Date.now() + 3.2 * 3600e3) / 1000), rateLimitType: "five_hour", utilization: 0.34 } });
    }
  }

  /**
   * Streams one API message (stream events plus an `assistant` message after
   * each finished block). `pad` stands for context the mock does not model
   * (thinking, schemas, hidden results).
   */
  async api(blocks: Block[], opts: { stop?: "tool_use" | "end_turn"; pad?: number } = {}): Promise<void> {
    const s = this.s;
    const id = rid("msg_");
    const model = modelId(s);
    const input = 4 + Math.floor(rnd(0, 6));
    const created = Math.min(this.added, s.ctx);
    const usage = { input_tokens: input, cache_read_input_tokens: Math.max(0, s.ctx - created - input), cache_creation_input_tokens: created, output_tokens: 1 };
    this.added = 0;
    this.apiCount++;
    const stop = opts.stop ?? (blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
    const stream = (event: Json) => this.msg({ type: "stream_event", event, parent_tool_use_id: null, ...this.stamp("stream") });
    stream({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } });
    let out = 0;
    for (const [index, block] of blocks.entries()) {
      const start =
        block.type === "thinking"
          ? { type: "thinking", thinking: "", signature: "" }
          : block.type === "text"
            ? { type: "text", text: "" }
            : { type: "tool_use", id: block.id, name: block.name, input: {} };
      stream({ type: "content_block_start", index, content_block: start });
      const parts = block.type === "tool_use" ? fragments(JSON.stringify(block.input)) : wordChunks(block.text);
      for (const part of parts) {
        await this.wait(block.type === "tool_use" ? rnd(15, 30) : rnd(30, 60));
        const delta = block.type === "thinking" ? { type: "thinking_delta", thinking: part } : block.type === "text" ? { type: "text_delta", text: part } : { type: "input_json_delta", partial_json: part };
        stream({ type: "content_block_delta", index, delta });
      }
      stream({ type: "content_block_stop", index });
      const done =
        block.type === "thinking"
          ? { type: "thinking", thinking: block.text, signature: "Eo8CCkYICxgCKkB" + rid("") }
          : block.type === "text"
            ? { type: "text", text: block.text }
            : { type: "tool_use", id: block.id, name: block.name, input: block.input };
      out += tokensOf(block.type === "tool_use" ? JSON.stringify(block.input) : block.text);
      this.msg({
        type: "assistant",
        message: { id, type: "message", role: "assistant", model, content: [done], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: out } },
        parent_tool_use_id: null,
        ...this.stamp("assistant"),
      });
      if (block.type === "tool_use") this.open.set(block.id, null);
    }
    stream({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: out } });
    stream({ type: "message_stop" });
    this.tot.input += usage.input_tokens;
    this.tot.read += usage.cache_read_input_tokens;
    this.tot.create += usage.cache_creation_input_tokens;
    this.tot.output += out;
    s.ctx += out + (opts.pad ?? 2800);
    this.added += out + (opts.pad ?? 2800);
  }

  /** A subagent's message: not streamed, one block, its own message id. */
  sub(parent: string, block: Block): void {
    const usage = { input_tokens: 6, cache_read_input_tokens: 9000, cache_creation_input_tokens: 800, output_tokens: 120 };
    const content =
      block.type === "tool_use" ? { type: "tool_use", id: block.id, name: block.name, input: block.input } : block.type === "text" ? { type: "text", text: block.text } : { type: "thinking", thinking: block.text, signature: "" };
    this.msg({
      type: "assistant",
      message: { id: rid("msg_"), type: "message", role: "assistant", model: HAIKU, content: [content], stop_reason: null, stop_sequence: null, usage },
      parent_tool_use_id: parent,
    });
    if (block.type === "tool_use") this.open.set(block.id, parent);
  }

  /** A tool_result `user` message. */
  result(toolUseId: string, content: string, structured: unknown, opts: { isError?: boolean; parent?: string | null; count?: boolean } = {}): void {
    this.open.delete(toolUseId);
    this.msg({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...(opts.isError ? { is_error: true } : {}) }] },
      parent_tool_use_id: opts.parent ?? null,
      tool_use_result: structured,
    });
    if (!opts.parent) {
      this.s.ctx += tokensOf(content);
      this.added += tokensOf(content);
    }
  }

  progress(toolUseId: string, toolName: string, seconds: number, parent: string | null = null): void {
    this.msg({ type: "tool_progress", tool_use_id: toolUseId, tool_name: toolName, parent_tool_use_id: parent, elapsed_time_seconds: seconds });
  }

  /** Runs `fn` while emitting tool_progress every 0.5 s for `ms`. */
  async longRunning(toolUseId: string, toolName: string, ms: number): Promise<void> {
    let seconds = 0;
    const stop = this.every(500, () => this.progress(toolUseId, toolName, (seconds += 0.5)));
    try {
      await this.wait(ms);
    } finally {
      stop();
    }
  }

  /** Emits the prompt and waits for the answer from `session.permission`. */
  ask(request: Omit<PermissionRequest, "requestId">): Promise<PermissionResult> {
    return new Promise((resolve, reject) => {
      if (this.aborted) return reject(ABORT);
      const requestId = rid("perm_");
      this.permId = requestId;
      const waiter = {
        cancel: () => {
          this.s.perms.delete(requestId);
          reject(ABORT);
        },
      };
      this.waiters.add(waiter);
      this.s.perms.set(requestId, (result) => {
        this.s.perms.delete(requestId);
        this.waiters.delete(waiter);
        this.permId = undefined;
        resolve(result);
      });
      this.write({ event: "permission", session: this.s.key, request: { requestId, ...request } });
    });
  }

  /** Ends the turn with a `result` message, cumulative cost and usage, and `status: null`. */
  finish(text: string, o: { cost: number; extra?: Json; numTurns?: number; haikuTokens?: number }): void {
    const s = this.s;
    const opus = (s.usage[modelId(s)] ??= newUsage());
    opus.inputTokens += this.tot.input;
    opus.outputTokens += this.tot.output;
    opus.cacheReadInputTokens += this.tot.read;
    opus.cacheCreationInputTokens += this.tot.create;
    opus.costUSD += o.cost;
    const haiku = (s.usage[HAIKU] ??= newUsage());
    const haikuIn = o.haikuTokens ?? 900;
    haiku.inputTokens += haikuIn;
    haiku.outputTokens += Math.round(haikuIn / 20);
    haiku.costUSD += haikuIn * 1e-6 + (haikuIn / 20) * 5e-6;
    const duration = Math.round(performance.now() - this.t0);
    s.durationMs += duration;
    s.apiMs += Math.round(duration * 0.7);
    s.turns++;
    s.messageTokens = Math.max(0, s.ctx - BASE_CONTEXT);
    this.msg({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: duration,
      duration_api_ms: Math.round(duration * 0.7),
      num_turns: o.numTurns ?? this.apiCount,
      result: text,
      stop_reason: "end_turn",
      total_cost_usd: totalCost(s),
      usage: {
        input_tokens: this.tot.input,
        output_tokens: this.tot.output,
        cache_read_input_tokens: this.tot.read,
        cache_creation_input_tokens: this.tot.create,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: "standard",
      },
      modelUsage: JSON.parse(JSON.stringify(s.usage)),
      permission_denials: [],
      ...o.extra,
    });
    this.status(null);
  }
}

/* ---- Turn scripts ---- */

const permissionPrompt = (toolName: string, input: Json, toolUseId: string, extra: Partial<PermissionRequest> = {}) => ({ toolName, input, toolUseId, displayName: toolName, ...extra });

async function showcaseTurn(t: Turn): Promise<void> {
  const { s } = t;
  const cwd = s.cwd;
  const workerPath = `${cwd}/src/queue/worker.ts`;
  const plan = [
    { subject: "Reproduce the flaky queue test", activeForm: "Reproducing the flaky queue test", description: "Run bun test on src/queue and capture the failure." },
    { subject: "Find the race in the worker drain loop", activeForm: "Finding the race in the worker drain loop", description: "Read worker.ts and look for state shared with timers." },
    { subject: "Fix it and re-run the tests", activeForm: "Fixing it and re-running the tests", description: "Change drain() and run the suite again." },
    { subject: "Check other timers for the same pattern", activeForm: "Checking other timers for the same pattern", description: "Grep the queue module for setTimeout." },
  ];
  /** TaskUpdate calls setting each task id to its status, with their results. */
  const updates = async (changes: [string, "pending" | "in_progress" | "completed"][]) => {
    const calls = changes.map(([taskId, status]) => tool("TaskUpdate", { taskId, status }));
    await t.api(calls);
    calls.forEach((call, index) => {
      const [taskId, to] = changes[index];
      t.result(call.id, `Updated task #${taskId} status`, { success: true, taskId, updatedFields: ["status"], statusChange: { from: "pending", to } });
    });
  };

  // 1. Run the tests.
  const bash1 = tool("Bash", { command: "bun test src/queue", description: "Run the queue tests" });
  await t.api([
    { type: "thinking", text: "The user reports a flaky test in the queue module. Before changing anything I should reproduce the failure and see which test fails. The test file sits next to the worker, so running bun test on src/queue is the quickest way to find out." },
    { type: "text", text: "I'll start by running the test suite to see the failure." },
    bash1,
  ]);
  await t.longRunning(bash1.id, "Bash", 2000);
  const out1 = testOutput(cwd, true);
  t.result(bash1.id, `Exit code 1\n${out1}`, { stdout: out1, stderr: "", interrupted: false }, { isError: true });

  // 2. Read the worker and look for timers.
  const read = tool("Read", { file_path: workerPath });
  const grep = tool("Grep", { pattern: "setTimeout\\(", path: "src", output_mode: "files_with_matches" });
  await t.api([{ type: "text", text: "The failing test pushes jobs while a drain is running. Let me read the worker and check where timers are used." }, read, grep]);
  await t.wait(200);
  t.result(read.id, catN(WORKER_LINES), {
    type: "text",
    file: { filePath: workerPath, content: WORKER_LINES.join("\n"), numLines: WORKER_LINES.length, startLine: 1, totalLines: WORKER_LINES.length },
  });
  const files = ["src/queue/worker.ts", "src/queue/scheduler.ts", "src/queue/retry.ts"];
  t.result(grep.id, `Found 3 files\n${files.join("\n")}`, { mode: "files_with_matches", numFiles: 3, filenames: files });

  // 3. Todo list.
  const creates = plan.map((task) => tool("TaskCreate", task));
  await t.api(creates);
  creates.forEach((call, index) => {
    const id = String(index + 1);
    t.result(call.id, `Task #${id} created successfully: ${plan[index].subject}`, { task: { id, subject: plan[index].subject } });
  });
  await updates([
    ["1", "completed"],
    ["2", "in_progress"],
  ]);

  // 4. A subagent.
  await subagentTurn(t);

  // 5. The edit.
  const at = WORKER_LINES.indexOf(EDIT_OLD[0]);
  const edit = tool("Edit", { file_path: workerPath, old_string: EDIT_OLD.join("\n"), new_string: EDIT_NEW.join("\n") });
  await t.api([
    { type: "text", text: "The race is in `drain()`: `this.draining` is cleared while jobs are still in flight, and when one of them finishes nothing schedules another pass. Jobs pushed during a drain can sit in the queue forever." },
    edit,
  ]);
  await t.wait(250);
  s.linesAdded += 3;
  s.linesRemoved += 1;
  t.result(edit.id, `The file ${workerPath} has been updated successfully.`, {
    filePath: workerPath,
    oldString: EDIT_OLD.join("\n"),
    newString: EDIT_NEW.join("\n"),
    originalFile: WORKER_LINES.join("\n"),
    structuredPatch: structuredPatch(WORKER_LINES, at, EDIT_OLD, EDIT_NEW),
    userModified: false,
    replaceAll: false,
  });

  // 6. A command that needs permission.
  const command = "rm -rf .cache/test && bun test src/queue";
  const bash2 = tool("Bash", { command, description: "Clear the test cache and re-run" });
  await t.api([{ type: "text", text: "Now I'll clear the test cache and run the suite again." }, bash2]);
  let allowed = true;
  let denial = "";
  if (s.mode !== "bypassPermissions") {
    const result = await t.ask(
      permissionPrompt("Bash", bash2.input, bash2.id, {
        title: `Claude wants to run ${command}`,
        description: "Clear the test cache and re-run",
        decisionReason: "This command deletes files (rm -rf)",
        suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun test:*" }], behavior: "allow", destination: "localSettings" }],
      }),
    );
    allowed = result.behavior === "allow";
    if (!allowed) denial = result.behavior === "deny" && result.message ? result.message : "The user doesn't want to proceed with this tool use. The tool use was rejected.";
  }
  if (!allowed) {
    t.result(bash2.id, denial, denial, { isError: true });
    await t.api([{ type: "text", text: "Understood, I won't clear the cache. The fix is in `src/queue/worker.ts`; run `bun test src/queue` when you're ready to confirm it." }]);
    t.finish("Understood, I won't clear the cache.", { cost: 0.31 });
    return;
  }
  await t.longRunning(bash2.id, "Bash", 1500);
  const out2 = testOutput(cwd, false);
  t.result(bash2.id, out2, { stdout: out2, stderr: "", interrupted: false });

  // 7. Wrap up.
  await updates([
    ["2", "completed"],
    ["3", "completed"],
    ["4", "completed"],
  ]);
  const answer =
    "The flaky test is fixed. The cause was a race in `Worker.drain()`: a job that finished while the queue still held work never triggered another pass, so jobs pushed during a drain could stall.\n\n" +
    "- `src/queue/worker.ts` now calls `schedule()` as each job settles, so leftovers are always picked up\n" +
    "- all 8 tests in `src/queue/worker.test.ts` pass, 0 failures\n" +
    "- `scheduler.ts` and `retry.ts` use timers too, but without the shared `draining` flag, so they are not affected\n\n" +
    "```ts\nvoid this.run(job).finally(() => {\n  this.running--;\n  this.schedule();\n});\n```";
  await t.api([{ type: "text", text: answer }], { stop: "end_turn" });
  t.finish(answer, { cost: 0.4, haikuTokens: 18400 });
}

/** API message 4 of the showcase: the Agent tool with a streamed-less subagent. */
async function subagentTurn(t: Turn): Promise<void> {
  const { s } = t;
  const agent = tool("Agent", {
    description: "Find other timer races",
    prompt: "Look through src/queue for other uses of setTimeout/setInterval that share state with an in-flight async operation, and report any that could race the way Worker.drain() does. Do not edit files.",
    subagent_type: "Explore",
  });
  await t.api([{ type: "text", text: "Let me have a subagent check the rest of the queue module for the same pattern while I look at the fix." }, agent]);
  const taskId = rid("task_");
  const started = performance.now();
  const task = {
    stopped: false,
    stop() {
      if (task.stopped) return;
      task.stopped = true;
      t.msg({ type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: agent.id, status: "stopped", summary: "Find other timer races", output_file: `/tmp/claude/${taskId}.output`, usage: usage() });
    },
  };
  s.tasks.set(taskId, task);
  let tokens = 6200;
  let toolUses = 0;
  let lastTool = "";
  let summary = "Starting";
  function usage() {
    return { total_tokens: tokens, tool_uses: toolUses, duration_ms: Math.round(performance.now() - started) };
  }
  t.msg({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: agent.id, description: "Find other timer races", subagent_type: "Explore", task_type: "local_agent", prompt: agent.input.prompt });
  let seconds = 0;
  const stopAgent = t.every(500, () => t.progress(agent.id, "Agent", (seconds += 0.5)));
  let ticks = 0;
  const stopTask = t.every(1000, () =>
    t.msg({ type: "system", subtype: "task_progress", task_id: taskId, tool_use_id: agent.id, description: "Find other timer races", subagent_type: "Explore", usage: usage(), last_tool_name: lastTool || undefined, summary: `${summary}${".".repeat(1 + (ticks++ % 3))}` }),
  );
  const report =
    "- `src/queue/scheduler.ts` `execute()` waits on a `setTimeout` without storing the handle, so `cancel()` can never clear it. A cancelled job still runs.\n" +
    "- `src/queue/retry.ts` re-arms its backoff timer inside the failure handler; two failures close together schedule two retries for the same job.\n" +
    "- `worker.ts` `close()` clears `timer` but not an in-flight `drain()`, which can push into a closed worker.";
  try {
    const step = async (block: Block, ms: number, then?: () => void) => {
      if (task.stopped) return;
      t.sub(agent.id, block);
      await t.wait(ms);
      if (block.type === "tool_use") {
        toolUses++;
        lastTool = block.name;
      }
      tokens += Math.round(rnd(2200, 4800));
      then?.();
    };
    await step({ type: "text", text: "Searching for timer usage across the queue module…" }, 700);
    const g = tool("Grep", { pattern: "setTimeout|setInterval", path: "src/queue", output_mode: "content" });
    summary = "Searching src/queue for timers";
    const grepOut = 'src/queue/worker.ts:24:    this.timer = setTimeout(() => this.drain(), DRAIN_INTERVAL_MS);\nsrc/queue/scheduler.ts:7:    await new Promise<void>((resolve) => setTimeout(resolve, job.delayMs ?? 0));\nsrc/queue/retry.ts:18:    setTimeout(() => this.attempt(job), backoff(job.attempts));';
    await step(g, 800, () => t.result(g.id, grepOut, { mode: "content", numFiles: 3, filenames: [], content: grepOut, numLines: 3 }, { parent: agent.id }));
    const r = tool("Read", { file_path: `${s.cwd}/src/queue/scheduler.ts` });
    summary = "Reading src/queue/scheduler.ts";
    await step(r, 900, () =>
      t.result(r.id, catN(SCHEDULER_LINES), { type: "text", file: { filePath: `${s.cwd}/src/queue/scheduler.ts`, content: SCHEDULER_LINES.join("\n"), numLines: SCHEDULER_LINES.length, startLine: 1, totalLines: SCHEDULER_LINES.length } }, { parent: agent.id }),
    );
    const gl = tool("Glob", { pattern: "src/queue/**/*.ts" });
    summary = "Listing src/queue";
    const globbed = ["src/queue/worker.ts", "src/queue/worker.test.ts", "src/queue/scheduler.ts", "src/queue/retry.ts", "src/queue/types.ts"];
    await step(gl, 800, () => t.result(gl.id, globbed.join("\n"), { filenames: globbed, durationMs: 12, numFiles: globbed.length, truncated: false }, { parent: agent.id }));
    summary = "Writing the report";
    await step({ type: "text", text: `Found three other timer hazards:\n\n${report}` }, 600);
  } finally {
    stopAgent();
    stopTask();
  }
  s.tasks.delete(taskId);
  const final = task.stopped ? "The subagent was stopped before it finished." : `Found three other timer hazards:\n\n${report}`;
  if (!task.stopped) t.msg({ type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: agent.id, status: "completed", summary: "Find other timer races", output_file: `/tmp/claude/${taskId}.output`, usage: usage() });
  const u = usage();
  t.result(agent.id, final, {
    status: "completed",
    agentId: taskId,
    agentType: "Explore",
    content: [{ type: "text", text: final }],
    totalToolUseCount: u.tool_uses,
    totalDurationMs: u.duration_ms,
    totalTokens: u.total_tokens,
    usage: { input_tokens: u.total_tokens - 900, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: "standard", cache_creation: null },
    prompt: agent.input.prompt,
  });
}

async function planTurn(t: Turn): Promise<void> {
  const plan = "## Plan\n\n1. Add a `JobStore` interface and move the in-memory array in `worker.ts` behind it\n2. Persist queued jobs to disk on `push()` and restore them in the constructor\n3. Make `drain()` ack a job only after it settles successfully\n4. Cover restart recovery and double delivery in `worker.test.ts`";
  const exit = tool("ExitPlanMode", { plan });
  await t.api([
    { type: "thinking", text: "The request touches the queue's storage and its delivery guarantees. A plan should keep the change small: an interface first, then persistence, then acknowledgements, then tests." },
    exit,
  ]);
  const result = await t.ask(permissionPrompt("ExitPlanMode", exit.input, exit.id, { title: "Claude has a plan ready", displayName: "Plan" }));
  if (result.behavior === "allow") {
    t.result(exit.id, "User has approved your plan. You can now start coding. Start with updating your todo list if applicable", { plan, isAgent: false });
    const text = "Plan approved. I'll begin with the `JobStore` interface in `src/queue/store.ts`.";
    await t.api([{ type: "text", text }]);
    t.finish(text, { cost: 0.07 });
  } else {
    const message = result.message || "The user doesn't want to proceed with this tool use. The tool use was rejected.";
    t.result(exit.id, message, message, { isError: true });
    await t.api([{ type: "text", text: "OK, let's keep planning." }]);
    t.finish("OK, let's keep planning.", { cost: 0.05 });
  }
}

async function askTurn(t: Turn): Promise<void> {
  const opt = (label: string, description: string) => ({ label, description });
  const input = {
    questions: [
      { question: "Which test runner should the fix target?", header: "Runner", multiSelect: false, options: [opt("bun test", "The runner the project already uses"), opt("vitest", "Better watch mode, needs a config"), opt("node:test", "No dependency, fewer matchers")] },
      { question: "Which extras do you want?", header: "Extras", multiSelect: true, options: [opt("Regression test", "Add a test that reproduces the race"), opt("Stress script", "Loop the suite 200 times in CI"), opt("Docs note", "Mention the fix in docs/queue.md")] },
    ],
  };
  const ask = tool("AskUserQuestion", input);
  await t.api([{ type: "thinking", text: "The right fix depends on the runner, and there are a few optional extras. Asking is cheaper than guessing wrong." }, ask]);
  const result = await t.ask(permissionPrompt("AskUserQuestion", input, ask.id, { title: "Claude has questions", displayName: "Question" }));
  if (result.behavior !== "allow") {
    const message = result.message || "The user doesn't want to proceed with this tool use. The tool use was rejected.";
    t.result(ask.id, message, message, { isError: true });
    await t.api([{ type: "text", text: "No problem, I'll skip the questions." }]);
    t.finish("No problem, I'll skip the questions.", { cost: 0.05 });
    return;
  }
  const answers = record(result.updatedInput?.answers);
  const entries = Object.entries(answers).map(([q, a]) => [q, String(a)] as const);
  t.result(ask.id, `User has answered your questions: ${entries.map(([q, a]) => `"${q}"="${a}"`).join(", ")}. You can now continue with the user's answers in mind.`, { questions: input.questions, answers });
  const text = entries.length ? `Got it:\n\n${entries.map(([q, a]) => `- ${q} **${a}**`).join("\n")}\n\nI'll proceed on that basis.` : "Got it, I'll proceed with sensible defaults.";
  await t.api([{ type: "text", text }]);
  t.finish(text, { cost: 0.06 });
}

async function failTurn(t: Turn): Promise<void> {
  const bash = tool("Bash", { command: "bun run build", description: "Build the project" });
  // Thinking whose text the CLI omits (display: "omitted"): blank blocks, shown as one quiet line.
  await t.api([{ type: "thinking", text: "" }, { type: "thinking", text: "" }, { type: "text", text: "Let me run the build to see what is failing." }, bash]);
  await t.longRunning(bash.id, "Bash", 1200);
  const stderr = `src/queue/worker.ts(41,7): error TS2322: Type 'Promise<JobResult>' is not assignable to type 'JobResult'.\nsrc/queue/worker.ts(44,5): error TS2304: Cannot find name 'retryJob'.\nFound 2 errors.`;
  t.result(bash.id, `Exit code 2\n${stderr}`, { stdout: "", stderr, interrupted: false }, { isError: true });
  t.msg({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 2000, error_status: 529, error: "overloaded" });
  await t.wait(2000);
  const text = "The build fails with two type errors in `src/queue/worker.ts`: line 41 returns a `Promise<JobResult>` where a `JobResult` is expected (missing `await`), and line 44 calls `retryJob`, which is not imported.";
  await t.api([{ type: "text", text }]);
  t.finish(text, { cost: 0.08 });
}

async function genericTurn(t: Turn, prompt: string): Promise<void> {
  const grep = tool("Grep", { pattern: "export (class|function)", path: "src", output_mode: "files_with_matches" });
  await t.api([{ type: "thinking", text: "Let me look at how the code is organized before I answer. A quick search for exported symbols should show where the relevant pieces live, and then I can read the most likely file." }, grep]);
  await t.wait(200);
  const files = ["src/queue/worker.ts", "src/queue/scheduler.ts", "src/queue/retry.ts"];
  t.result(grep.id, `Found 3 files\n${files.join("\n")}`, { mode: "files_with_matches", numFiles: 3, filenames: files });
  const read = tool("Read", { file_path: `${t.s.cwd}/src/queue/scheduler.ts` });
  await t.api([{ type: "text", text: "The scheduler is the main entry point, so I'll read it." }, read]);
  await t.wait(200);
  t.result(read.id, catN(SCHEDULER_LINES), { type: "text", file: { filePath: `${t.s.cwd}/src/queue/scheduler.ts`, content: SCHEDULER_LINES.join("\n"), numLines: SCHEDULER_LINES.length, startLine: 1, totalLines: SCHEDULER_LINES.length } });
  const quoted = prompt.length > 80 ? `${prompt.slice(0, 77)}…` : prompt;
  const text =
    `You asked: "${quoted}". Here is how the queue module is laid out and how I'd approach it.\n\n` +
    "The module is small and split by responsibility: the worker owns the queue and concurrency, the scheduler runs a single job after its delay, and the retry helper decides when a failed job is tried again. Nothing outside `src/queue/` touches the timers directly, so changes stay local.\n\n" +
    "| File | Role | Timers |\n| --- | --- | --- |\n| `worker.ts` | Queue and drain loop | 1 |\n| `scheduler.ts` | Runs one job | 1 |\n| `retry.ts` | Backoff | 1 |\n\n" +
    "I'd start in `scheduler.ts`: it is the smallest file, and any change there is covered by the existing worker tests. Tell me if you want me to go ahead.";
  await t.api([{ type: "text", text }], { stop: "end_turn" });
  t.finish(text, { cost: 0.05 + rnd(0, 0.1) });
}

/** `/cost`, `/context` and similar: local output and a result without a model call. */
function localCommand(t: Turn, content: string): void {
  t.msg({ type: "system", subtype: "local_command_output", content });
  t.finish("", { cost: 0, numTurns: 0, haikuTokens: 0 });
}

async function compactTurn(t: Turn): Promise<void> {
  const { s } = t;
  const pre = s.ctx;
  t.status("compacting");
  await t.wait(1500);
  s.ctx = BASE_CONTEXT + 6000;
  t.msg({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: pre, post_tokens: s.ctx, duration_ms: 1500 } });
  t.status(null, { compact_result: "success" });
  t.finish("", { cost: 0.03, numTurns: 0, haikuTokens: 0 });
}

async function playTurn(t: Turn, text: string): Promise<void> {
  const lower = text.trim().toLowerCase();
  if (lower.startsWith("/compact") || /\bcompact\b/.test(lower)) return compactTurn(t);
  if (lower.startsWith("/cost") || lower.startsWith("/usage")) {
    const s = t.s;
    return localCommand(t, `Total cost:            $${totalCost(s).toFixed(2)}\nTotal duration (API):  ${(s.apiMs / 1000).toFixed(1)}s\nTotal duration (wall): ${(s.durationMs / 1000).toFixed(1)}s\nTotal code changes:    ${s.linesAdded} lines added, ${s.linesRemoved} lines removed`);
  }
  if (lower.startsWith("/context")) {
    const s = t.s;
    return localCommand(t, `Context Usage\n${s.ctx.toLocaleString("en-US")} / 200,000 tokens (${Math.round((s.ctx / 200000) * 100)}%)\n\nMessages: ${s.messageTokens.toLocaleString("en-US")} tokens\nSystem prompt and tools: ${BASE_CONTEXT.toLocaleString("en-US")} tokens`);
  }
  t.init();
  if (t.s.turns === 0) return showcaseTurn(t);
  if (/\bplan/.test(lower)) return planTurn(t);
  if (/\bask\b/.test(lower)) return askTurn(t);
  if (/\b(fail|error)/.test(lower)) return failTurn(t);
  return genericTurn(t, text);
}

/* ---- Context and usage answers ---- */

function contextUsage(s: Session): ContextUsage {
  const max = 200000;
  const used = [
    { id: "system_prompt", name: "System prompt", tokens: 3100, color: "promptBorder" },
    { id: "system_tools", name: "System tools", tokens: 14200, color: "inactive" },
    { id: "mcp_tools", name: "MCP tools", tokens: 6400, color: "cyan_FOR_SUBAGENTS_ONLY" },
    { id: "custom_agents", name: "Custom agents", tokens: 900, color: "permission" },
    { id: "memory_files", name: "Memory files", tokens: 2800, color: "claude" },
    { id: "skills", name: "Skills", tokens: 1600, color: "warning" },
    { id: "messages", name: "Messages", tokens: s.messageTokens, color: "purple_FOR_SUBAGENTS_ONLY" },
  ] as const;
  const total = used.reduce((sum, c) => sum + c.tokens, 0);
  const buffer = 33000;
  const free = Math.max(0, max - total - buffer);
  const categories: ContextUsage["categories"] = [
    ...used.map((c) => ({ ...c, kind: "used" as const })),
    { id: "free_space", name: "Free space", tokens: free, color: "promptBorder", kind: "free" },
    { id: "autocompact_buffer", name: "Autocompact buffer", tokens: buffer, color: "inactive", kind: "buffer" },
  ];
  const per = max / 200;
  const square = (c: (typeof categories)[number], fullness: number) => ({
    color: c.color,
    isFilled: c.kind !== "free",
    categoryName: c.name,
    tokens: Math.round(per * fullness),
    percentage: (per * fullness * 100) / max,
    squareFullness: fullness,
  });
  const squares: ReturnType<typeof square>[] = [];
  for (const c of categories.slice(0, -1)) {
    const n = c.tokens / per;
    for (let i = 0; i < Math.floor(n); i++) squares.push(square(c, 1));
    if (n - Math.floor(n) > 0.01) squares.push(square(c, n - Math.floor(n)));
  }
  const freeCat = categories[categories.length - 2];
  const bufferCat = categories[categories.length - 1];
  const bufferSquares = Math.ceil(buffer / per);
  while (squares.length < 200 - bufferSquares) squares.push(square(freeCat, 1));
  squares.length = 200 - bufferSquares;
  for (let i = 0; i < bufferSquares; i++) squares.push(square(bufferCat, 1));
  const gridRows = Array.from({ length: 10 }, (_, r) => squares.slice(r * 20, r * 20 + 20));

  const m = s.messageTokens;
  const mcp = [
    ["linear", "list_issues", 760],
    ["linear", "get_issue", 700],
    ["linear", "save_issue", 880],
    ["linear", "save_comment", 640],
    ["linear", "list_projects", 520],
    ["linear", "list_teams", 500],
    ["context7", "resolve-library-id", 1250],
    ["context7", "query-docs", 1150],
  ] as const;
  const read = Math.max(0, s.ctx - 1800 - 6);
  return {
    categories,
    totalTokens: total,
    maxTokens: max,
    rawMaxTokens: max,
    percentage: Math.round((total / max) * 1000) / 10,
    gridRows,
    model: OPUS,
    memoryFiles: [
      { path: "~/.claude/CLAUDE.md", type: "User", tokens: 1100 },
      { path: `${s.cwd}/CLAUDE.md`, type: "Project", tokens: 1700 },
    ],
    mcpTools: mcp.map(([serverName, name, tokens]) => ({ name: `mcp__${serverName}__${name}`, serverName, tokens, isLoaded: true })),
    agents: AGENTS.map((a, i) => ({ agentType: a.name, source: i === 2 ? "plugin" : "built-in", tokens: 300 })),
    slashCommands: { totalCommands: COMMANDS.length, includedCommands: COMMANDS.length, tokens: 600 },
    skills: {
      totalSkills: 6,
      includedSkills: 4,
      tokens: 1600,
      skillFrontmatter: [
        { name: "commit-commands:commit", source: "plugin", pluginName: "commit-commands", tokens: 400 },
        { name: "frontend-design:frontend-design", source: "plugin", pluginName: "frontend-design", tokens: 400 },
        { name: "deploy", source: "projectSettings", tokens: 400 },
        { name: "release-notes", source: "userSettings", tokens: 400 },
      ],
    },
    autoCompactThreshold: 167000,
    isAutoCompactEnabled: true,
    messageBreakdown: {
      toolCallTokens: Math.round(m * 0.18),
      toolResultTokens: Math.round(m * 0.52),
      attachmentTokens: Math.round(m * 0.03),
      assistantMessageTokens: Math.round(m * 0.17),
      userMessageTokens: Math.round(m * 0.04),
      redirectedContextTokens: 0,
      unattributedTokens: m - Math.round(m * 0.18) - Math.round(m * 0.52) - Math.round(m * 0.03) - Math.round(m * 0.17) - Math.round(m * 0.04),
      toolCallsByType: [
        { name: "Bash", callTokens: Math.round(m * 0.04), resultTokens: Math.round(m * 0.14) },
        { name: "Read", callTokens: Math.round(m * 0.02), resultTokens: Math.round(m * 0.22) },
        { name: "Edit", callTokens: Math.round(m * 0.08), resultTokens: Math.round(m * 0.05) },
        { name: "Grep", callTokens: Math.round(m * 0.02), resultTokens: Math.round(m * 0.06) },
      ],
      attachmentsByType: [{ name: "CLAUDE.md", tokens: Math.round(m * 0.03) }],
    },
    apiUsage: { input_tokens: 6, output_tokens: 420, cache_creation_input_tokens: 1800, cache_read_input_tokens: read },
  };
}

function planUsage(s: Session): PlanUsage {
  const window = (utilization: number, hours: number) => ({ utilization, resets_at: iso(hours * 3600e3) });
  return {
    session: {
      total_cost_usd: totalCost(s),
      total_api_duration_ms: s.apiMs,
      total_duration_ms: s.durationMs,
      total_lines_added: s.linesAdded,
      total_lines_removed: s.linesRemoved,
      model_usage: JSON.parse(JSON.stringify(s.usage)),
    },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: window(34, 3 + 12 / 60),
      seven_day: window(61, 4 * 24),
      seven_day_opus: window(78, 4 * 24),
      seven_day_sonnet: window(22, 4 * 24),
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    },
    behaviors: null,
  };
}

function pastTranscript(sessionId: string, cwd: string): SessionMessage[] {
  const path = `${cwd}/src/queue/scheduler.ts`;
  const readId = "toolu_01PastRead0001";
  const message = (type: "user" | "assistant", body: Json): SessionMessage => ({ type, uuid: uuid(), session_id: sessionId, message: body, parent_tool_use_id: null, parent_agent_id: null });
  const usage = { input_tokens: 5, cache_read_input_tokens: 12000, cache_creation_input_tokens: 900, output_tokens: 180 };
  const asst = (content: Json[], stop: string) => message("assistant", { id: rid("msg_"), type: "message", role: "assistant", model: OPUS, content, stop_reason: stop, stop_sequence: null, usage });
  return [
    message("user", { role: "user", content: [{ type: "text", text: "What does the scheduler do when a job is cancelled?" }] }),
    asst([{ type: "text", text: "I'll read the scheduler to check." }, { type: "tool_use", id: readId, name: "Read", input: { file_path: path } }], "tool_use"),
    message("user", { role: "user", content: [{ type: "tool_result", tool_use_id: readId, content: catN(SCHEDULER_LINES) }] }),
    asst(
      [
        {
          type: "text",
          text: "`Scheduler.cancel(id)` calls `clearTimeout` on a handle stored in `this.delays`, but `execute()` never stores a handle there, so **cancelling has no effect**:\n\n- the delay timer keeps running\n- the job's `run()` still executes afterwards\n\nStoring the handle when the timer is created fixes it:\n\n```ts\nconst handle = setTimeout(resolve, job.delayMs ?? 0);\nthis.delays.set(job.id, handle);\n```",
        },
      ],
      "end_turn",
    ),
    message("user", { role: "user", content: [{ type: "text", text: "Good catch, please fix it." }] }),
    // Replayed calls carry no structured results: the Edit's diff comes from its input, the Agent's report from its result.
    asst([{ type: "tool_use", id: "toolu_01PastAgent001", name: "Agent", input: { description: "Find other callers of cancel()", prompt: "List every caller of Scheduler.cancel.", subagent_type: "Explore" } }], "tool_use"),
    message("user", {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_01PastAgent001", content: [{ type: "text", text: "Two callers:\n\n- `src/queue/worker.ts:88` cancels on shutdown\n- `src/api/jobs.ts:41` cancels on `DELETE /jobs/:id`" }] }],
    }),
    asst([{ type: "tool_use", id: "toolu_01PastEdit0001", name: "Edit", input: { file_path: path, old_string: "    await delay(job.delayMs ?? 0);", new_string: "    const handle = setTimeout(resolve, job.delayMs ?? 0);\n    this.delays.set(job.id, handle);" } }], "tool_use"),
    message("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01PastEdit0001", content: `The file ${path} has been updated successfully.` }] }),
    asst([{ type: "text", text: "Done: `execute()` now records the timer handle, and `cancel()` clears it and rejects the pending promise." }], "end_turn"),
  ];
}

/* ---- The bridge ---- */

/** Opens the mock bridge; `onLine` gets answers and events as JSON lines. */
export function openMockBridge(onLine: (line: string) => void): { send(line: string): void; close(): void } {
  const sessions = new Map<string, Session>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;

  const write = (value: unknown) => {
    if (!closed) onLine(JSON.stringify(value));
  };
  const later = (ms: number, fn: () => void) => {
    const handle = setTimeout(() => {
      timers.delete(handle);
      fn();
    }, ms);
    timers.add(handle);
  };
  const getSession = (key: string): Session => {
    const s = sessions.get(key);
    if (!s) throw new BridgeFail("Unknown session", "notFound");
    return s;
  };

  const stopSession = (s: Session) => {
    s.closed = true;
    s.turn?.cancel();
    s.turn = undefined;
    s.queue.length = 0;
    s.perms.clear();
    sessions.delete(s.key);
  };

  const status = (s: Session, extra: Json) => {
    write({ event: "message", session: s.key, message: { type: "system", subtype: "status", uuid: uuid(), session_id: s.sessionId, ...extra } });
  };

  const playNext = (s: Session) => {
    const next = s.queue.shift();
    if (!next || s.closed) return;
    const turn = new Turn(s, next.uuid, write);
    s.turn = turn;
    void (async () => {
      try {
        await turn.wait(60);
        await playTurn(turn, next.text);
      } catch (error) {
        if (error !== ABORT) console.error("[claude mock]", error);
        return;
      }
      if (s.turn === turn) {
        s.turn = undefined;
        playNext(s);
      }
    })();
  };

  const interrupt = (s: Session) => {
    const turn = s.turn;
    if (!turn) return;
    const pending = turn.permId;
    turn.cancel();
    s.turn = undefined;
    if (pending) write({ event: "permissionCancelled", session: s.key, requestId: pending });
    const emit = (message: Json) => write({ event: "message", session: s.key, message: { uuid: uuid(), session_id: s.sessionId, ...message } });
    for (const [id, parent] of turn.open) {
      emit({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "[Request interrupted by user for tool use]", is_error: true }] },
        parent_tool_use_id: parent,
        tool_use_result: "[Request interrupted by user for tool use]",
      });
    }
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: totalCost(s),
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: JSON.parse(JSON.stringify(s.usage)),
      permission_denials: [],
      errors: [],
    });
    status(s, { status: null });
    playNext(s);
  };

  const capabilities = () => ({ commands: COMMANDS, models: MODELS, agents: AGENTS });

  async function handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "hello":
        return { protocol: BRIDGE_PROTOCOL, sdkVersion: "0.3.330", nodeVersion: "v24.11.0", claudePath: "/Users/you/.local/bin/claude" };
      case "session.start": {
        const p = params as BridgeParams<"session.start">;
        const old = sessions.get(p.session);
        if (old) stopSession(old);
        const s: Session = {
          key: p.session,
          cwd: p.cwd,
          sessionId: p.resume ?? uuid(),
          model: p.model ?? "default",
          effort: p.effort ?? null,
          mode: p.permissionMode ?? "default",
          turns: 0,
          queue: [],
          ctx: 30000,
          messageTokens: 1000,
          usage: {},
          durationMs: 0,
          apiMs: 0,
          linesAdded: 0,
          linesRemoved: 0,
          perms: new Map(),
          tasks: new Map(),
          mcp: MCP_SERVERS.map((server) => ({ ...server })),
          closed: false,
        };
        sessions.set(s.key, s);
        const init: SessionInit = {
          sessionId: s.sessionId,
          claudeCodeVersion: CC_VERSION,
          ...capabilities(),
          account: ACCOUNT,
          outputStyle: "default",
          availableOutputStyles: ["default", "Explanatory", "Learning"],
          permissionMode: s.mode,
        };
        await new Promise((resolve) => later(250, () => resolve(undefined)));
        return init;
      }
      case "session.send": {
        const p = params as BridgeParams<"session.send">;
        const s = getSession(p.session);
        s.queue.push({ text: p.text, uuid: p.uuid });
        if (!s.turn) playNext(s);
        return {};
      }
      case "session.interrupt":
        interrupt(getSession((params as BridgeParams<"session.interrupt">).session));
        return {};
      case "session.close": {
        const s = sessions.get((params as BridgeParams<"session.close">).session);
        if (s) stopSession(s);
        return {};
      }
      case "session.permission": {
        const p = params as BridgeParams<"session.permission">;
        getSession(p.session).perms.get(p.requestId)?.(p.result);
        return {};
      }
      case "session.setPermissionMode": {
        const p = params as BridgeParams<"session.setPermissionMode">;
        const s = getSession(p.session);
        s.mode = p.mode;
        status(s, { status: null, permissionMode: p.mode });
        return {};
      }
      case "session.setModel": {
        const p = params as BridgeParams<"session.setModel">;
        getSession(p.session).model = p.model ?? "default";
        return {};
      }
      case "session.setEffort": {
        const p = params as BridgeParams<"session.setEffort">;
        getSession(p.session).effort = p.effort;
        return {};
      }
      case "session.contextUsage":
        return contextUsage(getSession((params as BridgeParams<"session.contextUsage">).session));
      case "session.usage":
        return planUsage(getSession((params as BridgeParams<"session.usage">).session));
      case "session.mcpStatus":
        return getSession((params as BridgeParams<"session.mcpStatus">).session).mcp;
      case "session.mcpToggle": {
        const p = params as BridgeParams<"session.mcpToggle">;
        const s = getSession(p.session);
        const original = MCP_SERVERS.find((server) => server.name === p.server);
        if (!original) throw new BridgeFail(`No MCP server named ${p.server}`, "notFound");
        s.mcp = s.mcp.map((server) => (server.name !== p.server ? server : p.enabled ? { ...original } : { ...server, status: "disabled", error: undefined, tools: [] }));
        return {};
      }
      case "session.mcpReconnect": {
        const p = params as BridgeParams<"session.mcpReconnect">;
        const s = getSession(p.session);
        const original = MCP_SERVERS.find((server) => server.name === p.server);
        if (!original) throw new BridgeFail(`No MCP server named ${p.server}`, "notFound");
        // A reconnect that works: the failed server comes up (with a tool), the others as they were.
        s.mcp = s.mcp.map((server) =>
          server.name !== p.server ? server : original.status === "failed" ? { ...original, status: "connected", error: undefined, tools: [{ name: "search_issues" }] } : { ...original },
        );
        return {};
      }
      case "session.stopTask": {
        const p = params as BridgeParams<"session.stopTask">;
        getSession(p.session).tasks.get(p.taskId)?.stop();
        return {};
      }
      case "session.reloadPlugins": {
        getSession((params as BridgeParams<"session.reloadPlugins">).session);
        const result: ReloadPluginsResult = {
          commands: COMMANDS,
          agents: AGENTS,
          plugins: PLUGINS.map((p) => ({ ...p, source: "marketplace" })),
          mcpServers: getSession((params as BridgeParams<"session.reloadPlugins">).session).mcp,
          error_count: 0,
        };
        return result;
      }
      case "session.capabilities":
        getSession((params as BridgeParams<"session.capabilities">).session);
        return capabilities();
      case "sessions.messages": {
        const r = mockRequest(method, params);
        if (r !== undefined) return r;
        const p = params as BridgeParams<"sessions.messages">;
        return pastTranscript(p.sessionId, p.cwd);
      }
      default: {
        if (method.startsWith("session.")) throw new BridgeFail("Unknown method", "invalid");
        const r = await mockRequest(method, params);
        if (r === undefined) throw new BridgeFail("Not in the mock", "other");
        return r;
      }
    }
  }

  return {
    send(line: string): void {
      if (closed) return;
      let request: { id?: unknown; method?: unknown; params?: unknown };
      try {
        request = JSON.parse(line);
      } catch {
        return;
      }
      const id = request.id;
      if (typeof id !== "number" || typeof request.method !== "string") return;
      const delay = request.method === "session.start" ? 0 : request.method.startsWith("session.") ? 15 : 120;
      // State changes happen now (so requests keep their order); only the answer is delayed.
      handle(request.method, request.params).then(
        (result) => later(delay, () => write({ id, result })),
        (error: unknown) => {
          const fail = error instanceof BridgeFail ? error : new BridgeFail(error instanceof Error ? error.message : String(error), "other");
          later(delay, () => write({ id, error: { message: fail.message, code: fail.code } }));
        },
      );
    },
    close(): void {
      closed = true;
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
      for (const s of [...sessions.values()]) stopSession(s);
    },
  };
}
