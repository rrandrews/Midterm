import type {
  ContentBlock,
  CreateElicitationResponse,
  RequestId,
  SessionConfigOption,
  SessionInfo,
  SessionUpdate,
} from "@agentclientprotocol/sdk/unstable";
import { create } from "zustand";
import { antigravityAcpClose, antigravityAcpOpen, antigravityAcpSend } from "../ipc/antigravity";
import { homeDirectory } from "../ipc/system";
import { createPaneState } from "../plugins/paneState";
import { pluginSettings } from "../plugins/settings";
import { AcpClient, AcpRpcError, isAuthError } from "./acp";
import { createSession, failSession, finishTurn, reduceUpdate } from "./reduce";
import {
  ANTIGRAVITY_KIND,
  type AntigravityPaneData,
  type AntigravitySession,
  type FileMention,
  type ImageAttachment,
  type SidePanel,
} from "./types";
import { findConfigOption, flattenSelectOptions } from "./ui/format";

/*
 * Antigravity ACP sessions, one per pane (keyed by session key), and the
 * actions driven by the UI and slash commands. Each live session owns one
 * dedicated `agy acp` process (killed on pane close, new session, or exit).
 */

export type AntigravityStore = {
  sessions: Record<string, AntigravitySession>;
  /** Pane id → session key. */
  panes: Record<string, string>;
};

export const useAntigravityStore = create<AntigravityStore>(() => ({ sessions: {}, panes: {} }));

export function useSession<T>(key: string, selector: (session: AntigravitySession | undefined) => T): T {
  return useAntigravityStore((state) => selector(state.sessions[key]));
}

export function getSession(key: string): AntigravitySession | undefined {
  return useAntigravityStore.getState().sessions[key];
}

export function updateSession(
  key: string,
  patch: Partial<AntigravitySession> | ((session: AntigravitySession) => Partial<AntigravitySession>),
): void {
  useAntigravityStore.setState((state) => {
    const session = state.sessions[key];
    if (!session) return state;
    const change = typeof patch === "function" ? patch(session) : patch;
    return { sessions: { ...state.sessions, [key]: { ...session, ...change } } };
  });
}

export function setPanel(key: string, panel: SidePanel | undefined): void {
  updateSession(key, (session) => ({ panel: session.panel === panel ? undefined : panel }));
}

/* ---- URL & Shell helpers ---- */

/** Converts an absolute filesystem path to a standards-compliant `file://` URL (encoding `#`, `?`, `%`, spaces). */
export function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const isWindowsDrive = /^[A-Za-z]:\//.test(normalized);
  const segments = normalized.split("/").map((seg, idx) => (idx === 0 && isWindowsDrive ? seg : encodeURIComponent(seg)));
  const joined = segments.join("/");
  return isWindowsDrive ? `file:///${joined}` : `file://${joined.startsWith("/") ? joined : `/${joined}`}`;
}

/** POSIX single-quote escaping for a shell argument (`'` → `'\''`). */
export function shellQuoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/* ---- Host hooks (wired once by plugin.tsx) ---- */

type HostActions = {
  openFile: (path: string, options?: { fromPaneId?: string; line?: number }) => void;
  markActivity: (paneId: string) => void;
  runInTerminal: (command: string) => void;
  isActivePane: (paneId: string) => boolean;
};

let writePaneData: (paneId: string, patch: Partial<AntigravityPaneData>) => void = () => {};
let hostActions: HostActions = {
  openFile: () => {},
  markActivity: () => {},
  runInTerminal: () => {},
  isActivePane: () => true,
};

export function setPaneDataWriter(write: (paneId: string, patch: Partial<AntigravityPaneData>) => void): void {
  writePaneData = write;
}

export function setHostActions(actions: Partial<HostActions>): void {
  hostActions = { ...hostActions, ...actions };
}

export function openSessionFile(key: string, path: string, line?: number): void {
  const session = getSession(key);
  hostActions.openFile(path, { fromPaneId: session?.paneId, line });
}

export function runLoginInTerminal(sessionKey?: string): void {
  const session = sessionKey ? getSession(sessionKey) : undefined;
  const settings = pluginSettings(ANTIGRAVITY_KIND);
  let exe = session?.agyPath?.trim();
  if (!exe) {
    const configured = typeof settings.agyPath === "string" ? settings.agyPath.trim() : "";
    if (configured) {
      const home = homeDirectory();
      exe = configured.startsWith("~/") && home ? `${home.replace(/\/+$/, "")}/${configured.slice(2)}` : configured;
    } else {
      exe = "agy";
    }
  }
  hostActions.runInTerminal(`${shellQuoteArg(exe)} acp --login`);
}

function persist(key: string, patch: Partial<AntigravityPaneData>): void {
  const session = getSession(key);
  if (session) writePaneData(session.paneId, patch);
}

/* ---- Composer drafts ---- */

export type Draft = { text: string; images: ImageAttachment[]; mentions: FileMention[] };
const drafts = new Map<string, Draft>();

