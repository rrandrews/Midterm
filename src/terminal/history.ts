import { type JsonFile, openJsonFile } from "../ipc/jsonFile";

/*
 * Command history for the blocks input editor: each pane's own commands
 * (kept by its BlockTracker) in front of a global list shared by all panes
 * and saved to `history.json` in the app data directory.
 */

const FILE = "history.json";
const KEY = "commands";
export const MAX_GLOBAL_HISTORY = 1000;

/** `list` with `command` moved (or added) to the end, capped at `max` entries. */
export function addToHistory(list: readonly string[], command: string, max: number): string[] {
  const next = list.filter((entry) => entry !== command);
  next.push(command);
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Entries for walking with ↑/↓, most recent first, without duplicates:
 * the pane's commands, then the global ones. Both lists are oldest first.
 */
export function historyEntries(pane: readonly string[], global: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [pane, global]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

/** The most recent entry that starts with `prefix` and is longer than it. */
export function suggestion(entries: readonly string[], prefix: string): string | undefined {
  if (!prefix.trim()) return undefined;
  return entries.find((entry) => entry.length > prefix.length && entry.startsWith(prefix));
}

let global: string[] = [];
let file: Promise<JsonFile | null> | null = null;

function open(): Promise<JsonFile | null> {
  file ??= openJsonFile(FILE)
    .then(async (opened) => {
      const saved = await opened.get<unknown>(KEY);
      if (Array.isArray(saved)) {
        const loaded = saved.filter((entry): entry is string => typeof entry === "string" && entry !== "");
        // Commands run before the file was read come last (most recent).
        global = [...loaded, ...global.filter((entry) => !loaded.includes(entry))].slice(-MAX_GLOBAL_HISTORY);
      }
      return opened;
    })
    .catch((error: unknown) => {
      console.error("Could not load the command history:", error);
      return null;
    });
  return file;
}

/** Starts loading the saved history (idempotent). */
export function loadGlobalHistory(): Promise<void> {
  return open().then(() => {});
}

/** The global history, oldest first. */
export function globalHistory(): readonly string[] {
  return global;
}

/** Adds a command to the global history and saves it. */
export function recordCommand(command: string): void {
  if (!command.trim()) return;
  global = addToHistory(global, command, MAX_GLOBAL_HISTORY);
  void open().then((opened) =>
    opened?.set(KEY, global).catch((error: unknown) => console.error("Could not save the command history:", error)),
  );
}
