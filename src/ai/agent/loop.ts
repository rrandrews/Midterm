import type { AgentEvent, AgentMessage, AgentToolCall, AgentTurn, AgentTurnRequest, AiTarget } from "../../ipc/ai";
import { toAiError } from "../../ipc/ai";
import type { ToolResult, WriteConfirmation } from "../../plugins/skills";
import { redact } from "../context";
import type { Toolset } from "./tools";

/*
 * The agent loop (see docs/ai.md "Agent"): one backend call per model turn,
 * the turn's tool calls run in order, one at a time, their results sent
 * back, until the model answers without calling a tool. Pure apart from
 * its injected dependencies (`LoopDeps`), so it is tested with fakes.
 *
 * Rules that keep the history valid for every provider:
 * - assistant turns are appended verbatim (`raw`) and only once complete;
 *   a turn that is cancelled or fails is not appended;
 * - every tool call of an appended turn gets a result, even when it is not
 *   run (cut off, Stop pressed).
 */

/** Model rounds per user message. */
export const MAX_ROUNDS = 12;
/** A tool result is clipped to this many characters (head and tail kept). */
export const RESULT_LIMIT = 16_000;
/** Reply budget per turn (effort headroom is added by the backend). */
export const AGENT_REPLY_TOKENS = 4096;

export type ToolStatus = "running" | "asking" | "done" | "failed" | "denied" | "cancelled" | "skipped";

export type TranscriptItem =
  | { id: number; type: "user"; text: string }
  | { id: number; type: "assistant"; text: string; streaming: boolean; stopped?: boolean; cut?: boolean }
  | {
      id: number;
      type: "tool";
      callId: string;
      /** The wire name the model called. */
      name: string;
      skillTitle: string;
      tool: string;
      input: unknown;
      /** The raw arguments when they were not JSON. */
      invalid?: string;
      write: boolean;
      status: ToolStatus;
      /** What was sent back to the model. */
      result?: string;
    }
  | { id: number; type: "skill"; skillId: string; title: string }
  /** A tool the CLI ran on its own (ACP; it means the lockdown leaked): shown muted, never run by Midterm. */
  | { id: number; type: "foreign"; foreignId: string; title: string; status: "running" | "done" | "failed" | "denied" }
  | { id: number; type: "error"; message: string }
  | { id: number; type: "note"; text: string };

/** Distributes `Omit` over the union, so each item keeps its own fields. */
export type NewItem = TranscriptItem extends infer T ? (T extends TranscriptItem ? Omit<T, "id"> : never) : never;

/** Which driver runs a conversation: `runTurn` over `ai_agent_turn` (API profiles), or `runAcpTurn` over an ACP session (CLI profiles). */
export type AgentBackend = "api" | "acp";

export type Conversation = {
  id: string;
  backend: AgentBackend;
  /** Frozen for the conversation: providers reject replayed thinking when these change. */
  target: AiTarget;
  toolset: Toolset;
  /** The model's name, for headers. */
  model: string;
  /** The pane the agent works with (tools act on it when no pane is named). */
  targetPane: string;
  messages: AgentMessage[];
  items: TranscriptItem[];
  status: "idle" | "running";
  /** What the last stop offers: Retry (a failed turn) or Continue (the round cap). */
  resume?: "retry" | "continue";
  /** ACP: the prompt text of the last failed prompt, sent again by Retry. */
  retryText?: string;
  /** Write tools (wire names) the user allowed for the whole conversation. */
  allowed: string[];
  nextItem: number;
};

/** Reads and updates one conversation (a store entry in the app, a variable in tests). */
export type ConversationHandle = {
  get(): Conversation;
  update(change: (conversation: Conversation) => Conversation): void;
};

export type ConfirmAnswer = "allow" | "always" | "deny";

/** What running one tool call needs (shared by both drivers). */
export type ToolCallDeps = Pick<LoopDeps, "invoke" | "ask">;

export type LoopDeps = {
  turn(request: AgentTurnRequest, onEvent: (event: AgentEvent) => void): Promise<AgentTurn>;
  cancel(requestId: string): void;
  invoke(
    skillId: string,
    toolName: string,
    input: unknown,
    options: { paneId?: string; signal?: AbortSignal; confirm?: WriteConfirmation },
  ): Promise<ToolResult>;
  /** Asks the user about a write tool; should resolve "deny" when `signal` aborts. */
  ask(call: { conversationId: string; callId: string }, signal: AbortSignal): Promise<ConfirmAnswer>;
  /** The short context line the first user message starts with (OS, pane, directory, branch). */
  contextLine(conversation: Conversation): Promise<string>;
  newRequestId(): string;
};

/** A blank conversation over a frozen target and toolset. */
export function newConversation(id: string, target: AiTarget, toolset: Toolset, targetPane: string, backend: AgentBackend = "api"): Conversation {
  return { id, backend, target, toolset, model: target.model || target.provider.id, targetPane, messages: [], items: [], status: "idle", allowed: [], nextItem: 1 };
}

