import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { toAiError } from "./ai";

/*
 * Native stdio transport for `agy acp` (src-tauri/src/antigravity/): one
 * process per pane session, keyed by `connId`. Lines are ACP JSON-RPC 2.0
 * messages; this module only moves lines. Outside Tauri (`bun run dev` in a
 * browser) a mock ACP agent plays a scripted session (src/antigravity/mock.ts).
 */

export type AcpOpenOptions = {
  connId: string;
  cwd?: string;
  agyPath?: string;
  sandbox?: boolean;
  agent?: string;
  additionalDirs?: string[];
};

export type AcpOpenInfo = {
  agy: string;
  version: string | null;
};

type MockConn = { send(line: string): void; close(): void };
const mocks = new Map<string, MockConn>();

function rethrow(error: unknown): never {
  throw new Error(toAiError(error).message);
}

/** Spawns `agy acp` for `options.connId` and streams stdout JSON-RPC lines to `onLine`. */
export async function antigravityAcpOpen(onLine: (line: string) => void, options: AcpOpenOptions): Promise<AcpOpenInfo> {
  if (!isTauri()) {
    mocks.get(options.connId)?.close();
    const { openMockAcp } = await import("../antigravity/mock");
    mocks.set(options.connId, openMockAcp(onLine, { cwd: options.cwd ?? "/workspace" }));
    return { agy: "mock-agy", version: "1.5.12 (mock)" };
  }
  const channel = new Channel<string>();
  channel.onmessage = onLine;
  return invoke<AcpOpenInfo>("antigravity_acp_open", {
    onEvent: channel,
    connId: options.connId,
    cwd: options.cwd || null,
    agyPath: options.agyPath || null,
    sandbox: options.sandbox ?? false,
    agent: options.agent || null,
    additionalDirs: options.additionalDirs?.length ? options.additionalDirs : null,
  }).catch(rethrow);
}

/** Writes one JSON-RPC line (no trailing newline) to the connection's stdin. */
export async function antigravityAcpSend(connId: string, line: string): Promise<void> {
  if (!isTauri()) {
    const conn = mocks.get(connId);
    if (!conn) throw new Error("The Antigravity ACP session is not running.");
    conn.send(line);
    return;
  }
  await invoke("antigravity_acp_send", { connId, line }).catch(rethrow);
}

/** Closes one `agy acp` connection and kills its process group. */
export async function antigravityAcpClose(connId: string): Promise<void> {
  if (!isTauri()) {
    const conn = mocks.get(connId);
    if (conn) {
      mocks.delete(connId);
      conn.close();
    }
    return;
  }
  await invoke("antigravity_acp_close", { connId }).catch(() => {});
}
