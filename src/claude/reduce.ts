import type { EffortLevel, PermissionMode, SDKMessage, SessionMessage } from "./protocol";
import type { ClaudeSession, SessionTotals, StreamState, Task, Todo, ToolCall, ToolStatus, TranscriptItem } from "./types";

/*
 * Pure: SDK messages → the pane's session model (src/claude/types.ts).
 *
 * - Streamed API messages (`stream_event`) build items live: text and
 *   thinking deltas grow an item, tool input JSON is parsed as it arrives.
 *   The `assistant` message the CLI sends for each finished block replaces
 *   the streamed one (matched by message id and kind, in block order).
 * - Messages with a `parent_tool_use_id` belong to a subagent and go to
 *   `subTranscripts[parent]`.
 * - Tool results (`user` messages with tool_result blocks) settle `tools`.
 * - `result` closes the turn: totals, a result item, status idle.
 * See docs/claude-code.md.
 */

/** Tool results are clipped to this many characters. */
export const RESULT_LIMIT = 64 * 1024;

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function emptyTotals(): SessionTotals {
  return { costUsd: 0, durationMs: 0, apiDurationMs: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, byModel: {} };
}

export type SessionSeed = {
  key: string;
  paneId: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  effort?: EffortLevel | null;
  permissionMode?: PermissionMode;
};

/** A session with nothing in it yet. */
export function createSession(seed: SessionSeed): ClaudeSession {
  return {
    key: seed.key,
    paneId: seed.paneId,
    cwd: seed.cwd,
    status: "new",
    sessionId: seed.sessionId,
    resumed: seed.sessionId ? true : undefined,
    model: seed.model,
    effort: seed.effort,
    permissionMode: seed.permissionMode ?? "default",
    items: [],
    subTranscripts: {},
    tools: {},
    tasks: {},
    permissions: [],
    todos: [],
    totals: emptyTotals(),
    mcpServers: [],
  };
}

/* ---- Threads (the main transcript, or a subagent's) ---- */

function threadItems(session: ClaudeSession, parent: string | null): TranscriptItem[] {
  return parent ? (session.subTranscripts[parent] ?? []) : session.items;
}

function withThread(session: ClaudeSession, parent: string | null, update: (items: TranscriptItem[]) => TranscriptItem[]): ClaudeSession {
  const before = threadItems(session, parent);
  const after = update(before);
  if (after === before) return session;
  return parent ? { ...session, subTranscripts: { ...session.subTranscripts, [parent]: after } } : { ...session, items: after };
}

