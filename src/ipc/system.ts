import { invoke, isTauri } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { MOCK_HOME } from "./fsMock";

let hostname: string | null | undefined;

/**
 * This machine's host name, as shells report it in OSC 7, lowercased.
 * `undefined` until known, `null` if it could not be read.
 */
export function localHostname(): string | null | undefined {
  return hostname;
}

/** Looks the host name up once, at startup. */
export async function loadLocalHostname(): Promise<void> {
  if (!isTauri()) {
    hostname = null;
    return;
  }
  hostname = await invoke<string | null>("local_hostname").then(
    (name) => name?.toLowerCase() ?? null,
    (error: unknown) => {
      console.warn("Could not read the host name:", error);
      return null;
    },
  );
}

let home: string | undefined;

/** The user's home directory, without a trailing slash; `undefined` until loaded or if unreadable. */
export function homeDirectory(): string | undefined {
  return home;
}

/** Looks the home directory up once, at startup. */
export async function loadHomeDirectory(): Promise<void> {
  if (!isTauri()) {
    home = MOCK_HOME;
    return;
  }
  home = await homeDir().then(
    (dir) => dir.replace(/(.)\/+$/, "$1"),
    (error: unknown) => {
      console.warn("Could not read the home directory:", error);
      return undefined;
    },
  );
}
