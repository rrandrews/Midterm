import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { AI_PROTECTED_KEYS, type EffortLevel } from "../settings/schema";

/*
 * Typed wrapper around the AI commands (src-tauri/src/ai/, docs/ai.md).
 * Requests are made by the backend; keys live in the OS keychain and never
 * come back to the webview. In a plain browser a mock answers instead.
 */

export type ProviderId =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "openrouter"
  | "gemini"
  | "custom"
  | "claude-code"
  | "codex"
  | "antigravity";

export type ProviderInfo = {
  id: ProviderId;
  name: string;
  type: "api" | "cli";
  /** API providers: whether a key is required (`custom` may go without). */
  needsKey: boolean;
  /** CLI providers: the executable looked up on the login shell's PATH. */
  executable?: string;
};

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", type: "api", needsKey: true },
  { id: "openai", name: "OpenAI", type: "api", needsKey: true },
  { id: "gemini", name: "Google Gemini", type: "api", needsKey: true },
  { id: "deepseek", name: "DeepSeek", type: "api", needsKey: true },
  { id: "openrouter", name: "OpenRouter", type: "api", needsKey: true },
  { id: "custom", name: "Custom (OpenAI-compatible)", type: "api", needsKey: false },
  { id: "claude-code", name: "Claude Code", type: "cli", needsKey: false, executable: "claude" },
  { id: "codex", name: "Codex", type: "cli", needsKey: false, executable: "codex" },
  { id: "antigravity", name: "Antigravity", type: "cli", needsKey: false, executable: "agy" },
];

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export type ProviderConfig = { id: ProviderId; baseUrl?: string; cliPath?: string };

/**
 * What a request goes to: a model profile resolved for a feature (see
 * `ai/profiles.ts`). `effort` absent: Midterm's pick. `extra` is merged into
 * the request body (API providers only).
 */
export type AiTarget = { provider: ProviderConfig; model: string; effort?: EffortLevel; extra?: Record<string, unknown> };

/** Top-level request keys extra JSON may not set (mirrors `PROTECTED` in src-tauri/src/ai/extra.rs). */
export const PROTECTED_EXTRA_KEYS: readonly string[] = AI_PROTECTED_KEYS;

export type AiErrorKind =
  | "noKey"
  | "auth"
  | "network"
  | "http"
  | "refused"
  | "empty"
  | "timeout"
  | "cancelled"
  | "notFound"
  | "other";

export type AiError = { kind: AiErrorKind; message: string };

export function isAiError(value: unknown): value is AiError {
  return typeof value === "object" && value !== null && "kind" in value && "message" in value;
}

/** Any rejection as an `AiError`. */
export function toAiError(error: unknown): AiError {
  if (isAiError(error)) return error;
  return { kind: "other", message: error instanceof Error ? error.message : String(error) };
}

export type SuggestRequest = {
  requestId: string;
  target: AiTarget;
  system: string;
  prompt: string;
  maxTokens?: number;
};

/** A streamed reply. `text` is the whole reply and authoritative over the deltas. */
export type StreamReply = { text: string; stop: "end" | "length"; effortDropped: boolean };

/** A message on `ai_stream`'s channel. */
type StreamEvent = { type: "delta"; text: string };

/** A level the backend sends (`default` is not one: it sends nothing). */
export type Effort = Exclude<EffortLevel, "default">;

/** What Settings → AI offers for reasoning effort. */
export type EffortOptions = {
  /** Offered levels, lowest first; "Provider default" is always offered too. */
  levels: Effort[];
  /** What the stored setting sends for this model; null: nothing. */
  effective: Effort | null;
  note: string | null;
};

/** Whether a CLI profile can run the agent over ACP (Claude Code only for now): the adapter found and checked, without starting a session. */
export type AgentStatus = {
  ready: boolean;
  adapter?: { path: string; version: string };
  /** Why it is not ready; may name the install command. */
  problem?: string;
  /** Shown muted, e.g. a version newer than the tested ones. */
  note?: string;
};

export type CliStatus = { found: boolean; path?: string; version?: string; outdated?: string; agent?: AgentStatus };

/* ---- Browser mock: a key store in memory and a canned suggestion. ---- */

const mockKeys = new Set<string>();
const mockPending = new Map<string, () => void>();

function mockSuggest(request: SuggestRequest): Promise<{ text: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mockPending.delete(request.requestId);
      const last = /\$ (.+)\n(?![\s\S]*\$ )/.exec(request.prompt)?.[1];
      resolve({ text: last?.startsWith("git add") ? 'git commit -m ""' : "git status" });
    }, 600);
    mockPending.set(request.requestId, () => {
      clearTimeout(timer);
      reject({ kind: "cancelled", message: "Cancelled" } satisfies AiError);
    });
  });
}