/** Replaces the item with `item.id`, or appends it. */
function upsert(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

function patchItem(items: TranscriptItem[], id: string, patch: (item: TranscriptItem) => TranscriptItem): TranscriptItem[] {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return items;
  const next = items.slice();
  next[index] = patch(items[index]);
  return next;
}

function patchTool(session: ClaudeSession, id: string, patch: Partial<ToolCall>): ClaudeSession {
  const tool = session.tools[id];
  if (!tool) return session;
  return { ...session, tools: { ...session.tools, [id]: { ...tool, ...patch } } };
}

function notice(session: ClaudeSession, parent: string | null, id: string, tone: "info" | "warn" | "error", text: string): ClaudeSession {
  return withThread(session, parent, (items) => upsert(items, { kind: "notice", id, tone, text }));
}

/** User messages sent while a turn ran, folded in now: no longer queued, moved to the end. */
function unqueue(session: ClaudeSession, uuids: readonly string[] | undefined): ClaudeSession {
  if (!uuids?.length) return session;
  const folded = session.items.filter((item) => item.kind === "user" && item.queued && uuids.includes(item.id));
  if (folded.length === 0) return session;
  const rest = session.items.filter((item) => !folded.includes(item));
  return { ...session, items: [...rest, ...folded.map((item) => ({ ...item, queued: false }))] };
}

function uuidsOf(message: Rec): string[] | undefined {
  if (Array.isArray(message.user_message_uuids)) return message.user_message_uuids.filter((uuid): uuid is string => typeof uuid === "string");
  const single = str(message.user_message_uuid);
  return single ? [single] : undefined;
}

/** What the next request will carry, from an API message's usage: input plus cached tokens. */
function contextFromUsage(usage: unknown): number | undefined {
  if (!isRec(usage)) return undefined;
  const total = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
  return total > 0 ? total : undefined;
}

/* ---- Tool inputs ---- */

/**
 * Best-effort parse of a JSON object that is still arriving: closes an open
 * string and open brackets, drops a dangling key or comma. `undefined` when
 * even that does not parse.
 */
export function parsePartialJson(text: string): Rec | undefined {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const value = JSON.parse(trimmed);
    return isRec(value) ? value : undefined;
  } catch {
    // Repaired below.
  }
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of trimmed) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") stack.pop();
  }
  let repaired = trimmed;
  if (inString) repaired += escaped ? '\\"' : '"';
  // A key with no value yet (`"a": 1, "b"` or `"b":`), or a trailing comma.
  for (const tail of [/,\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, /\{\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, /,\s*$/, /:\s*$/]) {
    if (tail.test(repaired)) {
      repaired = repaired.replace(tail, (match) => (match.trimStart().startsWith("{") ? "{" : ""));
      break;
    }
  }
  repaired += stack.reverse().join("");
  try {
    const value = JSON.parse(repaired);
    return isRec(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

/** TodoWrite's list, validated. */
export function todosOf(input: unknown): Todo[] | undefined {
  if (!isRec(input) || !Array.isArray(input.todos)) return undefined;
  return input.todos.filter(isRec).flatMap((todo) =>
    typeof todo.content === "string" && TODO_STATUSES.has(todo.status as string)
      ? [{ content: todo.content, status: todo.status as Todo["status"], activeForm: str(todo.activeForm) }]
      : [],
  );
}

const isStatus = (value: unknown): value is Todo["status"] => typeof value === "string" && TODO_STATUSES.has(value);

/**
 * The CLI's task list tools as to-dos (main thread, once they succeeded):
 * TaskCreate adds one (its id from the structured result, else "Task #3
 * created…"), TaskUpdate changes or deletes one, TaskList and TaskGet
 * bring the list up to date.
 */
function applyTaskTool(session: ClaudeSession, tool: ToolCall, text: string, structured: unknown): ClaudeSession {
  const input = tool.input;
  const output = isRec(structured) ? structured : {};
  const update = (id: string, patch: (todo: Todo) => Todo) => ({ ...session, todos: session.todos.map((todo) => (todo.id === id ? patch(todo) : todo)) });
  switch (tool.name) {
    case "TaskCreate": {
      const task = isRec(output.task) ? output.task : {};
      const id = str(task.id) ?? /#\s*([\w-]+)/.exec(text)?.[1];
      const content = str(task.subject) ?? str(input.subject);
      if (!content) return session;
      const todo: Todo = { id, content, status: "pending", activeForm: str(input.activeForm) };
      if (id && session.todos.some((existing) => existing.id === id)) return update(id, (existing) => ({ ...todo, status: existing.status }));
      return { ...session, todos: [...session.todos, todo] };
    }
    case "TaskUpdate": {
      if (output.success === false) return session;
      const id = str(input.taskId) ?? str(output.taskId);
      if (!id) return session;
      if (input.status === "deleted") return { ...session, todos: session.todos.filter((todo) => todo.id !== id) };
      return update(id, (todo) => ({
        ...todo,
        content: str(input.subject) ?? todo.content,
        activeForm: str(input.activeForm) ?? todo.activeForm,
        status: isStatus(input.status) ? input.status : todo.status,
      }));
    }
    case "TaskList": {
      if (!Array.isArray(output.tasks)) return session;
      const known = new Map(session.todos.map((todo) => [todo.id, todo]));
      const todos = output.tasks.filter(isRec).flatMap((task): Todo[] =>
        typeof task.subject === "string" && isStatus(task.status) ? [{ id: str(task.id), content: task.subject, status: task.status, activeForm: known.get(str(task.id))?.activeForm }] : [],
      );
      return { ...session, todos };
    }
    case "TaskGet": {
      const task = isRec(output.task) ? output.task : undefined;
      const id = task && str(task.id);
      if (!task || !id) return session;
      if (!session.todos.some((todo) => todo.id === id)) {
        // A task this view had not seen (made before a resume, or by another client): added.
        const content = str(task.subject);
        return content ? { ...session, todos: [...session.todos, { id, content, status: isStatus(task.status) ? task.status : "pending", activeForm: str(task.activeForm) }] } : session;
      }
      return update(id, (todo) => ({ ...todo, content: str(task.subject) ?? todo.content, status: isStatus(task.status) ? task.status : todo.status, activeForm: str(task.activeForm) ?? todo.activeForm }));
    }
    default:
      return session;
  }
}

/** The tool_result content as text: text blocks joined, images noted, clipped. */
function resultText(content: unknown): string {
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    text = content
      .map((block) => (isRec(block) ? (block.type === "text" ? (str(block.text) ?? "") : block.type === "image" ? "[image]" : "") : ""))
      .filter(Boolean)
      .join("\n");
  else text = "";
  return text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}\n… (clipped)` : text;
}

const DENIED = /doesn't want to proceed|was rejected|user (has )?denied|permission to use .* (has been )?denied/i;
const INTERRUPTED = /interrupted by user/i;

const AGENT_TOOLS = new Set(["Agent", "Task"]);
export const isAgentTool = (name: string) => AGENT_TOOLS.has(name);

/* ---- Message handlers ---- */

type Handler = (session: ClaudeSession, message: Rec, now: number) => ClaudeSession;

const onStreamEvent: Handler = (session, message, now) => {
  const parent = str(message.parent_tool_use_id) ?? null;
  const key = parent ?? "";
  const event = isRec(message.event) ? message.event : {};
  session = unqueue(session, uuidsOf(message));
  const stream = session.streams?.[key];
  const setStream = (next: StreamState) => ({ ...session, streams: { ...session.streams, [key]: next } });

  switch (event.type) {
    case "message_start": {
      const apiMessage = isRec(event.message) ? event.message : {};
      session = setStream({ messageId: str(apiMessage.id) ?? str(message.uuid) ?? String(now), blocks: {} });
      if (!parent) {
        const context = contextFromUsage(apiMessage.usage);
        if (context) session = { ...session, contextTokens: context };
        if (session.status === "idle" || session.status === "new") session = { ...session, status: "running", turnStartedAt: session.turnStartedAt ?? now };
      }
      return session;
    }
    case "content_block_start": {
      if (!stream) return session;
      const index = num(event.index);
      const block = isRec(event.content_block) ? event.content_block : {};
      const itemId = `${stream.messageId}#${index}`;
      if (block.type === "text") {
        session = withThread(session, parent, (items) => upsert(items, { kind: "assistant", id: itemId, text: str(block.text) ?? "", streaming: true }));
        return { ...session, streams: { ...session.streams, [key]: { ...stream, blocks: { ...stream.blocks, [index]: { itemId, kind: "text" } } } } };
      }
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        const redacted = block.type === "redacted_thinking";
        session = withThread(session, parent, (items) =>
          upsert(items, { kind: "thinking", id: itemId, text: str(block.thinking) ?? "", streaming: true, redacted: redacted || undefined }),
        );
        return { ...session, streams: { ...session.streams, [key]: { ...stream, blocks: { ...stream.blocks, [index]: { itemId, kind: "thinking" } } } } };
      }
      if ((block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") && typeof block.id === "string") {
        const toolUseId = block.id;
        session = startTool(session, parent, toolUseId, str(block.name) ?? "tool", {}, "streaming", now);
        return {
          ...session,
          streams: { ...session.streams, [key]: { ...stream, blocks: { ...stream.blocks, [index]: { itemId: `tool:${toolUseId}`, kind: "tool", toolUseId, json: "" } } } },
        };
      }
      return session;
    }
    case "content_block_delta": {
      const entry = stream?.blocks[num(event.index)];
      const delta = isRec(event.delta) ? event.delta : {};
      if (!stream || !entry) return session;
      if (delta.type === "text_delta" || delta.type === "thinking_delta") {
        const piece = str(delta.text) ?? str(delta.thinking) ?? "";
        if (!piece) return session;
        return withThread(session, parent, (items) =>
          patchItem(items, entry.itemId, (item) => (item.kind === "assistant" || item.kind === "thinking" ? { ...item, text: item.text + piece } : item)),
        );
      }
      if (delta.type === "input_json_delta" && entry.toolUseId) {
        const json = (entry.json ?? "") + (str(delta.partial_json) ?? "");
        const input = parsePartialJson(json);
        session = setStream({ ...stream, blocks: { ...stream.blocks, [num(event.index)]: { ...entry, json } } });
        return input ? patchTool(session, entry.toolUseId, { input }) : session;
      }
      return session;
    }
    case "content_block_stop": {
      const entry = stream?.blocks[num(event.index)];
      if (!entry?.toolUseId) return session;
      const tool = session.tools[entry.toolUseId];
      if (!tool || tool.status !== "streaming") return session;
      const input = parsePartialJson(entry.json ?? "") ?? tool.input;
      return patchTool(session, entry.toolUseId, { input, status: "pending" });
    }
    default:
      return session;
  }
};

