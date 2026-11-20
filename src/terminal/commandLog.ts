import type { CommandPair } from "../ai/predict";
import { type JsonFile, openJsonFile } from "../ipc/jsonFile";

/*
 * Which command followed which: pairs of (command, next command run in the
 * same terminal), oldest first, saved to `command-log.json` in the app data
 * directory. Local next-command prediction (src/ai/predict.ts) learns from
 * it. Like the global history, only this machine's shells feed it.
 */

const FILE = "command-log.json";
const KEY = "pairs";
export const MAX_PAIRS = 5000;

let pairs: CommandPair[] = [];
let file: Promise<JsonFile | null> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function isPair(value: unknown): value is CommandPair {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string" &&
    value[0] !== "" &&
    value[1] !== ""
  );
}

function open(): Promise<JsonFile | null> {
  file ??= openJsonFile(FILE)
    .then(async (opened) => {
      const saved = await opened.get<unknown>(KEY);
      if (Array.isArray(saved)) {
        // Pairs recorded before the file was read come last (most recent).
        pairs = [...saved.filter(isPair), ...pairs].slice(-MAX_PAIRS);
      }
      return opened;
    })
    .catch((error: unknown) => {
      console.error("Could not load the command log:", error);
      return null;
    });
  return file;
}

/** Starts loading the saved log (idempotent). */
export function loadCommandLog(): Promise<void> {
  return open().then(() => {});
}

/** The logged pairs, oldest first. */
export function commandPairs(): readonly CommandPair[] {
  return pairs;
}

/** Notes that `next` was run right after `previous` in the same terminal, and saves soon. */
export function recordPair(previous: string | undefined, next: string): void {
  const prev = previous?.trim();
  const command = next.trim();
  if (!prev || !command) return;
  pairs = [...pairs, [prev, command] as const].slice(-MAX_PAIRS);
  // Commands can come in quick bursts: save once they settle.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void open().then((opened) =>
      opened?.set(KEY, pairs).catch((error: unknown) => console.error("Could not save the command log:", error)),
    );
  }, 1000);
}