/** The browser mock's streamed answer, sent in about 12 chunks. */
const MOCK_STREAM = [
  "This is the **browser mock**",
  " streaming a reply.",
  "\n\nIt arrives in",
  " chunks, about",
  " 40 ms apart:",
  "\n\n- one\n",
  "- two\n",
  "- three\n\n",
  "```sh\n",
  "git status\n",
  "```\n",
  "\nDone.",
];

function mockStream(request: SuggestRequest, onDelta: (text: string) => void): Promise<StreamReply> {
  return new Promise((resolve, reject) => {
    let at = 0;
    const timer = setInterval(() => {
      if (at < MOCK_STREAM.length) {
        onDelta(MOCK_STREAM[at++]);
        return;
      }
      clearInterval(timer);
      mockPending.delete(request.requestId);
      resolve({ text: MOCK_STREAM.join("").trim(), stop: "end", effortDropped: false });
    }, 40);
    mockPending.set(request.requestId, () => {
      clearInterval(timer);
      reject({ kind: "cancelled", message: "Cancelled" } satisfies AiError);
    });
  });
}

/* ---- Agent turns (ai_agent_turn) ---- */

/** A tool the model may call, under its wire name (see `ai/agent/tools.ts`). */
export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

/** One message of an agent conversation. Assistant turns are replayed verbatim (`raw`, exactly what a turn returned). */
export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; raw: string }
  | { role: "tool"; results: { id: string; content: string; isError?: boolean }[] };

/** A message on `ai_agent_turn`'s channel. */
export type AgentEvent = { type: "text"; text: string } | { type: "toolCall"; id: string; name: string };

/** A tool call in a turn. `input` is null and `invalid` holds the raw text when the arguments were not JSON. */
export type AgentToolCall = { id: string; name: string; input: unknown; invalid?: string };

/** One model turn. `text` and `toolCalls` are authoritative over the events; `raw` goes back unchanged in the history. */
export type AgentTurn = {
  text: string;
  toolCalls: AgentToolCall[];
  raw: string;
  stop: "end" | "tools" | "length";
  effortDropped: boolean;
};

export type AgentTurnRequest = {
  requestId: string;
  target: AiTarget;
  system: string;
  tools: ToolDef[];
  messages: AgentMessage[];
  maxTokens?: number;
};

/**
 * The browser mock's agent: a `recent_blocks` call when that tool is
 * offered and nothing has been called since the last user message, then a
 * short Markdown answer in a few chunks.
 */
function mockAgentTurn(request: AgentTurnRequest, onEvent: (event: AgentEvent) => void): Promise<AgentTurn> {
  const lastUser = request.messages.map((message) => message.role).lastIndexOf("user");
  const called = request.messages.slice(lastUser + 1).some((message) => message.role === "tool");
  const tool = request.tools.find((candidate) => candidate.name.endsWith("__recent_blocks"));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    mockPending.set(request.requestId, () => {
      clearTimeout(timer);
      reject({ kind: "cancelled", message: "Cancelled" } satisfies AiError);
    });
    const done = (turn: AgentTurn) => {
      mockPending.delete(request.requestId);
      resolve(turn);
    };
    if (tool && !called) {
      timer = setTimeout(() => {
        const call = { id: `mock-${Date.now()}`, name: tool.name, input: { count: 3 } };
        onEvent({ type: "toolCall", id: call.id, name: call.name });
        const raw = JSON.stringify({
          role: "assistant",
          content: null,
          tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }],
        });
        done({ text: "", toolCalls: [call], raw, stop: "tools", effortDropped: false });
      }, 300);
      return;
    }
    const parts = ["The **browser mock** agent", " read the recent blocks.", "\n\nNothing else to do."];
    let at = 0;
    const next = () => {
      if (at < parts.length) {
        onEvent({ type: "text", text: parts[at++] });
        timer = setTimeout(next, 60);
        return;
      }
      const text = parts.join("");
      done({ text, toolCalls: [], raw: JSON.stringify({ role: "assistant", content: text }), stop: "end", effortDropped: false });
    };
    timer = setTimeout(next, 200);
  });
}

/* ---- ACP sessions (ai_acp_prompt; CLI profiles) ---- */

/**
 * A message on `ai_acp_prompt`'s channel. `toolCall` names use our wire names (no `mcp__midterm__` prefix).
 * `toolCallCancelled`: the agent withdrew that call (decline its confirmation, don't run it, send no result).
 * `sessionStarted` (first, when it applies): this prompt started a new session, so for a conversation that
 * had one, the earlier context is gone.
 */