function startTool(session: ClaudeSession, parent: string | null, id: string, name: string, input: Rec, status: ToolStatus, now: number): ClaudeSession {
  if (session.tools[id]) return session;
  session = { ...session, tools: { ...session.tools, [id]: { id, name, input, status, parentToolUseId: parent, startedAt: now } } };
  return withThread(session, parent, (items) => upsert(items, { kind: "tool", id: `tool:${id}`, toolUseId: id }));
}

/** The first still-streaming item of `kind` from API message `messageId` in the thread. */
function streamedItem(items: TranscriptItem[], messageId: string, kind: "assistant" | "thinking"): TranscriptItem | undefined {
  return items.find((item) => item.kind === kind && item.streaming && item.id.startsWith(`${messageId}#`));
}

const onAssistant: Handler = (session, message, now) => {
  const parent = str(message.parent_tool_use_id) ?? null;
  const apiMessage = isRec(message.message) ? message.message : {};
  const messageId = str(apiMessage.id) ?? str(message.uuid) ?? String(now);
  const content = Array.isArray(apiMessage.content) ? apiMessage.content.filter(isRec) : [];
  session = unqueue(session, uuidsOf(message));

  // A failed API call: its text is the error, shown as a notice.
  if (typeof message.error === "string") {
    const text = content.map((block) => str(block.text) ?? "").join("\n").trim();
    return notice(session, parent, `${messageId}#error`, "error", text || `API error: ${message.error}`);
  }

  content.forEach((block, index) => {
    const fallbackId = `${messageId}#${str(message.uuid) ?? "m"}.${index}`;
    if (block.type === "text" || block.type === "thinking" || block.type === "redacted_thinking") {
      const kind = block.type === "text" ? "assistant" : "thinking";
      const text = str(block.text) ?? str(block.thinking) ?? "";
      session = withThread(session, parent, (items) => {
        const streamed = streamedItem(items, messageId, kind);
        if (streamed) return patchItem(items, streamed.id, (item) => ({ ...item, text, streaming: false }) as TranscriptItem);
        // Already have this block (a repeated message).
        if (items.some((item) => item.kind === kind && item.id.startsWith(`${messageId}#`) && item.text === text)) return items;
        const item: TranscriptItem =
          kind === "assistant"
            ? { kind: "assistant", id: fallbackId, text, streaming: false }
            : { kind: "thinking", id: fallbackId, text, streaming: false, redacted: block.type === "redacted_thinking" || undefined };
        return [...items, item];
      });
    } else if ((block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") && typeof block.id === "string") {
      const input = isRec(block.input) ? block.input : {};
      const name = str(block.name) ?? "tool";
      session = startTool(session, parent, block.id, name, input, "running", now);
      const tool = session.tools[block.id];
      session = patchTool(session, block.id, {
        name,
        input,
        status: tool.status === "streaming" || tool.status === "pending" ? "running" : tool.status,
      });
      if (name === "TodoWrite" && !parent) session = { ...session, todos: todosOf(input) ?? session.todos };
    }
  });

  if (!parent) {
    const context = contextFromUsage(apiMessage.usage);
    if (context) session = { ...session, contextTokens: context };
  }
  return session;
};

/** Claude Code's markup in user text: slash commands and their output, reminders. */
function parseUserText(text: string): { kind: "user"; text: string } | { kind: "command"; text: string } | undefined {
  const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
  if (stdout) return stdout[1].trim() ? { kind: "command", text: stdout[1].trim() } : undefined;
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1].trim();
    const command = name[1].trim();
    return { kind: "user", text: `${command.startsWith("/") ? command : `/${command}`}${args ? ` ${args}` : ""}` };
  }
  const plain = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .trim();
  return plain ? { kind: "user", text: plain } : undefined;
}