export function getDraft(key: string): Draft | undefined {
  return drafts.get(key);
}

export function setDraft(key: string, draft: Draft): void {
  if (!draft.text && draft.images.length === 0 && draft.mentions.length === 0) drafts.delete(key);
  else drafts.set(key, draft);
}

/* ---- Pane lifecycle ---- */

let keySeq = 0;
const newKey = (paneId: string) => `${paneId}~ag${++keySeq}`;

/** Synchronously tracks sessions that have reserved an active turn (including while starting up). */
const activeTurns = new Set<string>();

/** Per-session serialized setting-change queue and refusal tracking. */
type SettingQueue = { tail: Promise<void>; modeRefused: boolean };
const settingQueues = new Map<string, SettingQueue>();

type PaneSession = { paneId: string; key: string };

const paneSessions = createPaneState<PaneSession>({
  kind: ANTIGRAVITY_KIND,
  dispose: (held) => {
    void closeProcess(held.key);
    drafts.delete(held.key);
    promptQueues.delete(held.key);
    activeTurns.delete(held.key);
    settingQueues.delete(held.key);
    useAntigravityStore.setState((state) => {
      const { [held.key]: _gone, ...sessions } = state.sessions;
      const { [held.paneId]: _pane, ...panes } = state.panes;
      return { sessions, panes };
    });
  },
});

export function acquirePaneSession(paneId: string, data: AntigravityPaneData): () => void {
  const held = paneSessions.acquire(paneId, () => {
    const key = newKey(paneId);
    const session = createSession({
      key,
      paneId,
      cwd: data.cwd,
      sessionId: data.sessionId,
      mode: data.mode,
      model: data.model,
      thoughtLevel: data.thoughtLevel,
    });
    useAntigravityStore.setState((state) => ({
      sessions: { ...state.sessions, [key]: session },
      panes: { ...state.panes, [paneId]: key },
    }));
    // A restored pane immediately loads its saved session transcript.
    if (data.sessionId) void ensureStarted(key);
    return { paneId, key };
  });
  return () => paneSessions.release(paneId, held);
}

export function paneSessionKey(paneId: string): string | undefined {
  return useAntigravityStore.getState().panes[paneId];
}

/** Replaces the session inside a pane (New session or switching from History). */
function replaceSession(key: string, seed: { sessionId?: string; cwd?: string }): string | undefined {
  const old = getSession(key);
  if (!old) return undefined;
  const next = newKey(old.paneId);
  const mode = currentOptionValue(old, "mode") ?? old.savedMode;
  const model = currentOptionValue(old, "model") ?? old.savedModel;
  const thoughtLevel = currentOptionValue(old, "thought_level") ?? old.savedThoughtLevel;
  const session = createSession({
    key: next,
    paneId: old.paneId,
    cwd: seed.cwd ?? old.cwd,
    sessionId: seed.sessionId,
    mode,
    model,
    thoughtLevel,
  });
  session.panel = old.panel;
  const held = paneSessions.get(old.paneId);
  if (held) held.key = next;
  const draft = drafts.get(key);
  drafts.delete(key);
  if (draft) drafts.set(next, draft);
  promptQueues.delete(key);
  activeTurns.delete(key);
  settingQueues.delete(key);
  useAntigravityStore.setState((state) => {
    const { [key]: _gone, ...sessions } = state.sessions;
    return { sessions: { ...sessions, [next]: session }, panes: { ...state.panes, [old.paneId]: next } };
  });
  persist(next, { cwd: session.cwd, sessionId: seed.sessionId });
  void closeProcess(key);
  return next;
}

/* ---- Queued prompts ---- */

export type QueuedPrompt = {
  queueId: string;
  text: string;
  images: ImageAttachment[];
  mentions: FileMention[];
};

const promptQueues = new Map<string, QueuedPrompt[]>();
let queueSeq = 0;

/* ---- Live ACP connections (one per session key) ---- */

type LiveConn = {
  connId: string;
  client: AcpClient;
  started: Promise<boolean>;
  closing: boolean;
  /** Session updates buffered until the next animation frame. */
  updates: SessionUpdate[];
  flushing: boolean;
};

const live = new Map<string, LiveConn>();

let startupTimeoutMs = 30_000;
/** Test hook to bound startup timeout in unit tests. */
export function setStartupTimeoutMs(ms: number): void {
  startupTimeoutMs = ms;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function nextFrame(run: () => void): void {
  if (typeof requestAnimationFrame !== "function" || (typeof document !== "undefined" && document.hidden)) {
    setTimeout(run, 16);
    return;
  }
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    run();
  };
  requestAnimationFrame(once);
  setTimeout(once, 100);
}

