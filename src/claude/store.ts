import { create } from "zustand";
import { createPaneState } from "../plugins/paneState";
import { pluginSettings } from "../plugins/settings";
import { CLAUDE_KIND, onBridgeEvent, onSessionEvent, request } from "./client";
import type { BridgeEvent, EffortLevel, ImageAttachment, PermissionMode, PermissionResult, SDKMessage } from "./protocol";
import { createSession, fromSessionMessages, reduce, settleSession } from "./reduce";
import type { ClaudeSession, SidePanel } from "./types";

/*
 * Claude Code sessions, one per pane (keyed by a session key), and the
 * actions the UI calls. Session processes live in the bridge; this store
 * mirrors them from bridge events through `reduce.ts`.
 *
 * A pane holds its session through `acquirePaneSession` (a pane state: the
 * process is closed once the pane is gone). The process starts lazily on
 * the first message, resuming the pane's saved `sessionId`. New session and
 * resume give the pane a fresh session key, so late events of the old
 * process never reach the new one.
 */

export type ClaudeStore = {
  sessions: Record<string, ClaudeSession>;
  /** Pane id → session key. */
  panes: Record<string, string>;
};

export const useClaudeStore = create<ClaudeStore>(() => ({ sessions: {}, panes: {} }));

/** A session's state, selected. */
export function useSession<T>(key: string, selector: (session: ClaudeSession | undefined) => T): T {
  return useClaudeStore((state) => selector(state.sessions[key]));
}

export function getSession(key: string): ClaudeSession | undefined {
  return useClaudeStore.getState().sessions[key];
}

/** Applies a patch (or an updater) to a session; nothing when it is gone. */
export function updateSession(key: string, patch: Partial<ClaudeSession> | ((session: ClaudeSession) => Partial<ClaudeSession>)): void {
  useClaudeStore.setState((state) => {
    const session = state.sessions[key];
    if (!session) return state;
    const change = typeof patch === "function" ? patch(session) : patch;
    return { sessions: { ...state.sessions, [key]: { ...session, ...change } } };
  });
}

/** Opens (or closes, with `undefined`; or toggles, when it is already open) a side panel. */
export function setPanel(key: string, panel: SidePanel | undefined): void {
  updateSession(key, (session) => ({ panel: session.panel === panel ? undefined : panel }));
}

/** Shows a task (subagent) in the Agents panel. */
export function focusTask(key: string, taskId: string | undefined): void {
  updateSession(key, { panel: "agents", focusedTask: taskId });
}

/* ---- Panes ---- */

/** What a pane saves (its pane data, besides `kind`). */
export type ClaudePaneData = {
  cwd: string;
  sessionId?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
};

let writePaneData: (paneId: string, patch: Partial<ClaudePaneData>) => void = () => {};

/** How the store saves to pane data (set once by the plugin, which may import the app's actions). */
export function setPaneDataWriter(write: (paneId: string, patch: Partial<ClaudePaneData>) => void): void {
  writePaneData = write;
}

function persist(key: string, patch: Partial<ClaudePaneData>): void {
  const session = getSession(key);
  if (session) writePaneData(session.paneId, patch);
}

let generation = 0;
const newKey = (paneId: string) => `${paneId}~${++generation}`;

/* ---- Composer drafts ---- */

/** What is typed in a composer, kept while the pane is unmounted (tab switches). */
export type Draft = { text: string; images: ImageAttachment[] };
const drafts = new Map<string, Draft>();

export function getDraft(key: string): Draft | undefined {
  return drafts.get(key);
}
/** Saves (or, when empty, discards) a session's draft. */
export function setDraft(key: string, draft: Draft): void {
  if (!draft.text && draft.images.length === 0) drafts.delete(key);
  else drafts.set(key, draft);
}

/** A pane's hold on its session; `key` changes with New session and resume. */
type PaneSession = { paneId: string; key: string };

const paneSessions = createPaneState<PaneSession>({
  kind: CLAUDE_KIND,
  dispose: (held) => {
    void closeProcess(held.key);
    drafts.delete(held.key);
    useClaudeStore.setState((state) => {
      const { [held.key]: _gone, ...sessions } = state.sessions;
      const { [held.paneId]: _pane, ...panes } = state.panes;
      return { sessions, panes };
    });
  },
});

