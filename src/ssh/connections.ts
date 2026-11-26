import { useSyncExternalStore } from "react";
import { displayPath } from "../explorer/tree";
import {
  fallbackHostLabel,
  formatRemoteLocation,
  isValidRemoteId,
  parseLocation,
  remoteIdOf,
} from "../files/location";
import { clearRepoRootCache } from "../files/repoRoot";
import { type JsonFile, openJsonFile } from "../ipc/jsonFile";
import {
  type RegisterSshConnection,
  type SshConnectionInfo,
  listSshConnections,
  onSshConnectionChanged,
  reconnectSsh,
  registerSshConnection,
  restoreSshConnection,
  sshConnectionEnded,
} from "../ipc/ssh";

/*
 * Reactive registry of known SSH connections (live and restored).
 *
 * Persists minimal connection metadata (`ssh-connections.json`) so restored
 * remote explorer/editor/terminal panes know their host label, remote home
 * directory, and reconnect target immediately after an app restart.
 */

const FILE = "ssh-connections.json";
const KEY = "connections";
const MAX_SAVED = 64;
const SAVE_DELAY_MS = 300;

type SavedConnection = {
  id: string;
  label: string;
  host: string;
  user: string;
  port: number;
  remoteHome: string | null;
  sshArgs: string[];
  lastSeen: number;
};

const connections = new Map<string, SshConnectionInfo>();
const lastSeen = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshotVersion = 0;

let storeFile: JsonFile | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let unlistenBackend: (() => void) | null = null;
let pagehideBound = false;

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function notify(): void {
  snapshotVersion++;
  for (const listener of listeners) listener();
}

function scheduleSave(): void {
  if (!storeFile) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSavedConnections(), SAVE_DELAY_MS);
}

async function flushSavedConnections(): Promise<void> {
  if (!storeFile) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const rows: SavedConnection[] = [...connections.values()]
    .map((c) => ({
      id: c.id,
      label: c.label,
      host: c.host,
      user: c.user,
      port: c.port,
      remoteHome: c.remoteHome,
      sshArgs: c.sshArgs,
      lastSeen: lastSeen.get(c.id) ?? 0,
    }))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, MAX_SAVED);
  await storeFile.set(KEY, rows).catch((error) => console.error("Could not save ssh-connections.json:", error));
}

function upsert(info: SshConnectionInfo, touch = true): SshConnectionInfo {
  const prev = connections.get(info.id);
  const merged: SshConnectionInfo = {
    ...info,
    remoteHome: info.remoteHome ?? prev?.remoteHome ?? null,
    remoteOs: info.remoteOs ?? prev?.remoteOs ?? null,
    remoteShell: info.remoteShell ?? prev?.remoteShell ?? null,
    sshArgs: info.sshArgs.length > 0 ? info.sshArgs : (prev?.sshArgs ?? []),
  };
  const changed =
    !prev ||
    prev.status !== merged.status ||
    prev.label !== merged.label ||
    prev.host !== merged.host ||
    prev.user !== merged.user ||
    prev.port !== merged.port ||
    prev.remoteHome !== merged.remoteHome ||
    prev.remoteOs !== merged.remoteOs ||
    prev.remoteShell !== merged.remoteShell ||
    !sameArgs(prev.sshArgs, merged.sshArgs);

  if (touch) lastSeen.set(merged.id, Date.now());
  if (!changed) return prev;

  connections.set(merged.id, merged);
  if (prev && prev.status !== "connected" && merged.status === "connected") {
    clearRepoRootCache(merged.id);
  }
  notify();
  scheduleSave();
  return merged;
}

function parseSaved(raw: unknown): SavedConnection[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedConnection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (
      typeof rec.id !== "string" ||
      !isValidRemoteId(rec.id) ||
      typeof rec.label !== "string" ||
      typeof rec.host !== "string" ||
      typeof rec.user !== "string" ||
      typeof rec.port !== "number"
    ) {
      continue;
    }
    const sshArgs = Array.isArray(rec.sshArgs)
      ? rec.sshArgs.filter((a): a is string => typeof a === "string")
      : [];
    out.push({
      id: rec.id,
      label: rec.label,
      host: rec.host,
      user: rec.user,
      port: rec.port,
      remoteHome: typeof rec.remoteHome === "string" ? rec.remoteHome : null,
      sshArgs,
      lastSeen: typeof rec.lastSeen === "number" ? rec.lastSeen : 0,
    });
  }
  return out;
}

/**
 * Loads persisted SSH connection metadata and subscribes to backend status
 * events. Call once during app startup before restoring panes.
 */