function flushUpdates(key: string): void {
  const entry = live.get(key);
  if (!entry || entry.updates.length === 0) return;
  const batch = entry.updates.splice(0);
  const edited = new Set<string>();
  const now = Date.now();
  updateSession(key, (session) => {
    let next = session;
    for (const update of batch) {
      const res = reduceUpdate(next, update, now);
      next = res.session;
      for (const path of res.editedPaths) edited.add(path);
    }
    return next;
  });
  if (edited.size > 0 && pluginSettings(ANTIGRAVITY_KIND).followFiles === true) {
    const last = [...edited].pop();
    if (last) openSessionFile(key, last);
  }
}

function enqueueUpdate(key: string, update: SessionUpdate): void {
  const entry = live.get(key);
  if (!entry) return;
  entry.updates.push(update);
  if (!entry.flushing) {
    entry.flushing = true;
    nextFrame(() => {
      entry.flushing = false;
      flushUpdates(key);
    });
  }
}

function notifyBackground(key: string): void {
  const session = getSession(key);
  if (session && !hostActions.isActivePane(session.paneId)) {
    hostActions.markActivity(session.paneId);
  }
}

/** Reads the current value of a select configOption (or legacy mode). */
export function currentOptionValue(session: AntigravitySession | undefined, category: string): string | undefined {
  if (!session) return undefined;
  const opt = findConfigOption(session.configOptions, category);
  if (opt?.type === "select") return opt.currentValue;
  if (category === "mode") return session.modes?.currentModeId ?? session.savedMode;
  if (category === "model") return session.savedModel;
  if (category === "thought_level") return session.savedThoughtLevel;
  return undefined;
}

/** Closes any existing process and starts a fresh ACP connection (used by Retry / Reconnect). */
export async function reconnectSession(key: string): Promise<boolean> {
  await closeProcess(key);
  return ensureStarted(key);
}