/** Gives a mounted pane its session (created from the pane data the first time). Release with the returned function. */
export function acquirePaneSession(paneId: string, data: ClaudePaneData): () => void {
  const held = paneSessions.acquire(paneId, () => {
    const key = newKey(paneId);
    const session = createSession({ key, paneId, cwd: data.cwd, sessionId: data.sessionId, model: data.model, effort: data.effort, permissionMode: data.permissionMode });
    useClaudeStore.setState((state) => ({ sessions: { ...state.sessions, [key]: session }, panes: { ...state.panes, [paneId]: key } }));
    // A restored pane shows the transcript it will resume.
    if (data.sessionId) void loadTranscript(key, data.sessionId);
    return { paneId, key };
  });
  return () => paneSessions.release(paneId, held);
}

/** The session key of a pane, if it has one. */
export function paneSessionKey(paneId: string): string | undefined {
  return useClaudeStore.getState().panes[paneId];
}

/** Puts a fresh session in the pane's place (same folder, settings and open panel). */
function replaceSession(key: string, seed: { sessionId?: string }): string | undefined {
  const old = getSession(key);
  if (!old) return undefined;
  const next = newKey(old.paneId);
  const session = createSession({ key: next, paneId: old.paneId, cwd: old.cwd, sessionId: seed.sessionId, model: old.model, effort: old.effort, permissionMode: old.permissionMode });
  session.panel = old.panel;
  const held = paneSessions.get(old.paneId);
  if (held) held.key = next;
  // What was being typed stays in the composer.
  const draft = drafts.get(key);
  drafts.delete(key);
  if (draft) drafts.set(next, draft);
  useClaudeStore.setState((state) => {
    const { [key]: _gone, ...sessions } = state.sessions;
    return { sessions: { ...sessions, [next]: session }, panes: { ...state.panes, [old.paneId]: next } };
  });
  void closeProcess(key);
  return next;
}

/* ---- Processes ---- */

type Live = {
  unsubscribe: () => void;
  /** Resolves once `session.start` answered. */
  started: Promise<boolean>;
  /** Closed on purpose: its `sessionEnded` is not an error. */
  closing: boolean;
  /** SDK messages not yet applied (applied once per frame). */
  queue: SDKMessage[];
  flushing: boolean;
};

const live = new Map<string, Live>();

const nextFrame: (run: () => void) => void =
  typeof requestAnimationFrame === "function" ? (run) => requestAnimationFrame(() => run()) : (run) => setTimeout(run, 16);

function flush(key: string): void {
  const entry = live.get(key);
  if (!entry || entry.queue.length === 0) return;
  const messages = entry.queue.splice(0);
  let ended = false;
  const before = getSession(key);
  updateSession(key, (session) => {
    let next = session;
    const now = Date.now();
    for (const message of messages) {
      next = reduce(next, message, now);
      if (message.type === "result") ended = true;
    }
    return next;
  });
  const session = getSession(key);
  // Saved only when it changed. Settings the CLI reports (mode, model) are never saved: only the user's choices are.
  if (session?.sessionId && session.sessionId !== before?.sessionId) persist(key, { sessionId: session.sessionId });
  if (ended) void refreshContext(key, "summary");
}

function onEvent(key: string, event: BridgeEvent): void {
  const entry = live.get(key);
  if (event.event === "message") {
    if (!entry) return;
    entry.queue.push(event.message);
    if (!entry.flushing) {
      entry.flushing = true;
      nextFrame(() => {
        entry.flushing = false;
        flush(key);
      });
    }
    return;
  }
  // Everything else lands after the messages before it.
  flush(key);
  switch (event.event) {
    case "permission":
      updateSession(key, (session) => ({ permissions: [...session.permissions.filter((request) => request.requestId !== event.request.requestId), event.request] }));
      break;
    case "permissionCancelled":
      updateSession(key, (session) => ({ permissions: session.permissions.filter((request) => request.requestId !== event.requestId) }));
      break;
    case "sessionEnded":
      ended(key, entry?.closing ? undefined : (event.error ?? "Claude Code stopped."));
      break;
    case "stderr":
      console.debug(`[claude ${key}]`, event.text);
      break;
  }
}

/** The process is gone: the next message starts (resumes) a new one. */
function ended(key: string, error: string | undefined): void {
  const entry = live.get(key);
  if (entry) {
    flush(key);
    entry.unsubscribe();
    live.delete(key);
  }
  updateSession(key, (session) => ({
    ...settleSession(session, Date.now()),
    status: error ? "error" : "new",
    error,
    permissions: [],
    turnStartedAt: undefined,
    compacting: false,
  }));
}