export type AcpEvent =
  | { type: "text"; text: string }
  | { type: "toolCall"; callId: string; name: string; input: unknown }
  | { type: "toolCallCancelled"; callId: string }
  | { type: "sessionStarted" }
  | { type: "foreignTool"; id: string; title: string; status: "running" | "done" | "failed" | "denied" };

export type AcpStop = "end" | "length" | "refused" | "maxRequests" | "cancelled";

/**
 * One user prompt in a conversation's ACP session. The first prompt for a
 * `conversationId` creates the session; `system` and `tools` are only used
 * then (frozen per conversation).
 */
export type AcpPromptRequest = {
  requestId: string;
  conversationId: string;
  target: AiTarget;
  system: string;
  tools: ToolDef[];
  text: string;
};

export type AcpToolResult = { conversationId: string; callId: string; content: string; isError: boolean };

/** The browser mock's ACP sessions: tool calls waiting for their result, by call id. */
const mockAcpCalls = new Map<string, (result: AcpToolResult) => void>();

/**
 * The browser mock's ACP agent: a `recent_blocks` call when that tool is
 * offered, then (once its result is back) a short Markdown answer.
 */
function mockAcpPrompt(request: AcpPromptRequest, onEvent: (event: AcpEvent) => void): Promise<{ stop: AcpStop }> {
  const tool = request.tools.find((candidate) => candidate.name.endsWith("__recent_blocks"));
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let callId: string | undefined;
    const finish = () => {
      mockPending.delete(request.requestId);
      if (callId) mockAcpCalls.delete(callId);
    };
    mockPending.set(request.requestId, () => {
      clearTimeout(timer);
      finish();
      resolve({ stop: "cancelled" });
    });
    const answer = (parts: string[]) => {
      let at = 0;
      const next = () => {
        if (at < parts.length) {
          onEvent({ type: "text", text: parts[at++] });
          timer = setTimeout(next, 60);
          return;
        }
        finish();
        resolve({ stop: "end" });
      };
      timer = setTimeout(next, 200);
    };
    if (!tool) {
      answer(["The **browser mock** ACP agent", " has no tools to call."]);
      return;
    }
    timer = setTimeout(() => {
      callId = `mock-acp-${Date.now()}`;
      mockAcpCalls.set(callId, (result) => {
        if (result.isError) answer(["The **browser mock** ACP agent", " could not read the recent blocks."]);
        else answer(["The **browser mock** ACP agent", " read the recent blocks.", "\n\nNothing else to do."]);
      });
      onEvent({ type: "toolCall", callId, name: tool.name, input: { count: 3 } });
    }, 300);
  });
}

/**
 * One prompt in an ACP session: reply text, our tool calls (answer each
 * with `aiAcpToolResult`) and foreign tool rows arrive on `onEvent`
 * (events after the promise settled are dropped). Resolves with the stop
 * reason; failures reject like `aiStream`. Cancel with `aiCancel(requestId)`.
 */
export async function aiAcpPrompt(request: AcpPromptRequest, onEvent: (event: AcpEvent) => void): Promise<{ stop: AcpStop }> {
  let settled = false;
  const forward = (event: AcpEvent) => {
    if (!settled) onEvent(event);
  };
  try {
    if (!isTauri()) return await mockAcpPrompt(request, forward);
    const channel = new Channel<AcpEvent>();
    channel.onmessage = forward;
    return await invoke<{ stop: AcpStop }>("ai_acp_prompt", { ...request, onEvent: channel });
  } finally {
    settled = true;
  }
}

/** The result of a `toolCall` event, sent back to the CLI. */
export async function aiAcpToolResult(result: AcpToolResult): Promise<void> {
  if (!isTauri()) {
    const waiting = mockAcpCalls.get(result.callId);
    mockAcpCalls.delete(result.callId);
    waiting?.(result);
    return;
  }
  await invoke("ai_acp_tool_result", result);
}

/** Ends a conversation's ACP session (and its process); nothing when it has none. */
export async function aiAcpClose(conversationId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("ai_acp_close", { conversationId });
}

/* ---- Commands ---- */

export function aiSuggest(request: SuggestRequest): Promise<{ text: string }> {
  if (!isTauri()) return mockSuggest(request);
  return invoke<{ text: string }>("ai_suggest", request);
}

/**
 * One streamed completion: `onDelta` gets reply text as it arrives (append
 * it). The resolved `text` is the whole reply and authoritative; deltas
 * that arrive after the promise settled are dropped. Cancel with
 * `aiCancel(requestId)`.
 */
