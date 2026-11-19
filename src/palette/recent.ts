import { onCommandRun, recentCommandIds, seedRecentCommands } from "../commands/registry";
import { type JsonFile, openJsonFile } from "../ipc/jsonFile";

/*
 * Recently opened files and recently run commands, for the palette, saved
 * to `recent.json`. A leaf module, so `openFile` can record files without
 * pulling in the palette.
 */

const RECENT_FILE = "recent.json";
const RECENT_FILES_LIMIT = 50;
let recentFiles: string[] = [];
let file: JsonFile | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Absolute paths, most recently opened first. */
export function recentFilePaths(): readonly string[] {
  return recentFiles;
}

export function noteRecentFile(path: string): void {
  recentFiles = [path, ...recentFiles.filter((other) => other !== path)].slice(0, RECENT_FILES_LIMIT);
  scheduleSave();
}

function scheduleSave(): void {
  if (!file) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void file
      ?.set("recent", { files: recentFiles, commands: recentCommandIds() })
      .catch((error) => console.error("Could not save recent items:", error));
  }, 500);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Loads the recent lists and starts saving them. */
export async function loadRecent({ persist }: { persist: boolean }): Promise<void> {
  onCommandRun(scheduleSave);
  if (!persist) return;
  try {
    file = await openJsonFile(RECENT_FILE);
    const saved = (await file.get<{ files?: unknown; commands?: unknown }>("recent")) ?? {};
    recentFiles = strings(saved.files).slice(0, RECENT_FILES_LIMIT);
    seedRecentCommands(strings(saved.commands));
  } catch (error) {
    console.error("Could not load recent items:", error);
  }
}