const onUser: Handler = (session, message, now) => {
  const parent = str(message.parent_tool_use_id) ?? null;
  const apiMessage = isRec(message.message) ? message.message : {};
  const content = apiMessage.content;
  const uuid = str(message.uuid) ?? `user-${now}`;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.filter(isRec) : [];

  const results = blocks.filter((block) => block.type === "tool_result");
  for (const block of results) {
    const id = str(block.tool_use_id);
    const tool = id ? session.tools[id] : undefined;
    if (!id || !tool) continue;
    const text = resultText(block.content);
    const isError = block.is_error === true;
    const status: ToolStatus = !isError ? "done" : INTERRUPTED.test(text) ? "cancelled" : DENIED.test(text) || tool.status === "denied" ? "denied" : "error";
    const structured = results.length === 1 && message.tool_use_result !== undefined ? message.tool_use_result : tool.structured;
    session = patchTool(session, id, { status, result: text, isError, structured, endedAt: now });
    if (!isError && !tool.parentToolUseId) session = applyTaskTool(session, tool, text, structured);
  }
  if (results.length > 0) return session;

  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => str(block.text) ?? "")
    .join("\n");
  if (INTERRUPTED.test(text) && text.trim().startsWith("[Request interrupted")) {
    return parent ? session : notice(session, null, `interrupt:${uuid}`, "warn", "Interrupted");
  }
  // Our own message (sent with this uuid), echoed: it is in.
  if (session.items.some((item) => item.id === uuid)) return unqueue(session, [uuid]);
  if (message.isSynthetic === true) return session;
  // A subagent's prompt opens its transcript.
  if (parent) {
    if (threadItems(session, parent).some((item) => item.kind === "user")) return session;
    return text.trim() ? withThread(session, parent, (items) => [...items, { kind: "user", id: uuid, text: text.trim() }]) : session;
  }
  // Only replayed messages (a resumed transcript) are added; live ones were added when sent.
  if (message.isReplay !== true) return session;
  const images = blocks.flatMap((block) => {
    const source = isRec(block.source) ? block.source : undefined;
    return block.type === "image" && source?.type === "base64" && typeof source.data === "string"
      ? [{ mediaType: (str(source.media_type) ?? "image/png") as "image/png", data: source.data }]
      : [];
  });
  // An image-only message has no text to parse.
  const parsed = parseUserText(text) ?? (images.length ? { kind: "user" as const, text: "" } : undefined);
  if (!parsed) return session;
  return withThread(session, null, (items) =>
    upsert(items, parsed.kind === "user" ? { kind: "user", id: uuid, text: parsed.text, images: images.length ? images : undefined } : { kind: "command", id: uuid, text: parsed.text }),
  );
};