/** Ensures the session's `agy acp` process is running and initialized. */
export async function ensureStarted(key: string): Promise<boolean> {
  const existing = live.get(key);
  if (existing && !existing.closing && !existing.client.isClosed) {
    return existing.started;
  }
  const session = getSession(key);
  if (!session) return false;

  const connId = `${key}#${++keySeq}`;
  const isRestoring = Boolean(session.sessionId);
  updateSession(key, {
    status: "starting",
    error: undefined,
    authRequired: false,
    ...(isRestoring ? { loadingTranscript: true } : {}),
  });

  const entry: LiveConn = {
    connId,
    client: null as unknown as AcpClient,
    started: Promise.resolve(false),
    closing: false,
    updates: [],
    flushing: false,
  };

  const client = new AcpClient(
    {
      send: (line) => antigravityAcpSend(connId, line),
      close: () => antigravityAcpClose(connId),
    },
    {
      onUpdate: (_sid, update) => {
        if (live.get(key) !== entry) return;
        enqueueUpdate(key, update);
      },
      onPermissionRequest: (rpcId, params) => {
        if (live.get(key) !== entry) return;
        flushUpdates(key);
        updateSession(key, (s) => ({
          permissions: [...s.permissions, { rpcId, sessionId: params.sessionId, toolCall: params.toolCall, options: params.options }],
        }));
        notifyBackground(key);
      },
      onElicitationRequest: (rpcId, request) => {
        if (live.get(key) !== entry) return;
        flushUpdates(key);
        updateSession(key, (s) => ({
          elicitations: [...s.elicitations, { rpcId, request }],
        }));
        notifyBackground(key);
      },
      onElicitationComplete: (elicitationId) => {
        if (live.get(key) !== entry) return;
        updateSession(key, (s) => ({
          elicitations: s.elicitations.filter((e) => !("elicitationId" in e.request) || e.request.elicitationId !== elicitationId),
        }));
      },
      onExit: ({ code, stderr, authRequired }) => {
        if (live.get(key) !== entry || entry.closing) return;
        flushUpdates(key);
        live.delete(key);
        activeTurns.delete(key);
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        const msg = authRequired
          ? "Antigravity authentication is required. Sign in with `agy acp --login`."
          : `Antigravity exited${code === null ? "" : ` (${code})`}.${tail ? `\n${tail}` : ""}`;
        updateSession(key, (s) => failSession(s, msg, Date.now(), authRequired));
      },
    },
  );
  entry.client = client;
  live.set(key, entry);

  entry.started = (async () => {
    try {
      const settings = pluginSettings(ANTIGRAVITY_KIND);
      const agyPath = typeof settings.agyPath === "string" ? settings.agyPath.trim() : undefined;
      const sandbox = settings.sandbox === true;
      const agent = typeof settings.agentPreset === "string" ? settings.agentPreset.trim() : undefined;
      const additionalDirs = Array.isArray(settings.additionalDirs)
        ? settings.additionalDirs.filter((d): d is string => typeof d === "string" && d.trim() !== "")
        : [];

      const startupWork = async () => {
        const openInfo = await antigravityAcpOpen((line) => client.receive(line), {
          connId,
          cwd: session.cwd,
          agyPath,
          sandbox,
          agent,
          additionalDirs,
        });

        if (live.get(key) !== entry || entry.closing) {
          await client.close();
          return false;
        }

        const init = await client.initialize();
        if (live.get(key) !== entry || entry.closing) {
          await client.close();
          return false;
        }

        const caps = init.agentCapabilities;
        const savedId = getSession(key)?.sessionId;
        let activeSessionId = savedId;
        let configOptions: SessionConfigOption[] = [];
        let modes = undefined as AntigravitySession["modes"];

        if (savedId && caps?.loadSession) {
          // Rebuild into fresh transcript state so `session/load` replay never duplicates prior items on reconnect.
          const snapshot = getSession(key);
          updateSession(key, { items: [], tools: {}, changedFiles: {}, plan: [] });
          try {
            const loaded = await client.loadSession({
              sessionId: savedId,
              cwd: session.cwd,
              additionalDirectories: additionalDirs.length ? additionalDirs : undefined,
            });
            flushUpdates(key);
            configOptions = loaded.configOptions ?? [];
            modes = loaded.modes ?? undefined;
          } catch {
            entry.updates.length = 0;
            activeSessionId = undefined;
            if (snapshot) {
              updateSession(key, {
                items: [
                  ...snapshot.items,
                  {
                    kind: "notice",
                    id: `notice:restore:${Date.now()}`,
                    tone: "warn",
                    title: "Previous session unavailable",
                    description: "Started a fresh Antigravity session in this folder.",
                  },
                ],
                tools: snapshot.tools,
                changedFiles: snapshot.changedFiles,
                plan: snapshot.plan,
              });
            }
          }
        } else if (savedId && caps?.sessionCapabilities?.resume) {
          try {
            const resumed = await client.resumeSession({
              sessionId: savedId,
              cwd: session.cwd,
              additionalDirectories: additionalDirs.length ? additionalDirs : undefined,
            });
            configOptions = resumed.configOptions ?? [];
            modes = resumed.modes ?? undefined;
          } catch {
            activeSessionId = undefined;
          }
        } else {
          activeSessionId = undefined;
        }

        if (!activeSessionId) {
          const created = await client.newSession({
            cwd: session.cwd,
            additionalDirectories: additionalDirs.length ? additionalDirs : undefined,
          });
          activeSessionId = created.sessionId;
          configOptions = created.configOptions ?? [];
          modes = created.modes ?? undefined;
        }

        if (live.get(key) !== entry || entry.closing) {
          await client.close();
          return false;
        }

        flushUpdates(key);
        updateSession(key, {
          status: "idle",
          loadingTranscript: false,
          sessionId: activeSessionId,
          agentInfo: init.agentInfo ?? undefined,
          capabilities: caps,
          agyPath: openInfo.agy,
          agyVersion: openInfo.version,
          configOptions: configOptions.length ? configOptions : (getSession(key)?.configOptions ?? []),
          modes: modes ?? getSession(key)?.modes,
        });

        // Apply saved preferences for newly created sessions.
        const current = getSession(key);
        if (current && !savedId) {
          await applyInitialPreferences(key, client, activeSessionId, current);
        }
        return true;
      };

      return await withTimeout(startupWork(), startupTimeoutMs, "Antigravity startup");
    } catch (error) {
      if (live.get(key) === entry) live.delete(key);
      await client.close().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      const authRequired = error instanceof AcpRpcError ? error.authRequired : isAuthError(undefined, message);
      updateSession(key, (s) => ({
        ...failSession(s, message, Date.now(), authRequired),
        loadingTranscript: false,
      }));
      return false;
    }
  })();

  return entry.started;
}

async function applyInitialPreferences(
  key: string,
  client: AcpClient,
  sessionId: string,
  session: AntigravitySession,
): Promise<void> {
  const settings = pluginSettings(ANTIGRAVITY_KIND);
  const preferredMode =
    session.savedMode ?? (typeof settings.defaultMode === "string" && settings.defaultMode ? settings.defaultMode : undefined);

  // Permission mode is safety-critical: if an explicit mode was requested and
  // rejected by the agent, fail startup so no prompt runs under higher permissions.
  if (preferredMode && preferredMode !== "default") {
    const latest = getSession(key);
    if (!latest) return;
    const modeOpt = findConfigOption(latest.configOptions, "mode");
    if (modeOpt?.type === "select" && modeOpt.currentValue !== preferredMode) {
      const valid = flattenSelectOptions(modeOpt).some((o) => o.value === preferredMode);
      if (valid) {
        try {
          const res = await client.setConfigOption(sessionId, modeOpt.id, preferredMode);
          if (res.configOptions?.length) updateSession(key, { configOptions: res.configOptions });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Could not apply requested permission mode "${preferredMode}": ${detail}`);
        }
      }
    } else if (latest.modes && latest.modes.currentModeId !== preferredMode) {
      const valid = latest.modes.availableModes.some((m) => m.id === preferredMode);
      if (valid) {
        try {
          await client.setMode(sessionId, preferredMode);
          updateSession(key, (s) => (s.modes ? { modes: { ...s.modes, currentModeId: preferredMode } } : {}));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Could not apply requested permission mode "${preferredMode}": ${detail}`);
        }
      }
    }
  }

  // Non-safety preferences (model, thought_level) are best-effort.
  const optionalPicks: [string, string | undefined][] = [
    ["model", session.savedModel],
    ["thought_level", session.savedThoughtLevel],
  ];
  for (const [category, desired] of optionalPicks) {
    if (!desired) continue;
    const latest = getSession(key);
    if (!latest) return;
    const opt = findConfigOption(latest.configOptions, category);
    if (opt?.type === "select" && opt.currentValue !== desired) {
      const valid = flattenSelectOptions(opt).some((o) => o.value === desired);
      if (valid) {
        try {
          const res = await client.setConfigOption(sessionId, opt.id, desired);
          if (res.configOptions?.length) updateSession(key, { configOptions: res.configOptions });
        } catch {
          // Best-effort preference; ignore on startup.
        }
      }
    }
  }
}

