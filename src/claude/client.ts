import { type BridgeInfo, claudeBridgeOpen, claudeBridgeSend } from "../ipc/claude";
import { pluginSettings } from "../plugins/settings";
import {
  BRIDGE_PROTOCOL,
  type BridgeError,
  type BridgeEvent,
  type BridgeMethod,
  type BridgeParams,
  type BridgeResult,
  type SessionKey,
} from "./protocol";

/*
 * The webview's side of the bridge protocol: requests with answers, and
 * events routed by session. The bridge is started on the first request and
 * again after it exits. See docs/claude-code.md.
 */

export const CLAUDE_KIND = "claude-code";

export class BridgeRequestError extends Error {
  readonly code: BridgeError["code"];
  constructor(error: BridgeError) {
    super(error.message);
    this.code = error.code;
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

let nextId = 1;
const pending = new Map<number, Pending>();
const sessionListeners = new Map<SessionKey, Set<(event: BridgeEvent) => void>>();
const bridgeListeners = new Set<(event: BridgeEvent) => void>();
let opening: Promise<BridgeInfo> | undefined;
let info: (BridgeInfo & { sdkVersion?: string; nodeVersion?: string }) | undefined;

function onLine(line: string): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line);
  } catch {
    console.warn("[claude] unreadable bridge line", line.slice(0, 200));
    return;
  }
  if (typeof message.id === "number") {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new BridgeRequestError(message.error as BridgeError));
    else waiting.resolve(message.result);
    return;
  }
  const event = message as BridgeEvent;
  if (event.event === "bridgeExit") {
    opening = undefined;
    info = undefined;
    const error = new BridgeRequestError({ message: bridgeExitMessage(event.stderr, event.code), code: "closed" });
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
  }
  if ("session" in event) for (const listener of sessionListeners.get(event.session) ?? []) listener(event);
  for (const listener of bridgeListeners) listener(event);
}

function bridgeExitMessage(stderr: string, code: number | null): string {
  const tail = stderr.trim().split("\n").slice(-6).join("\n");
  return `The Claude Code bridge stopped${code === null ? "" : ` (exit ${code})`}.${tail ? `\n${tail}` : ""}`;
}

async function open(): Promise<BridgeInfo> {
  const settings = pluginSettings(CLAUDE_KIND);
  const opened = await claudeBridgeOpen(onLine, {
    claudePath: typeof settings.claudePath === "string" ? settings.claudePath : undefined,
    nodePath: typeof settings.nodePath === "string" ? settings.nodePath : undefined,
  });
  const hello = await send("hello", {});
  if (hello.protocol !== BRIDGE_PROTOCOL) throw new BridgeRequestError({ message: `The Claude Code bridge speaks protocol ${hello.protocol}, expected ${BRIDGE_PROTOCOL}. Rebuild it with \`bun run build:bridge\`.`, code: "invalid" });
  info = { ...opened, sdkVersion: hello.sdkVersion, nodeVersion: hello.nodeVersion };
  return opened;
}

function send<M extends BridgeMethod>(method: M, params: BridgeParams<M>): Promise<BridgeResult<M>> {
  const id = nextId++;
  return new Promise<BridgeResult<M>>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    claudeBridgeSend(JSON.stringify({ id, method, params })).catch((error) => {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** Sends a request, starting the bridge first if needed. Rejects with a `BridgeRequestError` (or an IPC error). */
export async function request<M extends BridgeMethod>(method: M, params: BridgeParams<M>): Promise<BridgeResult<M>> {
  if (!opening) {
    opening = open();
    opening.catch(() => {
      opening = undefined;
    });
  }
  await opening;
  return send(method, params);
}

/** Events of one session. Returns an unsubscribe function. */
export function onSessionEvent(session: SessionKey, listener: (event: BridgeEvent) => void): () => void {
  let set = sessionListeners.get(session);
  if (!set) sessionListeners.set(session, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) sessionListeners.delete(session);
  };
}

/** Every event (including `bridgeExit`). Returns an unsubscribe function. */
export function onBridgeEvent(listener: (event: BridgeEvent) => void): () => void {
  bridgeListeners.add(listener);
  return () => bridgeListeners.delete(listener);
}

/** What the running bridge reported (`undefined` until it is open). */
export function bridgeInfo() {
  return info;
}