/** `text` with its middle dropped beyond `limit` characters. */
export function clipMiddle(text: string, limit = RESULT_LIMIT): string {
  if (text.length <= limit) return text;
  const marker = `\n… ${text.length - limit} characters left out …\n`;
  const half = Math.floor((limit - marker.length) / 2);
  return `${text.slice(0, half)}${marker}${text.slice(text.length - half)}`;
}

/** `value` with every string (keys too) redacted, so secrets are matched before JSON escapes their quotes and line breaks. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redact(value);
  if (depth > 64 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactValue(item, depth + 1)]));
}

/** A tool result as sent to the model: string values redacted, JSON, redacted again as a whole, clipped. */
export function resultContent(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(redactValue(value)) ?? "null";
  } catch {
    json = JSON.stringify({ error: "The result could not be serialized" });
  }
  return clipMiddle(redact(json));
}

export const CANCELLED = "Cancelled by the user";
const CUT_OFF = "Not run: the reply was cut off";

export function addItem(h: ConversationHandle, item: NewItem): number {
  let id = 0;
  h.update((c) => {
    id = c.nextItem;
    return { ...c, nextItem: c.nextItem + 1, items: [...c.items, { ...item, id } as TranscriptItem] };
  });
  return id;
}

export function patchItem(h: ConversationHandle, id: number, patch: Partial<TranscriptItem>): void {
  h.update((c) => ({ ...c, items: c.items.map((item) => (item.id === id ? ({ ...item, ...patch } as TranscriptItem) : item)) }));
}

export function removeItem(h: ConversationHandle, id: number): void {
  h.update((c) => ({ ...c, items: c.items.filter((item) => item.id !== id) }));
}

export function itemOf(h: ConversationHandle, id: number): TranscriptItem | undefined {
  return h.get().items.find((item) => item.id === id);
}

/** Resolves when `signal` aborts (never rejects). */
export function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Runs one tool call the model made: adds its row (none for `load_skill`,
 * which adds a "Loaded skill" item), resolves it, asks before a write tool
 * (through `deps.ask`, remembering "always" per wire name), invokes the
 * skill tool on the conversation's pane, and returns the result as sent to
 * the model (redacted, clipped). `skip` marks it not run (a reply cut off,
 * a cap reached). Never throws for the tool's own failures.
 */
export async function runToolCall(
  h: ConversationHandle,
  call: AgentToolCall,
  deps: ToolCallDeps,
  signal: AbortSignal,
  skip?: { status: ToolStatus; error: string },
): Promise<{ content: string; isError: boolean }> {
  const conversation = h.get();
  const resolved = conversation.toolset.resolve(call.name);
  const write = resolved?.kind === "tool" && resolved.effect === "write";
  const isLoad = resolved?.kind === "load_skill";
  const rowId = isLoad
    ? undefined
    : addItem(h, {
        type: "tool",
        callId: call.id,
        name: call.name,
        skillTitle: resolved?.kind === "tool" ? resolved.skillTitle : "Unknown",
        tool: resolved?.kind === "tool" ? resolved.toolName : call.name,
        input: call.input,
        invalid: call.invalid,
        write,
        status: "running",
      });
  const finish = (status: ToolStatus, value: unknown, isError: boolean) => {
    const content = resultContent(value);
    if (rowId !== undefined) patchItem(h, rowId, { status, result: content });
    return { content, isError };
  };

  if (skip) return finish(skip.status, { error: skip.error }, true);
  if (signal.aborted) return finish("cancelled", { error: CANCELLED }, true);
  if (call.invalid !== undefined) {
    return finish("failed", { INVALID_JSON: "The arguments were not valid JSON", arguments: clipMiddle(call.invalid, 2000) }, true);
  }
  if (!resolved) return finish("failed", { error: `No tool named "${call.name}"` }, true);
  if (resolved.kind === "load_skill") {
    const skillId = (call.input as { skill?: unknown } | null)?.skill;
    const loaded = typeof skillId === "string" ? conversation.toolset.loadSkill(skillId) : undefined;
    if (!loaded) return finish("failed", { error: `No enabled skill "${String(skillId)}"` }, true);
    addItem(h, { type: "skill", skillId: loaded.skill, title: loaded.title });
    return finish("done", loaded, false);
  }

  let denied = false;
  const confirm: WriteConfirmation = async () => {
    if (h.get().allowed.includes(call.name)) return true;
    if (rowId !== undefined) patchItem(h, rowId, { status: "asking" });
    const answer = await deps.ask({ conversationId: conversation.id, callId: call.id }, signal);
    if (answer === "always") h.update((c) => (c.allowed.includes(call.name) ? c : { ...c, allowed: [...c.allowed, call.name] }));
    denied = answer === "deny";
    if (rowId !== undefined) patchItem(h, rowId, { status: denied ? "denied" : "running" });
    return !denied;
  };
  const result = await Promise.race([
    deps.invoke(resolved.skillId, resolved.toolName, call.input, { paneId: h.get().targetPane, signal, confirm }),
    aborted(signal).then(() => null),
  ]);
  if (result === null || (signal.aborted && !result.ok)) return finish("cancelled", { error: CANCELLED }, true);
  if (result.ok) return finish("done", result.result, false);
  if (denied) return finish("denied", { error: "The user denied this action." }, true);
  return finish("failed", { error: result.error }, true);
}

