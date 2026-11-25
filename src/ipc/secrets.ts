import { invoke, isTauri } from "@tauri-apps/api/core";

/*
 * Workspace secrets: environment variables whose values live in the OS
 * credential store (src-tauri/src/secrets.rs). The webview can store a
 * value, delete it and ask whether one is set, but a value never comes back:
 * the backend reads it itself when it spawns a shell (`PtyOptions.secrets`).
 * Whoever shows a secret in the UI shows "set" or "not set", nothing more.
 *
 * In a plain browser (`bun run dev`, no Tauri) the values are kept in memory
 * for the life of the page, so the UI can be worked on.
 */

/**
 * The account of the secret `name` in `scope` (`default`, or a workspace id).
 * The backend only accepts accounts that start with `secret/`.
 */
export function secretAccount(scope: string, name: string): string {
  return `secret/${scope}/${name}`;
}

/** Browser fallback: account -> value. */
const memory = new Map<string, string>();

/** Stores `value` (surrounding whitespace is trimmed; empty is an error). */
export async function setSecret(account: string, value: string): Promise<void> {
  if (isTauri()) return invoke("secret_set", { account, value });
  if (!value.trim()) throw "the secret is empty";
  memory.set(account, value.trim());
}

/** Deletes a secret; one that is not set is not an error. */
export async function deleteSecret(account: string): Promise<void> {
  if (isTauri()) return invoke("secret_delete", { account });
  memory.delete(account);
}

/** Whether each account has a value, in the order given. */
export async function secretStatus(accounts: string[]): Promise<boolean[]> {
  if (isTauri()) return invoke<boolean[]>("secret_status", { accounts });
  return accounts.map((account) => memory.has(account));
}

/**
 * Reads the accounts into the backend's cache, so that a `spawnPty` right
 * after does not block on a Keychain prompt. Never rejects.
 */
export async function warmSecrets(accounts: string[]): Promise<void> {
  if (!isTauri() || accounts.length === 0) return;
  try {
    await invoke("secrets_warm", { accounts });
  } catch (error) {
    console.error("secrets_warm failed:", error);
  }
}
