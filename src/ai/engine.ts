import { create } from "zustand";
import { activePaneId, livePane } from "../actions";
import { aiCancel, aiSuggest, toAiError } from "../ipc/ai";
import { homeDirectory } from "../ipc/system";
import { getSettings, useSettings } from "../settings/settings";
import { blockOutput, canRun, requestedMode } from "../terminal/blockMode";
import { type Block, type BlocksSnapshot, scopeOf } from "../terminal/blocks";
import { commandPairs, loadCommandLog } from "../terminal/commandLog";
import { branchOf } from "../terminal/gitBranch";
import type { TerminalSession } from "../terminal/session";
import { peekSession } from "../terminal/sessions";
import { type BuiltContext, type ContextInput, buildContext, parseSuggestion } from "./context";
import { predictNext } from "./predict";
import { featureReady, targetFor } from "./profiles";

/*
 * Next-command suggestions, per terminal pane and outside React. The blocks
 * input editor reports when its pane sits at an empty prompt (`atPrompt`),
 * when the user types (`typed`) and when the prompt goes away (`leftPrompt`:
 * a command runs or the pane closes). A request is made only for the
 * focused pane, after a short pause, at most one per pane at a time, and
 * only once per prompt; errors back off. Nothing is sent until the
 * suggestions feature resolves to a ready model profile (src/ai/profiles.ts),
 * and only this terminal's own history is sent.
 *
 * Before any request, the command log is checked for a likely follow-up to
 * the previous command (src/ai/predict.ts). A local prediction is shown at
 * once, needs no provider, and means no request is made at that prompt.
 */

export type SuggestionStatus = "loading" | "ready" | "none" | "error";

