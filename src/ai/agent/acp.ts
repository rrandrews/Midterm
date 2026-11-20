import type { AcpEvent, AcpPromptRequest, AcpStop, AcpToolResult, AgentToolCall, AiError } from "../../ipc/ai";
import { toAiError } from "../../ipc/ai";
import { redact } from "../context";
import {
  CANCELLED,
  type Conversation,
  type ConversationHandle,
  type ToolCallDeps,
  type ToolStatus,
  addItem,
  itemOf,
  patchItem,
  removeItem,
  resultContent,
  runToolCall,
  stopped,
} from "./loop";

/*
 * The ACP driver (see docs/ai.md "Agent"): for CLI profiles, the CLI runs
 * the tool loop in a long-lived ACP session the backend keeps per
 * conversation, and Midterm supplies the system prompt, the tools and the
 * confirmations. One `ai_acp_prompt` per user message; its events map onto
 * the same transcript items as `runTurn`'s:
 *
 * - `text` appends to the streaming answer; a new answer starts after a
 *   tool row;
 * - `toolCall` (one of our tools) runs through `runToolCall`, the same
 *   resolve / confirm / invoke / redact path as the API loop, one call at a
 *   time, and its result goes back with `ai_acp_tool_result`;
 * - `toolCallCancelled` (the agent withdrew one call while the prompt goes
 *   on) is handled at once, not in turn: a pending confirmation is
 *   declined, the tool is not run (or is aborted) and no result is sent;
 * - `sessionStarted` (the backend started a new session for this prompt)
 *   adds a note when the conversation had one: its earlier context is gone;
 * - `foreignTool` (a tool the CLI ran itself: the lockdown leaked) is a
 *   muted row.
 *
 * The session keeps the history, so `messages` only records the prompts the
 * session has seen (the first one starts with the context line). Pure apart
 * from its injected dependencies (`AcpDeps`), so it is tested with fakes.
 */

/** Our tool calls per prompt; past it the prompt is cancelled and a note offers Continue. */
export const MAX_ACP_TOOL_CALLS = 30;
/** What Continue sends after the tool-call cap or the CLI's own request limit. */
export const CONTINUE_PROMPT = "Continue where you left off.";

const CAPPED = `Not run: the limit of ${MAX_ACP_TOOL_CALLS} tool calls per message was reached`;
const WITHDRAWN = "Withdrawn by the CLI";
/** The note when a conversation's session was replaced (evicted, failed, or ended with its window). */
export const SESSION_LOST = "The CLI session had ended, so a new one was started; the earlier context is gone.";

export type AcpDeps = ToolCallDeps & {
  prompt(request: AcpPromptRequest, onEvent: (event: AcpEvent) => void): Promise<{ stop: AcpStop }>;
  toolResult(result: AcpToolResult): Promise<void>;
  cancel(requestId: string): void;
  /** The short context line the first prompt starts with (OS, pane, directory, branch). */
  contextLine(conversation: Conversation): Promise<string>;
  newRequestId(): string;
};

/**
 * Runs one user message (or, with `text` null, Retry: the failed prompt
 * again; Continue: `CONTINUE_PROMPT`) as one prompt in the conversation's
 * ACP session, until it stops, fails or `signal` aborts (Stop).
 */
export async function runAcpTurn(h: ConversationHandle, text: string | null, deps: AcpDeps, signal: AbortSignal): Promise<void> {
  const before = h.get();
  if (before.status === "running") return;
  h.update((c) => ({ ...c, status: "running", resume: undefined, retryText: undefined }));
  try {
    let prompt: string;
    if (text !== null) {
      const first = h.get().messages.length === 0;
      const context = first ? redact(await deps.contextLine(h.get())) : "";
      const said = redact(text.trim());
      addItem(h, { type: "user", text: text.trim() });
      prompt = context ? `${context}\n\n${said}` : said;
    } else {
      prompt = before.resume === "retry" && before.retryText !== undefined ? before.retryText : CONTINUE_PROMPT;
    }
    if (signal.aborted) return stopped(h);
    await onePrompt(h, prompt, deps, signal);
  } finally {
    h.update((c) => ({ ...c, status: "idle" }));
  }
}

