import { isTauri } from "@tauri-apps/api/core";
import { type Store, load } from "@tauri-apps/plugin-store";

/*
 * A JSON file in the app's data directory (tauri-plugin-store). Writes land
 * in the backend's copy at once; the file itself is written shortly after,
 * and again when the app exits. In a plain browser (`bun run dev` without
 * Tauri) nothing is persisted.
 */

export type JsonFile = {
  get: <T>(key: string) => Promise<T | undefined>;
  set: (key: string, value: unknown) => Promise<void>;
};

const NOOP: JsonFile = { get: async () => undefined, set: async () => {} };

export async function openJsonFile(name: string): Promise<JsonFile> {
  if (!isTauri()) return NOOP;
  const store: Store = await load(name, { autoSave: 400, defaults: {} });
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
  };
}
