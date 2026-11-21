import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { toAiError } from "./ai";

/*
 * The Claude Code bridge process (src-tauri/src/claude/): one per window.
 * Lines are JSON (src/claude/protocol.ts); this module only moves them.
 * Outside Tauri (`bun run dev` in a browser) a mock bridge plays a scripted
 * session (src/claude/mock.ts).
 */

export type BridgeOpenOptions = {
  /** Overrides for the `claude` and `node` executables (a path, `~/…` or a name on the login shell's PATH). */
  claudePath?: string;
  nodePath?: string;
};
export type BridgeInfo = { node: string; claude: string | null };

let mock: { send(line: string): void; close(): void } | undefined;

/** The backend rejects with a serialized `{ kind, message }` (an `AiError`): an `Error` with its message. */
function rethrow(error: unknown): never {
  throw new Error(toAiError(error).message);
}

/**
 * Starts this window's bridge (replacing one already running) and streams
 * its stdout lines, plus the backend's `bridgeExit` event, to `onLine`.
 */
export async function claudeBridgeOpen(onLine: (line: string) => void, options: BridgeOpenOptions = {}): Promise<BridgeInfo> {
  if (!isTauri()) {
    mock?.close();
    mock = (await import("../claude/mock")).openMockBridge(onLine);
    return { node: "mock", claude: "mock" };
  }
  const channel = new Channel<string>();
  channel.onmessage = onLine;
  return invoke<BridgeInfo>("claude_bridge_open", { onEvent: channel, claudePath: options.claudePath || null, nodePath: options.nodePath || null }).catch(rethrow);
}

/** Writes one line (no trailing newline) to the bridge's stdin. Fails when no bridge is running. */
export async function claudeBridgeSend(line: string): Promise<void> {
  if (!isTauri()) {
    if (!mock) throw new Error("The Claude Code bridge is not running.");
    mock.send(line);
    return;
  }
  await invoke("claude_bridge_send", { line }).catch(rethrow);
}

/** Ends this window's bridge and every session in it. */
export async function claudeBridgeClose(): Promise<void> {
  if (!isTauri()) {
    mock?.close();
    mock = undefined;
    return;
  }
  await invoke("claude_bridge_close").catch(rethrow);
}