async function onePrompt(h: ConversationHandle, text: string, deps: AcpDeps, signal: AbortSignal): Promise<void> {
  const conversation = h.get();
  const requestId = deps.newRequestId();
  // Aborts on Stop and once the prompt settles: a confirmation or tool still pending then is declined.
  const local = new AbortController();
  const onAbort = () => {
    deps.cancel(requestId);
    local.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  let answerId: number | undefined;
  let settled = false;
  let calls = 0;
  let capped = false;
  let delivery: AiError | undefined;
  const foreign = new Map<string, number>();
  /** The session has seen earlier prompts: a new session means lost context. */
  const hadSession = conversation.messages.length > 0;
  /** Calls the agent withdrew, and the running calls' own abort. */
  const withdrawn = new Set<string>();
  const running = new Map<string, AbortController>();

  /** Ends the streaming answer: trimmed, or removed when empty. */
  const endAnswer = (patch: { stopped?: boolean; cut?: boolean } = {}): boolean => {
    if (answerId === undefined) return false;
    const id = answerId;
    answerId = undefined;
    const item = itemOf(h, id);
    if (item?.type !== "assistant") return false;
    const answer = item.text.trim();
    if (!answer) {
      removeItem(h, id);
      return false;
    }
    patchItem(h, id, { text: answer, streaming: false, ...patch });
    return true;
  };

  const onText = (chunk: string) => {
    if (!chunk || signal.aborted) return;
    if (answerId === undefined) {
      if (!chunk.trim()) return;
      answerId = addItem(h, { type: "assistant", text: chunk.trimStart(), streaming: true });
      return;
    }
    const item = itemOf(h, answerId);
    if (item?.type === "assistant") patchItem(h, answerId, { text: item.text + chunk });
  };

  const onToolCall = async (event: Extract<AcpEvent, { type: "toolCall" }>) => {
    endAnswer();
    const call: AgentToolCall = { id: event.callId, name: event.name, input: event.input };
    calls += 1;
    let skip: { status: ToolStatus; error: string } | undefined;
    if (settled) skip = { status: "cancelled", error: CANCELLED };
    else if (calls > MAX_ACP_TOOL_CALLS) {
      skip = { status: "skipped", error: CAPPED };
      if (!capped) {
        capped = true;
        deps.cancel(requestId);
      }
    }
    if (!skip && withdrawn.has(call.id)) skip = { status: "cancelled", error: WITHDRAWN };
    // Aborts on Stop, when the prompt settles, or when the agent withdraws this call.
    const own = new AbortController();
    const abortOwn = () => own.abort();
    local.signal.addEventListener("abort", abortOwn, { once: true });
    if (local.signal.aborted) own.abort();
    running.set(call.id, own);
    let result: { content: string; isError: boolean };
    try {
      result = await runToolCall(h, call, deps, own.signal, skip);
    } finally {
      running.delete(call.id);
      local.signal.removeEventListener("abort", abortOwn);
    }
    if (withdrawn.has(call.id)) {
      const row = h.get().items.find((item) => item.type === "tool" && item.callId === call.id);
      if (row) patchItem(h, row.id, { status: "cancelled", result: resultContent({ error: WITHDRAWN }) });
      return;
    }
    if (settled) return;
    try {
      await deps.toolResult({ conversationId: conversation.id, callId: call.id, content: result.content, isError: result.isError });
    } catch (caught) {
      // The CLI would wait for this result forever: stop the prompt and say why.
      if (!settled && !delivery) {
        delivery = toAiError(caught);
        deps.cancel(requestId);
      }
    }
  };

  const onForeign = (event: Extract<AcpEvent, { type: "foreignTool" }>) => {
    const existing = foreign.get(event.id);
    if (existing !== undefined && itemOf(h, existing)) {
      patchItem(h, existing, event.title ? { title: event.title, status: event.status } : { status: event.status });
      return;
    }
    endAnswer();
    foreign.set(event.id, addItem(h, { type: "foreign", foreignId: event.id, title: event.title, status: event.status }));
  };

  // Handled in order, one at a time: a tool call (and its confirmation) holds back what follows it.
  let queue: Promise<void> = Promise.resolve();
  const onEvent = (event: AcpEvent) => {
    if (event.type === "toolCallCancelled") {
      // Not queued: the call it withdraws may be holding the queue.
      withdrawn.add(event.callId);
      running.get(event.callId)?.abort();
      return;
    }
    queue = queue
      .then(() => {
        if (event.type === "text") onText(event.text);
        else if (event.type === "toolCall") return onToolCall(event);
        else if (event.type === "foreignTool") onForeign(event);
        else if (event.type === "sessionStarted" && hadSession) addItem(h, { type: "note", text: SESSION_LOST });
      })
      .catch((error: unknown) => console.error("An agent event failed:", error));
  };

  let stop: AcpStop | undefined;
  let error: AiError | undefined;
  try {
    stop = (
      await deps.prompt(
        { requestId, conversationId: conversation.id, target: conversation.target, system: conversation.toolset.system, tools: conversation.toolset.tools, text },
        onEvent,
      )
    ).stop;
  } catch (caught) {
    error = toAiError(caught);
  } finally {
    signal.removeEventListener("abort", onAbort);
    settled = true;
    local.abort();
  }
  await queue;

  /** The session has seen this prompt (the context line is not sent again). */
  const seen = () => h.update((c) => ({ ...c, messages: [...c.messages, { role: "user", text }] }));

  if (delivery) {
    endAnswer({ stopped: true });
    seen();
    addItem(h, { type: "error", message: `Could not send a tool result to the CLI: ${delivery.message}` });
    h.update((c) => ({ ...c, resume: "continue" }));
    return;
  }
  if (capped) {
    endAnswer({ stopped: true });
    seen();
    addItem(h, { type: "note", text: `Stopped after ${MAX_ACP_TOOL_CALLS} tool calls.` });
    h.update((c) => ({ ...c, resume: "continue" }));
    return;
  }
  if (signal.aborted || stop === "cancelled" || error?.kind === "cancelled") {
    if (!error) seen();
    // The answer itself says "stopped".
    if (!endAnswer({ stopped: true })) stopped(h);
    return;
  }
  if (error) {
    endAnswer();
    addItem(h, { type: "error", message: error.message });
    h.update((c) => ({ ...c, resume: "retry", retryText: text }));
    return;
  }
  seen();
  switch (stop) {
    case "length":
      if (!endAnswer({ cut: true })) addItem(h, { type: "note", text: "The reply was cut off at the token limit." });
      return;
    case "refused":
      endAnswer();
      addItem(h, { type: "error", message: "The model refused this request." });
      h.update((c) => ({ ...c, resume: "retry", retryText: text }));
      return;
    case "maxRequests":
      endAnswer();
      addItem(h, { type: "note", text: "The CLI stopped after its own limit of requests." });
      h.update((c) => ({ ...c, resume: "continue" }));
      return;
    default:
      endAnswer();
  }
}