/** Ends what is still streaming or running in every thread (a turn ended, or a transcript was loaded). */
/**
 * The process is gone: on top of `settleSession`, its background tasks stop
 * (marked `stopped`), and so do the calls they kept open.
 */
export function endSession(session: ClaudeSession, now: number): ClaudeSession {
  let tasks = session.tasks;
  for (const task of Object.values(session.tasks)) {
    if (task.status !== "running" && task.status !== "pending" && task.status !== "paused") continue;
    if (tasks === session.tasks) tasks = { ...tasks };
    tasks[task.id] = { ...task, status: "stopped", endedAt: task.endedAt ?? now };
  }
  return settleSession({ ...session, tasks }, now);
}

export function settleSession(session: ClaudeSession, now: number): ClaudeSession {
  const done = (items: TranscriptItem[]) =>
    items.some((item) => (item.kind === "assistant" || item.kind === "thinking") && item.streaming)
      ? items.map((item) => ((item.kind === "assistant" || item.kind === "thinking") && item.streaming ? { ...item, streaming: false } : item))
      : items;
  const subTranscripts: Record<string, TranscriptItem[]> = {};
  for (const [parent, items] of Object.entries(session.subTranscripts)) subTranscripts[parent] = done(items);
  let tools = session.tools;
  for (const tool of Object.values(session.tools)) {
    if (tool.status !== "streaming" && tool.status !== "pending" && tool.status !== "running") continue;
    // A subagent still working in the background keeps its call open.
    const task = Object.values(session.tasks).find((candidate) => candidate.toolUseId === tool.id);
    if (task && (task.status === "running" || task.status === "pending")) continue;
    if (tools === session.tools) tools = { ...tools };
    tools[tool.id] = { ...tool, status: "cancelled", endedAt: now };
  }
  return { ...session, items: done(session.items), subTranscripts, tools, streams: undefined };
}

/** Whether the turn already shows an "Interrupted" line (since the last prompt). */
function interruptedSinceLastPrompt(session: ClaudeSession): boolean {
  for (let index = session.items.length - 1; index >= 0; index--) {
    const item = session.items[index];
    if (item.kind === "user" && !item.queued) return false;
    if (item.kind === "notice" && item.id.startsWith("interrupt:")) return true;
  }
  return false;
}

