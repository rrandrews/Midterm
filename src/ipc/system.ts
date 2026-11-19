import { invoke, isTauri } from "@tauri-apps/api/core";

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
