import { invoke, isTauri } from "@tauri-apps/api/core";
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

export type CliStatus = { found: boolean; path?: string; version?: string; outdated?: string };

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

/* ---- Commands ---- */

export function aiSuggest(request: SuggestRequest): Promise<{ text: string }> {
  if (!isTauri()) return mockSuggest(request);
  return invoke<{ text: string }>("ai_suggest", request);
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
  if (!isTauri()) return Promise.resolve({ found: false });
  return invoke<CliStatus>("ai_cli_status", { provider });
}