let watchingBridge = false;
function watchBridge(): void {
  if (watchingBridge) return;
  watchingBridge = true;
  onBridgeEvent((event) => {
    if (event.event !== "bridgeExit") return;
    for (const key of [...live.keys()]) ended(key, "The Claude Code bridge stopped.");
  });
}

/** Starts (or resumes) the session's process; `false` when that failed (the session shows the error). */
function ensureProcess(key: string): Promise<boolean> {
  const existing = live.get(key);
  if (existing) return existing.started;
  const session = getSession(key);
  if (!session) return Promise.resolve(false);
  watchBridge();
  // Bypass is offered only when the setting is on when the process starts.
  const allowBypass = bypassSetting();
  const permissionMode = session.permissionMode === "bypassPermissions" && !allowBypass ? "default" : session.permissionMode;
  const entry: Live = { unsubscribe: onSessionEvent(key, (event) => onEvent(key, event)), started: Promise.resolve(false), closing: false, queue: [], flushing: false };
  live.set(key, entry);
  updateSession(key, { status: "starting", error: undefined, bypassAllowed: allowBypass, permissionMode });
  entry.started = request("session.start", {
    session: key,
    cwd: session.cwd,
    resume: session.sessionId,
    model: session.model,
    effort: session.effort ?? undefined,
    permissionMode,
    allowBypass,
  }).then(
    (init) => {
      if (live.get(key) !== entry) return false;
      const knownId = getSession(key)?.sessionId;
      updateSession(key, (current) => ({
        init,
        sessionId: init.sessionId ?? current.sessionId,
        permissionMode: init.permissionMode ?? current.permissionMode,
        status: current.status === "starting" ? "idle" : current.status,
      }));
      const sessionId = getSession(key)?.sessionId;
      if (sessionId && sessionId !== knownId) persist(key, { sessionId });
      void refreshContext(key, "summary");
      return true;
    },
    (error: unknown) => {
      if (live.get(key) === entry) ended(key, messageOf(error));
      return false;
    },
  );
  return entry.started;
}