/** Warms up `agy acp` in the background (e.g. when `/` is typed before the first turn). */
export function warmUp(key: string): void {
  const session = getSession(key);
  if (!session || session.status !== "new") return;
  void ensureStarted(key);
}

/** Closes the session's `agy acp` process cleanly. */
export async function closeProcess(key: string): Promise<void> {
  const entry = live.get(key);
  if (!entry) return;
  entry.closing = true;
  live.delete(key);
  activeTurns.delete(key);
  const session = getSession(key);
  if (session?.sessionId && session.capabilities?.sessionCapabilities?.close && !entry.client.isClosed) {
    await Promise.race([
      entry.client.closeSession(session.sessionId).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 600)),
    ]);
  }
  await entry.client.close();
}

/* ---- Prompting & Queueing ---- */

function buildPromptBlocks(text: string, images: ImageAttachment[], mentions: FileMention[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const mention of mentions) {
    blocks.push({
      type: "resource_link",
      uri: pathToFileUrl(mention.path),
      name: mention.label,
    });
  }
  for (const img of images) {
    blocks.push({ type: "image", mimeType: img.mediaType, data: img.data });
  }
  if (text.trim() !== "" || blocks.length === 0) {
    blocks.push({ type: "text", text });
  }
  return blocks;
}

/** Waits for any pending setting changes; returns `false` if a permission-mode change was refused. */
async function settingsSettled(key: string): Promise<boolean> {
  const queue = settingQueues.get(key);
  if (!queue) return true;
  await queue.tail;
  if (queue.modeRefused) {
    queue.modeRefused = false;
    return false;
  }
  return true;
}

/**
 * Sends a prompt (or queues it synchronously if a turn is already active or
 * starting). Returns `false` if the prompt was not sent and the composer should
 * restore the draft (e.g. refused permission mode or unsupported image attachment).
 */
export async function sendMessage(
  key: string,
  text: string,
  images: ImageAttachment[] = [],
  mentions: FileMention[] = [],
): Promise<boolean> {
  const session = getSession(key);
  if (!session || session.loadingTranscript) return false;
  if (!text.trim() && images.length === 0 && mentions.length === 0) return false;

  // Reserve synchronously before any await so rapid sends during startup queue cleanly.
  if (session.status === "running" || activeTurns.has(key)) {
    const queueId = `q:${++queueSeq}`;
    const queue = promptQueues.get(key) ?? [];
    queue.push({ queueId, text, images, mentions });
    promptQueues.set(key, queue);
    updateSession(key, (s) => ({
      items: [
        ...s.items,
        {
          kind: "user",
          id: queueId,
          queueId,
          text,
          images: images.length ? images : undefined,
          mentions: mentions.length ? mentions : undefined,
          queued: true,
        },
      ],
    }));
    return true;
  }

  activeTurns.add(key);
  return dispatchPrompt(key, text, images, mentions);
}

/** Removes a queued prompt and returns its full payload so the composer can restore it. */
export function cancelQueuedMessage(key: string, queueId: string): QueuedPrompt | undefined {
  const queue = promptQueues.get(key);
  if (!queue) return undefined;
  const idx = queue.findIndex((q) => q.queueId === queueId);
  if (idx < 0) return undefined;
  const [removed] = queue.splice(idx, 1);
  updateSession(key, (s) => ({
    items: s.items.filter((item) => !(item.kind === "user" && item.queueId === queueId)),
  }));
  return removed;
}

