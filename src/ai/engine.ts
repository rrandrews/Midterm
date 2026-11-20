import { create } from "zustand";
import { activePaneId, livePane } from "../actions";
import { type ProviderConfig, type ProviderId, aiCancel, aiSuggest, providerInfo, toAiError } from "../ipc/ai";
import { homeDirectory } from "../ipc/system";
import { getSettings, useSettings } from "../settings/settings";
import { blockOutput, canRun, requestedMode } from "../terminal/blockMode";
import { branchOf } from "../terminal/gitBranch";
import type { TerminalSession } from "../terminal/session";
import { peekSession } from "../terminal/sessions";
import { type BuiltContext, buildContext, parseSuggestion } from "./context";

/*
 * Next-command suggestions, per terminal pane and outside React. The blocks
 * input editor reports when its pane sits at an empty prompt (`atPrompt`),
 * when the user types (`typed`) and when the prompt goes away (`leftPrompt`:
 * a command runs or the pane closes). A request is made only for the
 * focused pane, after a short pause, at most one per pane at a time, and
 * only once per prompt; errors back off. Nothing is sent until a provider
 * (and, for APIs, a model) is chosen, and only this terminal's own history
 * is sent.
 */

export type SuggestionStatus = "loading" | "ready" | "none" | "error";

export type PaneSuggestion = {
  /** The prompt this belongs to (see `promptKey`); stale once the pane moves on. */
  promptKey: string;
  status: SuggestionStatus;
  text?: string;
  error?: string;
  /** Dismissed with Esc: not shown again at this prompt. */
  dismissed?: boolean;
};

export const useAiSuggestions = create<Record<string, PaneSuggestion>>()(() => ({}));

/** Pause before asking, so quickly passing prompts (scripts, ⏎ spam) cost nothing. */
const DEBOUNCE_MS = 350;
/** Reply budget: a command line. */
const MAX_TOKENS = 120;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 10 * 60_000;

/** Whether suggestions are on and a provider (and model, where needed) is chosen. */
export function aiConfigured(settings = getSettings()): boolean {
  const { suggestions, provider, model, baseUrl } = settings.ai;
  const info = providerInfo(provider);
  if (!suggestions || !info) return false;
  if (info.type === "api" && !model) return false;
  if (info.id === "custom" && !baseUrl) return false;
  return true;
}

/** The provider config the backend expects, from the settings. */
export function providerConfig(settings = getSettings()): ProviderConfig | null {
  const { provider, baseUrl, cliPaths } = settings.ai;
  const info = providerInfo(provider);
  if (!info) return null;
  const config: ProviderConfig = { id: provider as ProviderId };
  if (info.id === "custom" && baseUrl) config.baseUrl = baseUrl;
  if (info.type === "cli" && cliPaths[provider]) config.cliPath = cliPaths[provider];
  return config;
}

/** Whether the pane's own switch (terminal menu) allows suggestions. */
export function paneAllows(paneId: string): boolean {
  return livePane(paneId)?.data.aiSuggestions !== false;
}

/** Identifies the prompt a session is at: it changes with every command. */
export function promptKey(session: TerminalSession): string {
  const blocks = session.blocks.snapshot().blocks;
  return `${blocks.length}:${blocks[blocks.length - 1]?.id ?? -1}`;
}

