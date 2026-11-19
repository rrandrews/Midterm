import { type JsonFile, openJsonFile } from "../ipc/jsonFile";
import { restoreState, snapshotState } from "./persist";
import { useAppStore } from "./store";

/*
 * Keeps the app state on disk: restored once at startup, before anything
 * renders (so terminals spawn in their saved directories), then saved after
 * each burst of changes.
 */

const FILE = "state.json";
const KEY = "app";
const SAVE_DELAY_MS = 300;

let file: JsonFile | null = null;
/** Saves now if a save is pending; set while saving is running. */
let flushPending: (() => Promise<void>) | null = null;

/** Writes any pending change to the backend now, e.g. before quitting. */
export async function flushSavedState(): Promise<void> {
  await flushPending?.();
}

/** Loads the saved state into the store. Never throws: a bad file means a fresh start. */
export async function restoreSavedState(): Promise<void> {
  try {
    file = await openJsonFile(FILE);
    const restored = restoreState(await file.get(KEY));
    if (restored) useAppStore.setState(restored);
  } catch (error) {
    console.error("Could not restore the saved state:", error);
  }
}

/** Saves the state whenever it changes (debounced). Returns a function that stops. */
export function startSaving(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSaved: string | undefined;

  const save = async () => {
    timer = undefined;
    if (!file) return;
    const snapshot = snapshotState(useAppStore.getState());
    // Most store changes (focus, activity dots) do not touch saved fields.
    const json = JSON.stringify(snapshot);
    if (json === lastSaved) return;
    lastSaved = json;
    await file.set(KEY, snapshot).catch((error) => console.error("Could not save the state:", error));
  };
  flushPending = async () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    await save();
  };

  const unsubscribe = useAppStore.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_DELAY_MS);
  });
  // Last chance when the page goes away (window closing, reload).
  const flush = () => void flushPending?.();
  window.addEventListener("pagehide", flush);
  return () => {
    unsubscribe();
    window.removeEventListener("pagehide", flush);
    flush();
    flushPending = null;
  };
}