async function dispatchPrompt(
  key: string,
  text: string,
  images: ImageAttachment[],
  mentions: FileMention[],
  existingQueueId?: string,
): Promise<boolean> {
  const userItemId = existingQueueId ?? `user:${++queueSeq}`;
  if (!existingQueueId) {
    updateSession(key, (s) => ({
      items: [
        ...s.items,
        {
          kind: "user",
          id: userItemId,
          text,
          images: images.length ? images : undefined,
          mentions: mentions.length ? mentions : undefined,
        },
      ],
      error: undefined,
      authRequired: false,
    }));
  } else {
    // Move the dequeued prompt to the end of the timeline (after the preceding turn's output).
    updateSession(key, (s) => {
      const target = s.items.find((item) => item.kind === "user" && item.queueId === existingQueueId);
      const rest = s.items.filter((item) => !(item.kind === "user" && item.queueId === existingQueueId));
      const promoted = target && target.kind === "user"
        ? { ...target, queued: false }
        : {
            kind: "user" as const,
            id: userItemId,
            text,
            images: images.length ? images : undefined,
            mentions: mentions.length ? mentions : undefined,
          };
      return { items: [...rest, promoted] };
    });
  }

  const rollbackUserItem = () => {
    updateSession(key, (s) => ({
      items: s.items.filter((item) => item.id !== userItemId),
    }));
  };

  try {
    const ok = await ensureStarted(key);
    if (!ok) {
      rollbackUserItem();
      activeTurns.delete(key);
      return false;
    }

    if (!(await settingsSettled(key))) {
      rollbackUserItem();
      updateSession(key, (s) => ({
        items: [
          ...s.items,
          {
            kind: "notice",
            id: `mode-refused:${Date.now()}`,
            tone: "warn",
            title: "Message not sent",
            description: "A permission mode change was rejected by Antigravity. Check the active mode and send again.",
          },
        ],
      }));
      activeTurns.delete(key);
      return false;
    }

    const entry = live.get(key);
    const current = getSession(key);
    if (!entry || !current?.sessionId) {
      rollbackUserItem();
      activeTurns.delete(key);
      return false;
    }

    // ACP image support is strictly opt-in (`promptCapabilities.image === true`).
    if (images.length > 0 && current.capabilities?.promptCapabilities?.image !== true) {
      rollbackUserItem();
      updateSession(key, (s) => ({
        items: [
          ...s.items,
          {
            kind: "notice",
            id: `img-unsupported:${Date.now()}`,
            tone: "warn",
            title: "Images not supported",
            description: "This Antigravity ACP agent did not advertise image prompt support. Remove attached images to send.",
          },
        ],
      }));
      activeTurns.delete(key);
      return false;
    }

    // Persist sessionId once a real prompt has been sent.
    persist(key, { sessionId: current.sessionId });

    updateSession(key, { status: "running", turnStartedAt: Date.now() });
    const blocks = buildPromptBlocks(text, images, mentions);

    const res = await entry.client.prompt(current.sessionId, blocks);
    flushUpdates(key);
    if (live.get(key) !== entry) {
      activeTurns.delete(key);
      return true;
    }
    updateSession(key, (s) => finishTurn(s, res.stopReason, Date.now(), res.usage));
    notifyBackground(key);

    // Drain next queued prompt unless this turn was cancelled.
    if (res.stopReason !== "cancelled") {
      const next = promptQueues.get(key)?.shift();
      if (next) {
        void dispatchPrompt(key, next.text, next.images, next.mentions, next.queueId);
        return true;
      }
    }
    activeTurns.delete(key);
    return true;
  } catch (error) {
    flushUpdates(key);
    activeTurns.delete(key);
    const entry = live.get(key);
    if (!entry || entry.closing) return false;
    const message = error instanceof Error ? error.message : String(error);
    const authRequired = error instanceof AcpRpcError ? error.authRequired : isAuthError(undefined, message);
    if (authRequired) {
      // Close the unauthenticated process so Retry starts a fresh session with updated credentials.
      await closeProcess(key);
    }
    updateSession(key, (s) => ({
      ...finishTurn(s, "cancelled", Date.now()),
      status: authRequired ? "error" : "idle",
      error: authRequired ? message : undefined,
      authRequired,
      items: [
        ...s.items,
        {
          kind: "notice",
          id: `err:${Date.now()}`,
          tone: "error",
          title: authRequired ? "Authentication required" : "Turn failed",
          description: message,
        },
      ],
    }));
    notifyBackground(key);
    return false;
  }
}

/** Cancels the running turn via `session/cancel`. */
export async function interrupt(key: string): Promise<void> {
  const entry = live.get(key);
  const session = getSession(key);
  if (!entry || !session?.sessionId || session.status !== "running") return;
  for (const perm of session.permissions) {
    void entry.client.respondPermission(perm.rpcId, { outcome: { outcome: "cancelled" } });
  }
  for (const elic of session.elicitations) {
    void entry.client.respondElicitation(elic.rpcId, { action: "cancel" });
  }
  updateSession(key, { permissions: [], elicitations: [] });
  await entry.client.cancel(session.sessionId);
}

/* ---- Permissions & Elicitations ---- */