async function closeProcess(key: string): Promise<void> {
  const entry = live.get(key);
  if (!entry) return;
  entry.closing = true;
  entry.unsubscribe();
  live.delete(key);
  await request("session.close", { session: key }).catch(() => {});
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addNotice(key: string, text: string, tone: "info" | "warn" | "error" = "error"): void {
  updateSession(key, (session) => ({ items: [...session.items, { kind: "notice", id: `local:${Date.now()}:${Math.random()}`, tone, text }] }));
}

/** The first line of a prompt, as a title. */
function titleOf(text: string): string {
  const line = text.trim().split("\n")[0].trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/* ---- Session lifecycle ---- */

/** Sends a message, starting (or resuming) the session's process first if needed. While a turn runs it is queued. */
export async function sendMessage(key: string, text: string, images?: ImageAttachment[]): Promise<void> {
  // A restored transcript first: the process starts (and its events arrive) only after it is in place.
  await loads.get(key);
  const session = getSession(key);
  if (!session || (!text.trim() && !images?.length)) return;
  const uuid = crypto.randomUUID();
  const queued = session.status === "running";
  updateSession(key, (current) => ({
    items: [...current.items, { kind: "user", id: uuid, text, images: images?.length ? images : undefined, queued: queued || undefined }],
    title: current.title ?? (text.trim().startsWith("/") ? undefined : titleOf(text)),
  }));
  if (!(await ensureProcess(key))) return;
  if (!queued) updateSession(key, (current) => ({ status: "running", turnStartedAt: current.turnStartedAt ?? Date.now() }));
  try {
    await request("session.send", { session: key, text, images: images?.length ? images : undefined, uuid });
  } catch (error) {
    updateSession(key, (current) => ({ status: current.status === "running" && !queued ? "idle" : current.status, turnStartedAt: undefined }));
    addNotice(key, `Could not send: ${messageOf(error)}`);
  }
}

/** Interrupts the running turn (Esc). */
export async function interrupt(key: string): Promise<void> {
  if (getSession(key)?.status !== "running" || !live.has(key)) return;
  await request("session.interrupt", { session: key }).catch((error) => addNotice(key, `Could not interrupt: ${messageOf(error)}`));
}

export async function answerPermission(key: string, requestId: string, result: PermissionResult): Promise<void> {
  const prompt = getSession(key)?.permissions.find((candidate) => candidate.requestId === requestId);
  updateSession(key, (session) => {
    const tool = prompt && session.tools[prompt.toolUseId];
    return {
      permissions: session.permissions.filter((candidate) => candidate.requestId !== requestId),
      tools: tool && result.behavior === "deny" ? { ...session.tools, [tool.id]: { ...tool, status: "denied" } } : session.tools,
    };
  });
  // A mode the user picked in the prompt (plan approval) is theirs: saved like the mode chip's.
  const mode = result.behavior === "allow" ? result.updatedPermissions?.find((update) => update.type === "setMode" && update.destination === "session") : undefined;
  if (mode?.type === "setMode") {
    updateSession(key, { permissionMode: mode.mode });
    persist(key, { permissionMode: mode.mode });
  }
  await request("session.permission", { session: key, requestId, result }).catch((error) => addNotice(key, `Could not answer the prompt: ${messageOf(error)}`));
}

/** Whether the plugin setting offers the bypass permissions mode (for sessions started from now on). */
export function bypassSetting(): boolean {
  return pluginSettings(CLAUDE_KIND).allowBypassPermissions === true;
}

/** Whether the session may switch to bypass: as started, or (before it starts) as the setting says now. */
export function bypassAllowed(session: ClaudeSession): boolean {
  return session.bypassAllowed ?? bypassSetting();
}

type Setting = "permissionMode" | "model" | "effort";
type SettingValue<K extends Setting> = ClaudeSession[K];

/* Setting changes of a session, one at a time (and after its start). */
const settingChains = new Map<string, Promise<void>>();

/**
 * Changes a session setting: shown at once, saved to the pane once the
 * session acknowledged it (or right away when no process runs: it is
 * applied at the next start). A change while the process starts waits for
 * the start. On failure the previous value comes back, with a notice.
 */
function changeSetting<K extends Setting>(key: string, field: K, value: SettingValue<K>, send: () => Promise<unknown>, what: string): Promise<void> {
  const session = getSession(key);
  if (!session) return Promise.resolve();
  const previous = session[field];
  updateSession(key, { [field]: value } as Partial<ClaudeSession>);
  const save = () => persist(key, { [field]: value ?? undefined } as Partial<ClaudePaneData>);
  const task = async () => {
    await live.get(key)?.started;
    if (!getSession(key)) return;
    if (!hasProcess(key)) {
      save();
      return;
    }
    try {
      await send();
      // The start's init may have reported the old value meanwhile.
      updateSession(key, { [field]: value } as Partial<ClaudeSession>);
      save();
    } catch (error) {
      updateSession(key, (current) => (current[field] === value ? ({ [field]: previous } as Partial<ClaudeSession>) : {}));
      addNotice(key, `Could not change ${what}: ${messageOf(error)}`);
    }
  };
  const next = (settingChains.get(key) ?? Promise.resolve()).then(task, task);
  settingChains.set(key, next);
  return next;
}

export function setPermissionMode(key: string, mode: PermissionMode): Promise<void> {
  const session = getSession(key);
  if (!session || (mode === "bypassPermissions" && !bypassAllowed(session))) return Promise.resolve();
  return changeSetting(key, "permissionMode", mode, () => request("session.setPermissionMode", { session: key, mode }), "the mode");
}

/** Changes the model (`undefined`: the default). Only the model: the effort is `setEffort`'s. */
export function setModel(key: string, model: string | undefined): Promise<void> {
  if (!getSession(key) || getSession(key)?.model === model) return Promise.resolve();
  return changeSetting(key, "model", model, () => request("session.setModel", { session: key, model }), "the model");
}

/** Changes the effort (`null`: the model's default). Only the effort. */
export function setEffort(key: string, effort: EffortLevel | null): Promise<void> {
  const session = getSession(key);
  if (!session || (session.effort ?? null) === effort) return Promise.resolve();
  return changeSetting(key, "effort", effort, () => request("session.setEffort", { session: key, effort }), "the effort");
}

/** Ends the current session and starts empty (same folder). */
export async function newSession(key: string): Promise<void> {
  const next = replaceSession(key, {});
  if (next) persist(next, { sessionId: undefined });
}

/** Replaces the pane's session with a past one (SDK session id), loading its transcript. */
export async function resumeSession(key: string, sessionId: string): Promise<void> {
  const next = replaceSession(key, { sessionId });
  if (!next) return;
  persist(next, { sessionId });
  await loadTranscript(next, sessionId);
}

/** Transcripts being loaded, by session key (a send waits for its session's). */
const loads = new Map<string, Promise<void>>();

function loadTranscript(key: string, sessionId: string): Promise<void> {
  const loading = readTranscript(key, sessionId).finally(() => {
    loads.delete(key);
    updateSession(key, { loadingTranscript: undefined });
  });
  loads.set(key, loading);
  updateSession(key, { loadingTranscript: true });
  return loading;
}

async function readTranscript(key: string, sessionId: string): Promise<void> {
  const session = getSession(key);
  if (!session) return;
  try {
    const messages = await request("sessions.messages", { cwd: session.cwd, sessionId });
    const loaded = fromSessionMessages(messages);
    updateSession(key, (current) => {
      // Sends wait for the load and nothing runs yet, so only local notices can be here: keep them after it.
      const firstUser = loaded.items.find((item) => item.kind === "user");
      return {
        ...loaded,
        items: [...loaded.items, ...current.items],
        tools: { ...loaded.tools, ...current.tools },
        title: current.title ?? (firstUser?.kind === "user" ? titleOf(firstUser.text) : undefined),
      };
    });
  } catch (error) {
    addNotice(key, `Could not load the transcript: ${messageOf(error)}`, "warn");
  }
}

/** Changes the folder (only before the first message). */
export function setCwd(key: string, cwd: string): void {
  const session = getSession(key);
  if (!session || session.items.length > 0 || live.has(key)) return;
  cwd = cwd.replace(/(.)\/+$/, "$1");
  updateSession(key, { cwd });
  persist(key, { cwd });
}

/** Fetches `session.contextUsage` into `context` (no-op without a process). `summary` keeps the last full breakdown's details. */
export async function refreshContext(key: string, detail?: "summary" | "full"): Promise<void> {
  if (!hasProcess(key)) return;
  try {
    const context = await request("session.contextUsage", { session: key, detail });
    updateSession(key, (session) => {
      const previous = session.context;
      const merged =
        detail === "summary" && previous && !context.gridRows?.length
          ? { ...previous, categories: context.categories, totalTokens: context.totalTokens, maxTokens: context.maxTokens, rawMaxTokens: context.rawMaxTokens, percentage: context.percentage, model: context.model, autoCompactThreshold: context.autoCompactThreshold ?? previous.autoCompactThreshold }
          : context;
      return { context: merged, contextTokens: context.totalTokens, contextWindow: context.maxTokens || session.contextWindow };
    });
  } catch (error) {
    console.warn("[claude] context usage failed:", error);
  }
}

/** Fetches `session.usage` into `usage` (no-op without a process). */
export async function refreshUsage(key: string): Promise<void> {
  if (!hasProcess(key)) return;
  try {
    const usage = await request("session.usage", { session: key });
    updateSession(key, { usage });
  } catch (error) {
    console.warn("[claude] usage failed:", error);
  }
}

export async function stopTask(key: string, taskId: string): Promise<void> {
  if (!hasProcess(key)) return;
  await request("session.stopTask", { session: key, taskId }).catch((error) => addNotice(key, `Could not stop the task: ${messageOf(error)}`));
}

/** Whether the session has a running process (requests that need one can be sent). */
export function hasProcess(key: string): boolean {
  const status = getSession(key)?.status;
  return status === "idle" || status === "running";
}

/** Whether a turn is running in the pane's session. */
export function paneIsRunning(paneId: string): boolean {
  const key = paneSessionKey(paneId);
  return key !== undefined && getSession(key)?.status === "running";
}

/** Background tasks and subagents still running. */
export function runningTasks(session: Pick<ClaudeSession, "tasks">): number {
  return Object.values(session.tasks).filter((task) => task.status === "running" || task.status === "pending").length;
}

/**
 * What closing (or replacing) the session would stop, as a name for close
 * prompts ("Claude Code (2 agents running)"), or `undefined` when nothing
 * is: a running turn, running background tasks, or a first message waiting
 * for the process to start.
 */
export function sessionWork(key: string): string | undefined {
  const session = getSession(key);
  if (!session) return undefined;
  const agents = runningTasks(session);
  const waiting = session.status === "starting" && session.items.some((item) => item.kind === "user");
  if (agents > 0) return `Claude Code (${agents} agent${agents === 1 ? "" : "s"} running)`;
  if (session.status === "running" || waiting) return "Claude Code";
  return undefined;
}
