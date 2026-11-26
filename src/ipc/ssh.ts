import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/*
 * Typed wrapper around the Rust SSH connection commands (src-tauri/src/ssh/commands.rs).
 * Outside Tauri (`bun run dev` in a browser), keeps an in-memory map so mock
 * `ssh <host>` sessions can exercise the full remote UI without a native backend.
 */

export type SshStatus = "connecting" | "connected" | "disconnected";

export type SshConnectionInfo = {
  id: string;
  label: string;
  host: string;
  user: string;
  port: number;
  remoteHome: string | null;
  remoteOs: string | null;
  remoteShell: string | null;
  status: SshStatus;
  sshArgs: string[];
};

export type RegisterSshConnection = {
  id: string;
  label: string;
  host: string;
  user: string;
  port: number;
  controlPath: string;
  ownedSocket: boolean;
  sshArgs: string[];
};

export type RestoreSshPayload = {
  id: string;
  label: string;
  host: string;
  user: string;
  port: number;
  remoteHome: string | null;
  sshArgs: string[];
};

// In-memory mock registry for plain-browser dev mode.
const mockConnections = new Map<string, SshConnectionInfo>();
const mockListeners = new Set<(info: SshConnectionInfo) => void>();

function emitMock(info: SshConnectionInfo): void {
  for (const listener of mockListeners) listener(info);
}

export async function registerSshConnection(connection: RegisterSshConnection): Promise<SshConnectionInfo> {
  if (!isTauri()) {
    const existing = mockConnections.get(connection.id);
    const info: SshConnectionInfo = {
      id: connection.id,
      label: connection.label,
      host: connection.host,
      user: connection.user,
      port: connection.port,
      remoteHome: existing?.remoteHome ?? "/home/demo",
      remoteOs: existing?.remoteOs ?? "Linux",
      remoteShell: existing?.remoteShell ?? "zsh",
      status: "connected",
      sshArgs: connection.sshArgs,
    };
    mockConnections.set(info.id, info);
    emitMock(info);
    return info;
  }
  return invoke<SshConnectionInfo>("ssh_register_connection", { connection });
}

export async function sshConnectionEnded(remoteId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("ssh_connection_ended", { remoteId });
}

export async function reconnectSsh(remoteId: string): Promise<SshConnectionInfo> {
  if (!isTauri()) {
    const existing = mockConnections.get(remoteId);
    if (!existing) throw new Error(`unknown SSH connection '${remoteId}'`);
    const next: SshConnectionInfo = { ...existing, status: "connected" };
    mockConnections.set(remoteId, next);
    emitMock(next);
    return next;
  }
  return invoke<SshConnectionInfo>("ssh_reconnect", { remoteId });
}

export async function restoreSshConnection(payload: RestoreSshPayload): Promise<SshConnectionInfo> {
  if (!isTauri()) {
    const existing = mockConnections.get(payload.id);
    if (existing) return existing;
    const info: SshConnectionInfo = {
      id: payload.id,
      label: payload.label,
      host: payload.host,
      user: payload.user,
      port: payload.port,
      remoteHome: payload.remoteHome,
      remoteOs: null,
      remoteShell: null,
      status: "disconnected",
      sshArgs: payload.sshArgs,
    };
    mockConnections.set(info.id, info);
    return info;
  }
  return invoke<SshConnectionInfo>("ssh_restore_connection", {
    id: payload.id,
    label: payload.label,
    host: payload.host,
    user: payload.user,
    port: payload.port,
    remoteHome: payload.remoteHome,
    sshArgs: payload.sshArgs,
  });
}

export async function listSshConnections(): Promise<SshConnectionInfo[]> {
  if (!isTauri()) return [...mockConnections.values()];
  return invoke<SshConnectionInfo[]>("ssh_list_connections");
}

export async function onSshConnectionChanged(listener: (info: SshConnectionInfo) => void): Promise<() => void> {
  if (!isTauri()) {
    mockListeners.add(listener);
    return () => {
      mockListeners.delete(listener);
    };
  }
  return listen<SshConnectionInfo>("ssh-connection-changed", (event) => listener(event.payload));
}

/** Whether a plain-browser mock SSH connection is currently active. */
export function isMockSshConnected(remoteId: string): boolean {
  return mockConnections.get(remoteId)?.status === "connected";
}

/** Test-only helper to clear mock SSH state between unit tests. */
export function _resetMockSshForTests(): void {
  mockConnections.clear();
  mockListeners.clear();
}