const onResult: Handler = (session, message, now) => {
  session = unqueue(session, uuidsOf(message));
  const previousCost = session.totals.costUsd;
  // A resumed session's first total includes the spend before it: no baseline, so no per-turn cost.
  const noBaseline = session.resumed === true && session.totals.turns === 0;
  const byModel: SessionTotals["byModel"] = {};
  const modelUsage = isRec(message.modelUsage) ? message.modelUsage : {};
  for (const [model, usage] of Object.entries(modelUsage)) {
    if (!isRec(usage)) continue;
    byModel[model] = {
      inputTokens: num(usage.inputTokens),
      outputTokens: num(usage.outputTokens),
      cacheReadInputTokens: num(usage.cacheReadInputTokens),
      cacheCreationInputTokens: num(usage.cacheCreationInputTokens),
      costUSD: num(usage.costUSD),
      contextWindow: num(usage.contextWindow),
    };
  }
  const models = Object.values(byModel);
  const usage = isRec(message.usage) ? message.usage : {};
  const sum = (field: keyof (typeof models)[number]) => models.reduce((total, model) => total + model[field], 0);
  const totals: SessionTotals = {
    costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : previousCost,
    durationMs: session.totals.durationMs + num(message.duration_ms),
    apiDurationMs: session.totals.apiDurationMs + num(message.duration_api_ms),
    turns: session.totals.turns + num(message.num_turns),
    inputTokens: models.length ? sum("inputTokens") : session.totals.inputTokens + num(usage.input_tokens),
    outputTokens: models.length ? sum("outputTokens") : session.totals.outputTokens + num(usage.output_tokens),
    cacheReadTokens: models.length ? sum("cacheReadInputTokens") : session.totals.cacheReadTokens + num(usage.cache_read_input_tokens),
    cacheWriteTokens: models.length ? sum("cacheCreationInputTokens") : session.totals.cacheWriteTokens + num(usage.cache_creation_input_tokens),
    byModel: models.length ? byModel : session.totals.byModel,
  };
  const main = (session.resolvedModel && byModel[session.resolvedModel]) || models.reduce<(typeof models)[number] | undefined>((best, model) => (!best || model.contextWindow > best.contextWindow ? model : best), undefined);
  const uuid = str(message.uuid) ?? String(now);

  session = settleSession({ ...session, totals, contextWindow: main?.contextWindow || session.contextWindow }, now);
  const errors = Array.isArray(message.errors) ? message.errors.filter((error): error is string => typeof error === "string" && error.trim() !== "") : [];
  if (message.subtype !== "success" && errors.length) session = notice(session, null, `error:${uuid}`, "error", errors.join("\n"));
  else if (message.subtype === "error_during_execution" && !interruptedSinceLastPrompt(session)) session = notice(session, null, `interrupt:${uuid}`, "warn", "Interrupted");
  else if (message.subtype === "error_max_turns") session = notice(session, null, `error:${uuid}`, "error", "Stopped: the turn limit was reached.");
  else if (message.subtype === "error_max_budget_usd") session = notice(session, null, `error:${uuid}`, "error", "Stopped: the budget was reached.");
  else if (message.subtype === "success" && message.is_error === true) session = notice(session, null, `error:${uuid}`, "error", str(message.result) || "The turn failed.");

  session = withThread(session, null, (items) => [
    ...items,
    {
      kind: "result",
      id: `result:${uuid}`,
      durationMs: num(message.duration_ms),
      costUsd: noBaseline ? 0 : Math.max(0, totals.costUsd - previousCost),
      turns: num(message.num_turns),
      isError: message.is_error === true,
      stopReason: (message.stop_reason as string | null | undefined) ?? null,
    },
  ]);

  const more = num(message.queued_turn_count) > 0;
  if (!more) {
    const queued = session.items.filter((item) => item.kind === "user" && item.queued).map((item) => item.id);
    session = unqueue(session, queued);
  }
  return { ...session, status: more ? "running" : "idle", turnStartedAt: more ? now : undefined, compacting: false };
};

