import { onCommandRun, recentCommandIds, seedRecentCommands } from "../commands/registry";
import { findFiles, gitStatus } from "../ipc/fs";
import { type JsonFile, openJsonFile } from "../ipc/jsonFile";
import { homeDirectory } from "../ipc/system";
import { getDock } from "../layout/dock";
import { listPanes } from "../state/layout";
import { selectActiveTab, useAppStore } from "../state/store";
import type { PaneNode } from "../state/types";
import { peekSession } from "../terminal/sessions";

/*
 * Where the palette's lists come from: the project root of the active tab,
 * the files under it (cached briefly), and recently used commands and files
 * (saved to `recent.json`).
 */

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/** The directory a pane is "in": a terminal's cwd, an explorer's root, a file's folder. */
export function directoryOfPane(pane: PaneNode): string | undefined {
  switch (pane.data.kind) {
    case "terminal":
      return peekSession(pane.id)?.cwd ?? pane.data.cwd;
    case "explorer":
      return pane.data.root;
    default:
      return pane.data.path ? parentOf(pane.data.path) : undefined;
  }
}

/** The active pane's directory, else the first directory any pane in the active tab is in. */
export function activeDirectory(): string | undefined {
  const tab = selectActiveTab(useAppStore.getState());
  const panes = listPanes(getDock(tab)?.getModel() ?? tab.layout);
  const active = panes.find((pane) => pane.id === tab.activePaneId);
  for (const pane of active ? [active, ...panes] : panes) {
    const dir = directoryOfPane(pane);
    if (dir) return dir;
  }
  return undefined;
}

/**
 * The root for fuzzy file open: the work tree containing the active
 * directory, else that directory. `undefined` when there is nothing better
 * than the home directory (walking all of it would be slow and noisy).
 */
export async function projectRoot(): Promise<string | undefined> {
  const dir = activeDirectory();
  if (!dir) return undefined;
  const git = await gitStatus(dir).catch(() => null);
  const root = git?.root ?? dir;
  return root === homeDirectory() || root === "/" ? undefined : root;
}

const FILE_LIMIT = 50_000;
const FILE_CACHE_MS = 15_000;

type Listing = { root: string; at: number; files: Promise<string[]> };
let listing: Listing | null = null;

/** Files under `root`, from a listing made in the last few seconds if there is one. */
export function filesUnder(root: string): Promise<string[]> {
  if (listing && listing.root === root && performance.now() - listing.at < FILE_CACHE_MS) return listing.files;
  const files = findFiles(root, FILE_LIMIT).then(
    (found) => found.paths,
    (error: unknown) => {
      console.warn("Listing files for the palette failed:", error);
      return [];
    },
  );
  listing = { root, at: performance.now(), files };
  return files;
}

/* Recent files and commands. */

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