/**
 * Runs one user message (or, with `text` null, continues from the
 * history: Retry after a failed turn, Continue after the round cap) until
 * the model answers, a turn fails, the round cap is reached or `signal`
 * aborts (Stop).
 */
export async function runTurn(h: ConversationHandle, text: string | null, deps: LoopDeps, signal: AbortSignal): Promise<void> {
  if (h.get().status === "running") return;
  h.update((c) => ({ ...c, status: "running", resume: undefined }));
  try {
    if (text !== null) {
      const first = h.get().messages.length === 0;
      const context = first ? redact(await deps.contextLine(h.get())) : "";
      const said = redact(text.trim());
      addItem(h, { type: "user", text: text.trim() });
      h.update((c) => ({ ...c, messages: [...c.messages, { role: "user", text: context ? `${context}\n\n${said}` : said }] }));
    }
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal.aborted) return stopped(h);
      const outcome = await oneRound(h, deps, signal);
      if (outcome !== "again") return;
    }
    addItem(h, { type: "note", text: `Stopped after ${MAX_ROUNDS} steps.` });
    h.update((c) => ({ ...c, resume: "continue" }));
  } finally {
    h.update((c) => ({ ...c, status: "idle" }));
  }
}

export function stopped(h: ConversationHandle): void {
  addItem(h, { type: "note", text: "Stopped." });
}

/** One model turn and its tool calls. "again" when the model is waiting for tool results. */
async function oneRound(h: ConversationHandle, deps: LoopDeps, signal: AbortSignal): Promise<"again" | "done"> {
  const conversation = h.get();
  const requestId = deps.newRequestId();
  let answerId: number | undefined;
  const onEvent = (event: AgentEvent) => {
    if (event.type !== "text" || !event.text || signal.aborted) return;
    if (answerId === undefined) answerId = addItem(h, { type: "assistant", text: event.text.trimStart(), streaming: true });
    else {
      const item = itemOf(h, answerId);
      if (item?.type === "assistant") patchItem(h, answerId, { text: item.text + event.text });
    }
  };
  const onAbort = () => deps.cancel(requestId);
  signal.addEventListener("abort", onAbort, { once: true });
  let turn: AgentTurn;
  try {
    turn = await deps.turn(
      {
        requestId,
        target: conversation.target,
        system: conversation.toolset.system,
        tools: conversation.toolset.tools,
        messages: conversation.messages,
        maxTokens: AGENT_REPLY_TOKENS,
      },
      onEvent,
    );
  } catch (caught) {
    const error = toAiError(caught);
    const partial = answerId === undefined ? undefined : itemOf(h, answerId);
    if (signal.aborted || error.kind === "cancelled") {
      // The history stays as it was; partial text stays in the transcript.
      if (partial?.type === "assistant" && partial.text.trim()) {
        // The answer itself says "stopped".
        patchItem(h, answerId!, { streaming: false, stopped: true });
        return "done";
      }
      if (answerId !== undefined) removeItem(h, answerId);
      stopped(h);
      return "done";
    }
    if (answerId !== undefined) removeItem(h, answerId);
    addItem(h, { type: "error", message: error.message });
    h.update((c) => ({ ...c, resume: "retry" }));
    return "done";
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) {
    // Finished as Stop was pressed: treated as cancelled, not appended.
    if (answerId !== undefined) patchItem(h, answerId, { streaming: false, stopped: true });
    else stopped(h);
    return "done";
  }

  h.update((c) => ({ ...c, messages: [...c.messages, { role: "assistant", raw: turn.raw }] }));
  const answer = turn.text.trim();
  if (answer) {
    if (answerId === undefined) answerId = addItem(h, { type: "assistant", text: answer, streaming: false });
    else patchItem(h, answerId, { text: answer, streaming: false });
  } else if (answerId !== undefined) removeItem(h, answerId);

  if (turn.toolCalls.length === 0) {
    if (turn.stop === "length" && answerId !== undefined) patchItem(h, answerId, { cut: true });
    return "done";
  }

  const results: { id: string; content: string; isError?: boolean }[] = [];
  const cutOff = turn.stop === "length";
  for (const call of turn.toolCalls) {
    const { content, isError } = await runToolCall(h, call, deps, signal, cutOff ? { status: "skipped", error: CUT_OFF } : undefined);
    results.push(isError ? { id: call.id, content, isError } : { id: call.id, content });
  }
  h.update((c) => ({ ...c, messages: [...c.messages, { role: "tool", results }] }));

  if (cutOff) {
    addItem(h, { type: "error", message: "The reply was cut off at the token limit, so its tool calls were not run." });
    h.update((c) => ({ ...c, resume: "retry" }));
    return "done";
  }
  if (signal.aborted) {
    stopped(h);
    return "done";
  }
  return "again";
}