const onSystem: Handler = (session, message, now) => {
  const uuid = str(message.uuid) ?? String(now);
  switch (message.subtype) {
    case "init":
      return {
        ...session,
        sessionId: str(message.session_id) ?? session.sessionId,
        resolvedModel: str(message.model) ?? session.resolvedModel,
        permissionMode: (str(message.permissionMode) as PermissionMode | undefined) ?? session.permissionMode,
        mcpServers: Array.isArray(message.mcp_servers) ? (message.mcp_servers as ClaudeSession["mcpServers"]) : session.mcpServers,
        effort: message.effort !== undefined && session.effort === undefined ? (message.effort as EffortLevel | null) : session.effort,
      };
    case "status": {
      if (typeof message.permissionMode === "string") session = { ...session, permissionMode: message.permissionMode as PermissionMode };
      if (message.compact_result === "failed") {
        session = notice(session, null, `compact:${uuid}`, "error", `Compaction failed${message.compact_error ? `: ${message.compact_error}` : "."}`);
      }
      if (message.status === "compacting" && !session.compacting) {
        return notice({ ...session, compacting: true }, null, `compacting:${uuid}`, "info", "Compacting the conversation…");
      }
      return message.status === "compacting" ? session : { ...session, compacting: false };
    }
    case "compact_boundary": {
      const meta = isRec(message.compact_metadata) ? message.compact_metadata : {};
      const pre = num(meta.pre_tokens);
      const post = num(meta.post_tokens);
      const text = `Conversation compacted${meta.trigger === "auto" ? " automatically" : ""}${pre ? ` · ${formatTokens(pre)} → ${post ? formatTokens(post) : "?"} tokens` : ""}`;
      // Replace the "Compacting…" line.
      const pending = [...session.items].reverse().find((item) => item.kind === "notice" && item.id.startsWith("compacting:"));
      const id = pending?.id ?? `compacted:${uuid}`;
      return { ...notice(session, null, id, "info", text), compacting: false, contextTokens: post || session.contextTokens };
    }
    case "api_retry": {
      const status = typeof message.error_status === "number" ? ` ${message.error_status}` : "";
      const seconds = Math.max(1, Math.round(num(message.retry_delay_ms) / 1000));
      const text = `API error${status} (${str(message.error) ?? "unknown"}). Retrying in ${seconds}s · attempt ${num(message.attempt)} of ${num(message.max_retries)}`;
      const last = session.items[session.items.length - 1];
      return notice(session, null, last?.kind === "notice" && last.id.startsWith("retry:") ? last.id : `retry:${uuid}`, "warn", text);
    }
    case "local_command_output":
      return withThread(session, null, (items) => upsert(items, { kind: "command", id: uuid, text: str(message.content) ?? "" }));
    case "permission_denied": {
      const id = str(message.tool_use_id);
      if (id && session.tools[id]) return patchTool(session, id, { status: "denied" });
      return notice(session, null, `denied:${uuid}`, "warn", str(message.message) ?? "A tool call was denied.");
    }
    case "informational": {
      const level = message.level;
      return notice(session, null, `info:${uuid}`, level === "warning" ? "warn" : "info", str(message.content) ?? "");
    }
    case "hook_response":
      if (message.outcome !== "error") return session;
      return notice(session, null, `hook:${uuid}`, "warn", `Hook ${str(message.hook_name) ?? ""} failed${message.stderr ? `: ${String(message.stderr).trim()}` : ""}`);
    case "commands_changed":
      return session.init && Array.isArray(message.commands) ? { ...session, init: { ...session.init, commands: message.commands as NonNullable<ClaudeSession["init"]>["commands"] } } : session;
    case "task_started": {
      if (message.ambient === true || message.skip_transcript === true) return session;
      const id = str(message.task_id);
      if (!id) return session;
      const previous = session.tasks[id];
      const task: Task = {
        ...previous,
        id,
        toolUseId: str(message.tool_use_id) ?? previous?.toolUseId,
        parentTaskId: str(message.parent_task_id) ?? previous?.parentTaskId,
        description: str(message.description) ?? previous?.description ?? "Task",
        subagentType: str(message.subagent_type) ?? previous?.subagentType,
        taskType: str(message.task_type) ?? previous?.taskType,
        prompt: str(message.prompt) ?? previous?.prompt,
        status: "running",
        backgrounded: typeof message.is_backgrounded === "boolean" ? message.is_backgrounded : previous?.backgrounded,
        startedAt: now,
        endedAt: undefined,
      };
      return { ...session, tasks: { ...session.tasks, [id]: task } };
    }
    case "task_progress": {
      const task = session.tasks[str(message.task_id) ?? ""];
      if (!task) return session;
      const usage = isRec(message.usage) ? message.usage : {};
      return {
        ...session,
        tasks: {
          ...session.tasks,
          [task.id]: {
            ...task,
            // The title stays what the task started as; a progress `description` can be
            // the current activity ("Reading test.js"), so it only stands in for a summary.
            totalTokens: num(usage.total_tokens) || task.totalTokens,
            toolUses: num(usage.tool_uses) || task.toolUses,
            durationMs: num(usage.duration_ms) || task.durationMs,
            lastToolName: str(message.last_tool_name) ?? task.lastToolName,
            summary: str(message.summary) ?? (str(message.description) !== task.description ? str(message.description) : undefined) ?? task.summary,
          },
        },
      };
    }
    case "task_updated": {
      const task = session.tasks[str(message.task_id) ?? ""];
      const patch = isRec(message.patch) ? message.patch : {};
      if (!task) return session;
      const ended = typeof patch.end_time === "number" ? patch.end_time : undefined;
      return {
        ...session,
        tasks: {
          ...session.tasks,
          [task.id]: {
            ...task,
            status: (str(patch.status) as Task["status"] | undefined) ?? task.status,
            description: str(patch.description) ?? task.description,
            error: str(patch.error) ?? task.error,
            backgrounded: typeof patch.is_backgrounded === "boolean" ? patch.is_backgrounded : task.backgrounded,
            endedAt: ended ?? task.endedAt,
          },
        },
      };
    }
    case "task_notification": {
      const task = session.tasks[str(message.task_id) ?? ""];
      if (!task) return session;
      const usage = isRec(message.usage) ? message.usage : {};
      return {
        ...session,
        tasks: {
          ...session.tasks,
          [task.id]: {
            ...task,
            status: (str(message.status) as Task["status"] | undefined) ?? "completed",
            summary: str(message.summary) || task.summary,
            totalTokens: num(usage.total_tokens) || task.totalTokens,
            toolUses: num(usage.tool_uses) || task.toolUses,
            durationMs: num(usage.duration_ms) || task.durationMs,
            endedAt: now,
          },
        },
      };
    }
    default:
      return session;
  }
};