export type PaneSuggestion = {
  /** The prompt this belongs to (see `promptKey`); stale once the pane moves on. */
  promptKey: string;
  status: SuggestionStatus;
  /** Where a ready suggestion came from: the local command log or the model. */
  source?: "local" | "ai";
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

/** Whether suggestions are on and resolve to a ready model profile. */
export function aiConfigured(settings = getSettings()): boolean {
  return settings.ai.suggestions && featureReady("suggestions", settings);
}

/**
 * The local prediction for a session's prompt: the likely follow-up to its
 * last command, from the command log. Only at this machine's shell (the log
 * holds nothing from remote shells).
 */
export function localPrediction(session: TerminalSession): string | undefined {
  if (session.blocks.scope !== "") return undefined;
  const last = session.blocks.commandsFor("").slice(-1)[0];
  if (!last) return undefined;
  return predictNext(commandPairs(), last)?.command;
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

/** What `contextInputOf` reads from a terminal session (a seam for tests). */
export type ContextSource = {
  snapshot: BlocksSnapshot;
  /** The root shell's working directory. */
  cwd: string | undefined;
  /** The scope of the prompt (`session.blocks.scope`). */
  scope: string;
  commandsFor: (scope: string) => readonly string[];
  /** The foreground program's name when it is a shell. */
  shell: string | undefined;
  output: (block: Block) => string;
  os: string;
  homeRelative: (path: string | undefined) => string | undefined;
};

/**
 * The context for a terminal's prompt, or, with `block`, for a request about
 * that block: then the scope, directory and host are the block's, and only
 * what came before it is included (the same shell's finished blocks before
 * it; earlier commands without it and the ones after it). The block itself
 * is not in the result. `branch` is looked up by the caller.
 */
export function contextInputOf(
  source: ContextSource,
  options: { limit: number; block?: Block; branch?: string | null },
): ContextInput {
  const { block } = options;
  const { snapshot } = source;
  const scope = block ? scopeOf(block.nested, block) : source.scope;
  const at = block ? snapshot.blocks.indexOf(block) : -1;
  const before = block ? (at < 0 ? snapshot.blocks.filter((b) => b.id < block.id) : snapshot.blocks.slice(0, at)) : snapshot.blocks;
  const finished = before.filter((b) => b.end !== undefined && b.command.trim() && scopeOf(b.nested, b) === scope);
  const recentBlocks = options.limit > 0 ? finished.slice(-options.limit) : [];
  // At a nested shell (over ssh) the machine is another one: its host and
  // directory, no local OS, branch or shell.
  const remote = block ? block.nested : snapshot.nested;
  const cwd = block ? block.cwd : remote ? snapshot.location.cwd : source.cwd;
  const host = remote ? ((block ? block.host : snapshot.location.host) ?? "unknown") : undefined;
  let commands = source.commandsFor(scope).slice(-50);
  if (block) {
    // The command log is de-duplicated, so later blocks' commands (and this one) are left out by text.
    const later = new Set(snapshot.blocks.slice(at < 0 ? snapshot.blocks.length : at).map((b) => b.command.trim()));
    later.add(block.command.trim());
    commands = commands.filter((command) => !later.has(command.trim()));
  }
  return {
    os: remote ? undefined : source.os,
    host,
    shell: remote ? undefined : source.shell,
    cwd: remote ? cwd : source.homeRelative(cwd),
    branch: remote ? null : (options.branch ?? null),
    blocks: recentBlocks.map((b) => ({
      command: b.command,
      exitCode: b.exitCode,
      output: source.output(b),
      cwd: b.host ? `${b.host}:${b.cwd ?? "?"}` : source.homeRelative(b.cwd),
    })),
    recentCommands: commands,
    beforeBlock: block ? true : undefined,
  };
}

/**
 * What would be sent for a pane right now (also "Preview what is sent"),
 * or, with `block`, the context a request about that block starts with.
 * Only this terminal's own commands (and only that shell's) are included.
 */
export async function contextFor(paneId: string, options: { block?: Block } = {}): Promise<BuiltContext | null> {
  const session = peekSession(paneId);
  if (!session) return null;
  const { block } = options;
  const snapshot = session.blocks.snapshot();
  const remote = block ? block.nested : snapshot.nested;
  const cwd = block ? block.cwd : session.cwd;
  // For the prompt, looked up now (the last block's branch is from when it
  // started, before a `git switch`); for a block, the one it ran on.
  const branch = remote ? null : block ? (block.branch ?? null) : cwd ? await branchOf(cwd).catch(() => null) : null;
  const foreground = session.foregroundProgram;
  const input = contextInputOf(
    {
      snapshot,
      cwd: session.cwd,
      scope: session.blocks.scope,
      commandsFor: (scope) => session.blocks.commandsFor(scope),
      shell: foreground?.isShell ? foreground.name : undefined,
      output: (b) => blockOutput(session, b),
      os: osName(),
      homeRelative,
    },
    { limit: getSettings().ai.contextBlocks, block, branch },
  );
  return buildContext(input);
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
  const target = targetFor("suggestions");
  if (!target) return;
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
      target,
      system: context.system,
      prompt: context.prompt,
      maxTokens: MAX_TOKENS,
    });
    if (!stillCurrent()) return;
    failures = 0;
    blockedUntil = 0;
    const command = parseSuggestion(text);
    setEntry(
      paneId,
      command ? { promptKey: key, status: "ready", source: "ai", text: command } : { promptKey: key, status: "none" },
    );
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
  if (!getSettings().ai.suggestions || !paneAllows(paneId)) return;
  const session = peekSession(paneId);
  if (!session) return;
  const key = promptKey(session);
  const existing = useAiSuggestions.getState()[paneId];
  if (existing?.promptKey === key) return;
  if (timers.has(paneId) || inFlight.has(paneId)) return;
  // The command log first: no request when it has a likely answer.
  const local = promptVisible(paneId, session) ? localPrediction(session) : undefined;
  if (local) {
    setEntry(paneId, { promptKey: key, status: "ready", source: "local", text: local });
    return;
  }
  if (!aiConfigured()) return;
  if (activePaneId() !== paneId || !document.hasFocus()) return;
  if (Date.now() < blockedUntil) return;
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
  if (!paneAllows(session.paneId)) return undefined;
  if (entry.source === "local" ? !getSettings().ai.suggestions : !aiConfigured()) return undefined;
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
  void loadCommandLog();
  let previous = getSettings().ai;
  useSettings.subscribe((state) => {
    if (state.ai === previous) return;
    previous = state.ai;
    resetSuggestions();
  });
}