export async function answerPermission(
  key: string,
  rpcId: RequestId,
  optionId: string | "cancelled",
): Promise<void> {
  const entry = live.get(key);
  const session = getSession(key);
  const pending = session?.permissions.find((p) => p.rpcId === rpcId);
  if (!pending) return;

  const picked = optionId === "cancelled" ? undefined : pending.options.find((o) => o.optionId === optionId);
  const denied = optionId === "cancelled" || picked?.kind === "reject_once" || picked?.kind === "reject_always";
  const toolId = pending.toolCall.toolCallId;

  updateSession(key, (s) => ({
    permissions: s.permissions.filter((p) => p.rpcId !== rpcId),
    tools:
      denied && toolId && s.tools[toolId]
        ? { ...s.tools, [toolId]: { ...s.tools[toolId], status: "denied", endedAt: Date.now() } }
        : s.tools,
  }));

  if (!entry) return;
  if (optionId === "cancelled") {
    await entry.client.respondPermission(rpcId, { outcome: { outcome: "cancelled" } });
  } else {
    await entry.client.respondPermission(rpcId, { outcome: { outcome: "selected", optionId } });
  }
}

export async function answerElicitation(
  key: string,
  rpcId: RequestId,
  response: CreateElicitationResponse,
): Promise<void> {
  const entry = live.get(key);
  updateSession(key, (s) => ({
    elicitations: s.elicitations.filter((e) => e.rpcId !== rpcId),
  }));
  if (!entry) return;
  await entry.client.respondElicitation(rpcId, response);
}

/* ---- Configuration & Modes ---- */

function enqueueSetting(key: string, isMode: boolean, task: () => Promise<boolean>): Promise<boolean> {
  let queue = settingQueues.get(key);
  if (!queue) {
    queue = { tail: Promise.resolve(), modeRefused: false };
    settingQueues.set(key, queue);
  }
  const run = queue.tail.then(async () => {
    const ok = await task();
    if (isMode) queue!.modeRefused = !ok;
    return ok;
  });
  queue.tail = run.then(
    () => {},
    () => {},
  );
  return run;
}