export async function aiStream(request: SuggestRequest, onDelta: (text: string) => void): Promise<StreamReply> {
  let settled = false;
  const forward = (text: string) => {
    if (!settled) onDelta(text);
  };
  try {
    if (!isTauri()) return await mockStream(request, forward);
    const onEvent = new Channel<StreamEvent>();
    onEvent.onmessage = (event) => {
      if (event.type === "delta") forward(event.text);
    };
    return await invoke<StreamReply>("ai_stream", { ...request, onEvent });
  } finally {
    settled = true;
  }
}

/**
 * One model turn of an agent conversation: reply text and tool calls
 * arrive on `onEvent` as they stream (events after the promise settled are
 * dropped). Rejects like `aiStream`; a CLI target rejects with `other`.
 * Cancel with `aiCancel(requestId)`.
 */
export async function aiAgentTurn(request: AgentTurnRequest, onEvent: (event: AgentEvent) => void): Promise<AgentTurn> {
  let settled = false;
  const forward = (event: AgentEvent) => {
    if (!settled) onEvent(event);
  };
  try {
    if (!isTauri()) return await mockAgentTurn(request, forward);
    const channel = new Channel<AgentEvent>();
    channel.onmessage = forward;
    return await invoke<AgentTurn>("ai_agent_turn", { ...request, onEvent: channel });
  } finally {
    settled = true;
  }
}

export async function aiCancel(requestId: string): Promise<void> {
  if (!isTauri()) {
    mockPending.get(requestId)?.();
    mockPending.delete(requestId);
    return;
  }
  await invoke("ai_cancel", { requestId });
}

/** The browser mock's model list: enough ids for the combobox to scroll and filter. */
const MOCK_MODELS = [
  "mock-small",
  "mock-large",
  "mock-reasoner",
  ...Array.from({ length: 40 }, (_, n) => `vendor-${String.fromCharCode(97 + (n % 26))}/model-${n + 1}`),
];

export function aiModels(provider: ProviderConfig): Promise<string[]> {
  if (!isTauri()) return Promise.resolve(providerInfo(provider.id)?.type === "api" ? MOCK_MODELS : []);
  return invoke<string[]>("ai_models", { provider });
}

export function aiTest(target: AiTarget): Promise<{ ok: boolean; message: string }> {
  if (!isTauri()) return Promise.resolve({ ok: true, message: "OK (browser mock)" });
  return invoke<{ ok: boolean; message: string }>("ai_test", { target });
}

const MOCK_LEVELS: Effort[] = ["low", "medium", "high"];

export function aiEffortOptions(target: AiTarget): Promise<EffortOptions> {
  if (!isTauri()) {
    const { effort } = target;
    const requested = effort === undefined ? "low" : effort === "default" ? null : effort;
    const effective = requested === null ? null : MOCK_LEVELS.includes(requested) ? requested : requested === "none" || requested === "minimal" ? "low" : "high";
    return Promise.resolve({ levels: MOCK_LEVELS, effective, note: null });
  }
  return invoke<EffortOptions>("ai_effort_options", { target });
}

/** The keychain entry a key is kept under: per provider, and for `custom` per base URL (a key only ever goes to the endpoint it was set for). */
const mockKeyOf = (provider: ProviderConfig) => (provider.id === "custom" ? `custom:${provider.baseUrl ?? ""}` : provider.id);

export async function aiKeySet(provider: ProviderConfig, key: string): Promise<void> {
  if (!isTauri()) {
    if (!key.trim()) throw { kind: "other", message: "The key is empty" } satisfies AiError;
    mockKeys.add(mockKeyOf(provider));
    return;
  }
  await invoke("ai_key_set", { provider, key });
}

export async function aiKeyDelete(provider: ProviderConfig): Promise<void> {
  if (!isTauri()) {
    mockKeys.delete(mockKeyOf(provider));
    return;
  }
  await invoke("ai_key_delete", { provider });
}

export function aiKeyStatus(provider: ProviderConfig): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(mockKeys.has(mockKeyOf(provider)));
  return invoke<boolean>("ai_key_status", { provider });
}

export function aiCliStatus(provider: ProviderConfig): Promise<CliStatus> {
  if (!isTauri()) {
    if (provider.id !== "claude-code") return Promise.resolve({ found: false });
    return Promise.resolve({
      found: false,
      agent: { ready: false, problem: "claude-agent-acp is not on the login shell’s PATH. Install it with `npm install -g @agentclientprotocol/claude-agent-acp`." },
    });
  }
  return invoke<CliStatus>("ai_cli_status", { provider });
}