function homeRelative(path: string | undefined): string | undefined {
  const home = homeDirectory();
  if (!path || !home) return path;
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function osName(): string {
  const agent = navigator.userAgent;
  if (agent.includes("Mac")) return "macOS";
  if (agent.includes("Windows")) return "Windows";
  return "Linux";
}

/** What would be sent for a pane right now (also "Preview what is sent"). */
export async function contextFor(paneId: string): Promise<BuiltContext | null> {
  const session = peekSession(paneId);
  if (!session) return null;
  const limit = getSettings().ai.contextBlocks;
  const finished = session.blocks
    .snapshot()
    .blocks.filter((block) => block.end !== undefined && block.command.trim());
  const recentBlocks = limit > 0 ? finished.slice(-limit) : [];
  const snapshot = session.blocks.snapshot();
  // At a nested shell's prompt (over ssh) the machine is another one: its
  // host and directory, no local OS, branch or shell.
  const remote = snapshot.nested;
  const cwd = remote ? snapshot.location.cwd : session.cwd;
  const host = remote ? (snapshot.location.host ?? "unknown") : undefined;
  // Looked up now: the last block's branch is from when it started (before a `git switch`).
  const branch = cwd && !remote ? await branchOf(cwd).catch(() => null) : null;
  const foreground = session.foregroundProgram;
  return buildContext({
    os: remote ? undefined : osName(),
    host,
    shell: foreground?.isShell && !remote ? foreground.name : undefined,
    cwd: remote ? cwd : homeRelative(cwd),
    branch,
    blocks: recentBlocks.map((block) => ({
      command: block.command,
      exitCode: block.exitCode,
      output: blockOutput(session, block),
      cwd: block.host ? `${block.host}:${block.cwd ?? "?"}` : homeRelative(block.cwd),
    })),
    // This terminal's own commands only (and only the prompt's shell's):
    // other panes' history is not sent.
    recentCommands: session.blocks.commandsFor(session.blocks.scope).slice(-50),
  });
}

/* ---- Requests ---- */

const inFlight = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let failures = 0;
let blockedUntil = 0;
let requestCounter = 0;

function setEntry(paneId: string, entry: PaneSuggestion | null): void {
  useAiSuggestions.setState((state) => {
    const next = { ...state };
    if (entry) next[paneId] = entry;
    else delete next[paneId];
    return next;
  }, true);
}

function cancelRequest(paneId: string): void {
  const timer = timers.get(paneId);
  if (timer) clearTimeout(timer);
  timers.delete(paneId);
  const requestId = inFlight.get(paneId);
  if (requestId) {
    inFlight.delete(paneId);
    void aiCancel(requestId).catch(() => {});
  }
}

function noteFailure(kind: string): void {
  if (kind === "cancelled" || kind === "empty" || kind === "refused") return;
  failures += 1;
  // Fixing these needs the user: no more automatic requests until the settings change.
  if (kind === "noKey" || kind === "auth" || kind === "notFound") blockedUntil = Number.POSITIVE_INFINITY;
  else blockedUntil = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
}

/** Whether the pane shows its blocks prompt, so a suggestion can be shown. */
function promptVisible(paneId: string, session: TerminalSession): boolean {
  return requestedMode(paneId) === "blocks" && canRun(session);
}

/** Whether a request for `key` may still go out (checked again right before sending). */
function mayAsk(paneId: string, key: string, automatic: boolean): boolean {
  const session = peekSession(paneId);
  if (!session || !aiConfigured() || !paneAllows(paneId)) return false;
  if (promptKey(session) !== key || !promptVisible(paneId, session)) return false;
  if (automatic && (activePaneId() !== paneId || !document.hasFocus() || Date.now() < blockedUntil)) return false;
  return true;
}

async function request(paneId: string, key: string, automatic: boolean): Promise<void> {
  const settings = getSettings();
  const provider = providerConfig(settings);
  if (!provider) return;
  cancelRequest(paneId);
  const requestId = `suggest-${paneId}-${++requestCounter}`;
  inFlight.set(paneId, requestId);
  setEntry(paneId, { promptKey: key, status: "loading" });
  const stillCurrent = () => inFlight.get(paneId) === requestId;
  try {
    const context = await contextFor(paneId);
    if (!context || !stillCurrent()) return;
    if (!mayAsk(paneId, key, automatic)) {
      inFlight.delete(paneId);
      setEntry(paneId, null);
      return;
    }
    const { text } = await aiSuggest({
      requestId,
      provider,
      model: settings.ai.model,
      system: context.system,
      prompt: context.prompt,
      maxTokens: MAX_TOKENS,
    });
    if (!stillCurrent()) return;
    failures = 0;
    blockedUntil = 0;
    const command = parseSuggestion(text);
    setEntry(paneId, command ? { promptKey: key, status: "ready", text: command } : { promptKey: key, status: "none" });
  } catch (raw) {
    if (!stillCurrent()) return;
    const error = toAiError(raw);
    noteFailure(error.kind);
    setEntry(
      paneId,
      error.kind === "empty" || error.kind === "cancelled"
        ? { promptKey: key, status: "none" }
        : { promptKey: key, status: "error", error: error.message },
    );
  } finally {
    if (stillCurrent()) inFlight.delete(paneId);
  }
}

/* ---- Called by the blocks input editor ---- */

/** The pane sits at an empty prompt (mounted, focused, or emptied). Asks once per prompt, if allowed. */
export function atPrompt(paneId: string): void {
  if (!aiConfigured() || !paneAllows(paneId)) return;
  if (activePaneId() !== paneId || !document.hasFocus()) return;
  if (Date.now() < blockedUntil) return;
  const session = peekSession(paneId);
  if (!session) return;
  const key = promptKey(session);
  const existing = useAiSuggestions.getState()[paneId];
  if (existing?.promptKey === key) return;
  if (timers.has(paneId) || inFlight.has(paneId)) return;
  if (existing) setEntry(paneId, null);
  timers.set(
    paneId,
    setTimeout(() => {
      timers.delete(paneId);
      if (mayAsk(paneId, key, true)) void request(paneId, key, true);
    }, DEBOUNCE_MS),
  );
}

/** The user typed: a pending or running request is dropped (a ready suggestion stays, it may continue the text). */
export function typed(paneId: string): void {
  const loading = useAiSuggestions.getState()[paneId]?.status === "loading";
  cancelRequest(paneId);
  if (loading) setEntry(paneId, null);
}

/**
 * The editor went away: a command runs, blocks mode is left, the pane
 * closes, or its tab is hidden. Pending work is dropped; an answer (or a
 * dismissal) is kept for when the same prompt shows again, and ignored once
 * the pane is at another prompt.
 */
export function leftPrompt(paneId: string): void {
  const loading = useAiSuggestions.getState()[paneId]?.status === "loading";
  cancelRequest(paneId);
  if (loading || !peekSession(paneId)) setEntry(paneId, null);
}

/** The pane's switch was turned off: nothing pending, nothing shown. */
export function paneSwitchedOff(paneId: string): void {
  cancelRequest(paneId);
  setEntry(paneId, null);
}

/** A key was saved: automatic requests may try again. */
export function clearBackoff(): void {
  failures = 0;
  blockedUntil = 0;
}

/** Esc: hides the suggestion at this prompt. */
export function dismiss(paneId: string): void {
  const entry = useAiSuggestions.getState()[paneId];
  if (entry) setEntry(paneId, { ...entry, dismissed: true, status: entry.status === "loading" ? "none" : entry.status });
  cancelRequest(paneId);
}

/** "Suggest now": asks at once, whatever the pause, backoff or an earlier answer. */
export function suggestNow(paneId: string): boolean {
  const session = peekSession(paneId);
  if (!session) return false;
  const key = promptKey(session);
  if (!mayAsk(paneId, key, false)) return false;
  void request(paneId, key, false);
  return true;
}

/** The suggestion to show for a pane at its current prompt, if any. */
export function shownSuggestion(entry: PaneSuggestion | undefined, session: TerminalSession): PaneSuggestion | undefined {
  if (!entry || entry.dismissed || entry.promptKey !== promptKey(session)) return undefined;
  if (!aiConfigured() || !paneAllows(session.paneId)) return undefined;
  return entry;
}

/** Drops every request and suggestion (settings changed). */
export function resetSuggestions(): void {
  for (const paneId of [...inFlight.keys(), ...timers.keys()]) cancelRequest(paneId);
  useAiSuggestions.setState({}, true);
  failures = 0;
  blockedUntil = 0;
}

let installed = false;

export function installAiEngine(): void {
  if (installed) return;
  installed = true;
  let previous = getSettings().ai;
  useSettings.subscribe((state) => {
    if (state.ai === previous) return;
    previous = state.ai;
    resetSuggestions();
  });
}