const onToolProgress: Handler = (session, message) => {
  const tool = session.tools[str(message.tool_use_id) ?? ""];
  if (!tool) return session;
  const status = tool.status === "streaming" || tool.status === "pending" ? "running" : tool.status;
  return patchTool(session, tool.id, { elapsed: num(message.elapsed_time_seconds), status });
};

const RESET_NOTICES: Record<string, string> = {
  clear: "Conversation cleared",
  plan_mode_exit: "Started a fresh conversation with the approved plan",
  fresh_session: "Started a fresh conversation",
  onboarding: "Conversation reset",
};

/** The CLI started a new conversation (whatever the trigger): the transcript starts over. */
const onConversationReset: Handler = (session, message, now) => {
  const text = RESET_NOTICES[str(message.trigger) ?? ""] ?? "Conversation reset";
  // A new conversation: its own id (saved by the store) and, from its first prompt, its own title.
  const sessionId = str(message.new_conversation_id) ?? session.sessionId;
  return notice(
    { ...session, sessionId, title: undefined, items: [], subTranscripts: {}, tools: {}, todos: [], streams: undefined },
    null,
    `reset:${str(message.uuid) ?? now}`,
    "info",
    text,
  );
};

/** Applies one SDK message to a session. */
export function reduce(session: ClaudeSession, message: SDKMessage, now: number = Date.now()): ClaudeSession {
  const record = message as unknown as Rec;
  switch (message.type) {
    case "stream_event":
      return onStreamEvent(session, record, now);
    case "assistant":
      return onAssistant(session, record, now);
    case "user":
      return onUser(session, record, now);
    case "result":
      return onResult(session, record, now);
    case "system":
      return onSystem(session, record, now);
    case "tool_progress":
      return onToolProgress(session, record, now);
    case "rate_limit_event":
      return { ...session, rateLimit: message.rate_limit_info };
    case "conversation_reset":
      return onConversationReset(session, record, now);
    default:
      return session;
  }
}

/** What a past session's transcript gives a session (`sessions.messages`). */
export type LoadedTranscript = Pick<ClaudeSession, "items" | "subTranscripts" | "tools" | "todos" | "tasks" | "contextTokens">;

/** A resumed session's transcript, from its saved messages. Nothing is left running. */
export function fromSessionMessages(messages: readonly SessionMessage[], now: number = Date.now()): LoadedTranscript {
  let session = createSession({ key: "", paneId: "", cwd: "" });
  for (const message of messages) {
    if (message.type !== "user" && message.type !== "assistant") continue;
    const sdk = { type: message.type, message: message.message, parent_tool_use_id: message.parent_tool_use_id, uuid: message.uuid, session_id: message.session_id, isReplay: true };
    session = reduce(session, sdk as unknown as SDKMessage, now);
  }
  session = settleSession(session, now);
  const { items, subTranscripts, tools, todos, tasks, contextTokens } = session;
  return { items, subTranscripts, tools, todos, tasks, contextTokens };
}

/** 1234 → "1.2k", 152000 → "152k". */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