export async function loadSshConnections({ persist = true }: { persist?: boolean } = {}): Promise<void> {
  if (!unlistenBackend) {
    unlistenBackend = await onSshConnectionChanged((info) => {
      upsert(info, info.status === "connected");
    }).catch(() => null);
  }

  let openedStore: JsonFile | null = null;
  if (persist) {
    try {
      openedStore = await openJsonFile(FILE);
      const saved = parseSaved(await openedStore.get(KEY));
      await Promise.all(
        saved.map(async (item) => {
          lastSeen.set(item.id, item.lastSeen);
          try {
            const info = await restoreSshConnection({
              id: item.id,
              label: item.label,
              host: item.host,
              user: item.user,
              port: item.port,
              remoteHome: item.remoteHome,
              sshArgs: item.sshArgs,
            });
            upsert(info, false);
          } catch {
            // Invalid persisted entry (e.g. legacy unsafe sshArgs): still keep
            // display metadata with empty sshArgs so restored panes show the host label.
            try {
              const info = await restoreSshConnection({
                id: item.id,
                label: item.label,
                host: item.host,
                user: item.user,
                port: item.port,
                remoteHome: item.remoteHome,
                sshArgs: [],
              });
              upsert(info, false);
            } catch {
              // Ignore corrupt entry.
            }
          }
        }),
      );
    } catch (error) {
      console.error("Could not load ssh-connections.json:", error);
    }
  }

  try {
    const live = await listSshConnections();
    for (const info of live) upsert(info, false);
  } catch {
    // Ignore when backend is unavailable.
  }

  if (openedStore) {
    storeFile = openedStore;
    if (typeof window !== "undefined" && !pagehideBound) {
      pagehideBound = true;
      window.addEventListener("pagehide", () => void flushSavedConnections());
    }
  }
}

export async function registerConnection(reg: RegisterSshConnection): Promise<SshConnectionInfo> {
  const info = await registerSshConnection(reg);
  return upsert(info, true);
}

export function markTerminalEnded(remoteId: string): void {
  void sshConnectionEnded(remoteId).catch((error) => console.error("ssh_connection_ended failed:", error));
}

/** Updates locally-observed remote shell metadata (from OSC 6974 `meta=1`). */
export function updateConnectionMeta(
  remoteId: string,
  patch: { remoteHome?: string; remoteShell?: string },
): void {
  const prev = connections.get(remoteId);
  if (!prev) return;
  const next: SshConnectionInfo = {
    ...prev,
    remoteHome: patch.remoteHome ?? prev.remoteHome,
    remoteShell: patch.remoteShell ?? prev.remoteShell,
  };
  if (next.remoteHome !== prev.remoteHome || next.remoteShell !== prev.remoteShell) {
    connections.set(remoteId, next);
    notify();
    scheduleSave();
  }
}

/** Attempts non-interactive reconnect for `remoteId`, clearing caches on success. */
export async function reconnectConnection(remoteId: string): Promise<SshConnectionInfo> {
  const info = await reconnectSsh(remoteId);
  clearRepoRootCache(remoteId);
  return upsert(info, true);
}

export function getConnection(remoteId: string): SshConnectionInfo | undefined {
  return connections.get(remoteId);
}

export function listConnections(): SshConnectionInfo[] {
  return [...connections.values()];
}

export function subscribeConnections(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook subscribing to one remote connection's live info & status. */
export function useSshConnection(remoteId: string | null): SshConnectionInfo | undefined {
  return useSyncExternalStore(
    subscribeConnections,
    () => (remoteId ? connections.get(remoteId) : undefined),
  );
}

/** React hook subscribing to all known connections (for menus / pickers). */
export function useSshConnectionsVersion(): number {
  return useSyncExternalStore(subscribeConnections, () => snapshotVersion);
}

/** Friendly host label for a remote location, or `null` for local paths. */
export function hostLabelForLocation(location: string): string | null {
  const remoteId = remoteIdOf(location);
  if (!remoteId) return null;
  return connections.get(remoteId)?.label || fallbackHostLabel(remoteId);
}

/**
 * Home location matching `location`'s host:
 * - for a remote location, `ssh://<id><remoteHome>` when known, else `undefined`
 * - for a local path, `localHome`
 */
export function homeForLocation(location: string, localHome: string | undefined): string | undefined {
  const remoteId = remoteIdOf(location);
  if (!remoteId) return localHome;
  const remoteHome = connections.get(remoteId)?.remoteHome;
  return remoteHome ? formatRemoteLocation(remoteId, remoteHome) : undefined;
}

/**
 * Formats a local or remote location for display: shortens the matching host's
 * home directory to `~`, never shows `ssh://<id>`, and optionally prefixes
 * `<host>:` for remote locations.
 */
export function displayLocation(
  location: string,
  localHome: string | undefined,
  { includeHost = false }: { includeHost?: boolean } = {},
): string {
  const parsed = parseLocation(location);
  if (!parsed) return location;
  const home = homeForLocation(location, localHome);
  const shown = displayPath(location, home);
  if (parsed.kind === "remote" && includeHost) {
    const label = hostLabelForLocation(location) ?? fallbackHostLabel(parsed.remoteId);
    return `${label}:${shown}`;
  }
  return shown;
}

/** Test-only helper to reset the in-memory registry between unit tests. */
export function _resetConnectionsForTests(): void {
  connections.clear();
  lastSeen.clear();
  listeners.clear();
  storeFile = null;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  snapshotVersion = 0;
}