export function setConfigValue(key: string, configId: string, value: string | boolean): Promise<boolean> {
  const initial = getSession(key);
  const initialOpt = initial?.configOptions.find((o) => o.id === configId);
  const isMode = initialOpt?.category === "mode" || configId === "mode";

  return enqueueSetting(key, isMode, async () => {
    const session = getSession(key);
    if (!session) return false;
    const opt = session.configOptions.find((o) => o.id === configId);
    const prevValue = opt?.currentValue;
    const entry = live.get(key);

    if (!entry || !session.sessionId) {
      // Pre-start preference: saved locally and applied strictly on session start.
      updateSession(key, (s) => ({
        configOptions: s.configOptions.map((o) => {
          if (o.id !== configId) return o;
          if (o.type === "boolean" && typeof value === "boolean") return { ...o, currentValue: value };
          if (o.type === "select" && typeof value === "string") return { ...o, currentValue: value };
          return o;
        }),
        ...(opt?.category === "mode" && typeof value === "string" ? { savedMode: value } : {}),
        ...(opt?.category === "model" && typeof value === "string" ? { savedModel: value } : {}),
        ...(opt?.category === "thought_level" && typeof value === "string" ? { savedThoughtLevel: value } : {}),
      }));
      if (typeof value === "string") {
        if (opt?.category === "mode" || configId === "mode") persist(key, { mode: value });
        if (opt?.category === "model" || configId === "model") persist(key, { model: value });
        if (opt?.category === "thought_level" || configId === "thought_level") persist(key, { thoughtLevel: value });
      }
      return true;
    }

    // Live session: wait for RPC acknowledgment before persisting; revert on rejection.
    try {
      const res = await entry.client.setConfigOption(session.sessionId, configId, value);
      updateSession(key, (s) => ({
        configOptions: res.configOptions?.length
          ? res.configOptions
          : s.configOptions.map((o) => {
              if (o.id !== configId) return o;
              if (o.type === "boolean" && typeof value === "boolean") return { ...o, currentValue: value };
              if (o.type === "select" && typeof value === "string") return { ...o, currentValue: value };
              return o;
            }),
        ...(opt?.category === "mode" && typeof value === "string" ? { savedMode: value } : {}),
        ...(opt?.category === "model" && typeof value === "string" ? { savedModel: value } : {}),
        ...(opt?.category === "thought_level" && typeof value === "string" ? { savedThoughtLevel: value } : {}),
      }));
      if (typeof value === "string") {
        if (opt?.category === "mode" || configId === "mode") persist(key, { mode: value });
        if (opt?.category === "model" || configId === "model") persist(key, { model: value });
        if (opt?.category === "thought_level" || configId === "thought_level") persist(key, { thoughtLevel: value });
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateSession(key, (s) => ({
        configOptions:
          prevValue !== undefined
            ? s.configOptions.map((o) => {
                if (o.id !== configId) return o;
                if (o.type === "boolean" && typeof prevValue === "boolean") return { ...o, currentValue: prevValue };
                if (o.type === "select" && typeof prevValue === "string") return { ...o, currentValue: prevValue };
                return o;
              })
            : s.configOptions,
        items: [
          ...s.items,
          {
            kind: "notice",
            id: `cfg:${Date.now()}`,
            tone: "warn",
            title: `Could not update ${opt?.name ?? configId}`,
            description: message,
          },
        ],
      }));
      return false;
    }
  });
}

export function setModeValue(key: string, modeId: string): Promise<boolean> {
  const session = getSession(key);
  if (!session) return Promise.resolve(false);
  const modeOpt = findConfigOption(session.configOptions, "mode");
  if (modeOpt) return setConfigValue(key, modeOpt.id, modeId);

  return enqueueSetting(key, true, async () => {
    const latest = getSession(key);
    if (!latest) return false;
    const entry = live.get(key);
    if (!entry || !latest.sessionId) {
      updateSession(key, (s) => ({
        savedMode: modeId,
        modes: s.modes ? { ...s.modes, currentModeId: modeId } : undefined,
      }));
      persist(key, { mode: modeId });
      return true;
    }

    try {
      await entry.client.setMode(latest.sessionId, modeId);
      updateSession(key, (s) => ({
        savedMode: modeId,
        modes: s.modes ? { ...s.modes, currentModeId: modeId } : undefined,
      }));
      persist(key, { mode: modeId });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateSession(key, (s) => ({
        items: [...s.items, { kind: "notice", id: `mode:${Date.now()}`, tone: "warn", title: "Could not change mode", description: message }],
      }));
      return false;
    }
  });
}

export function cycleMode(key: string): void {
  const session = getSession(key);
  if (!session) return;
  const modeOpt = findConfigOption(session.configOptions, "mode");
  if (modeOpt?.type === "select") {
    const options = flattenSelectOptions(modeOpt);
    if (options.length < 2) return;
    const idx = options.findIndex((o) => o.value === modeOpt.currentValue);
    const next = options[(idx + 1) % options.length];
    void setConfigValue(key, modeOpt.id, next.value);
    return;
  }
  if (session.modes && session.modes.availableModes.length >= 2) {
    const list = session.modes.availableModes;
    const idx = list.findIndex((m) => m.id === session.modes!.currentModeId);
    const next = list[(idx + 1) % list.length];
    void setModeValue(key, next.id);
  }
}

/* ---- Session management (folder, new, history) ---- */

export function setCwd(key: string, cwd: string): void {
  const clean = cwd.replace(/(.)\/+$/, "$1");
  const session = getSession(key);
  if (!session || session.cwd === clean) return;
  // Changing folder before the first message discards any warmed-up session bound to the old folder.
  if (session.items.length === 0) {
    void closeProcess(key);
    updateSession(key, {
      cwd: clean,
      status: "new",
      sessionId: undefined,
      configOptions: [],
      modes: undefined,
      availableCommands: [],
      usage: undefined,
      error: undefined,
      authRequired: false,
    });
    persist(key, { cwd: clean, sessionId: undefined });
    return;
  }
  updateSession(key, { cwd: clean });
  persist(key, { cwd: clean });
}

export function resetSession(key: string): string | undefined {
  return replaceSession(key, { sessionId: undefined });
}

export async function switchToSession(key: string, target: { sessionId: string; cwd?: string }): Promise<void> {
  const next = replaceSession(key, { sessionId: target.sessionId, cwd: target.cwd });
  if (next) await ensureStarted(next);
}

export async function listPastSessions(
  key: string,
  allFolders = false,
  cursor?: string,
): Promise<{ sessions: SessionInfo[]; nextCursor?: string; supported: boolean }> {
  const ok = await ensureStarted(key);
  if (!ok) return { sessions: [], supported: false };
  const entry = live.get(key);
  const session = getSession(key);
  if (!entry || !session) return { sessions: [], supported: false };
  if (!session.capabilities?.sessionCapabilities?.list) return { sessions: [], supported: false };
  const res = await entry.client.listSessions({
    ...(allFolders ? {} : { cwd: session.cwd }),
    ...(cursor ? { cursor } : {}),
  });
  return {
    sessions: res.sessions ?? [],
    nextCursor: res.nextCursor ?? undefined,
    supported: true,
  };
}

export async function deletePastSession(key: string, sessionId: string): Promise<boolean> {
  const entry = live.get(key);
  const session = getSession(key);
  if (!entry || !session?.capabilities?.sessionCapabilities?.delete) return false;
  await entry.client.deleteSession(sessionId);
  return true;
}

/* ---- Close blockers & status ---- */

export function paneIsRunning(paneId: string): boolean {
  const key = paneSessionKey(paneId);
  return key ? getSession(key)?.status === "running" || activeTurns.has(key) : false;
}

export function sessionWork(key: string): string | undefined {
  const session = getSession(key);
  if (!session) return undefined;
  if (session.status === "running" || activeTurns.has(key)) return "Antigravity";
  if ((promptQueues.get(key)?.length ?? 0) > 0) return "Antigravity";
  return undefined;
}

export function appendCommandOutput(key: string, text: string): void {
  updateSession(key, (s) => ({
    items: [...s.items, { kind: "command", id: `cmd:${Date.now()}:${++queueSeq}`, text }],
  }));
}
