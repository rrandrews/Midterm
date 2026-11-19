import { findFiles, gitStatus } from "../ipc/fs";
import { homeDirectory } from "../ipc/system";
import { getDock } from "../layout/dock";
import { listPanes } from "../state/layout";
import { selectActiveTab, useAppStore } from "../state/store";
import { directoryOf } from "../plugins/panes";

/*
 * Where the palette's lists come from: the project root of the active tab,
 * the files under it (cached briefly), and recently used commands and files
 * (saved to `recent.json`).
 */

/** The active pane's directory, else the first directory any pane in the active tab is in. */
export function activeDirectory(): string | undefined {
  const tab = selectActiveTab(useAppStore.getState());
  const panes = listPanes(getDock(tab)?.getModel() ?? tab.layout);
  const active = panes.find((pane) => pane.id === tab.activePaneId);
  for (const pane of active ? [active, ...panes] : panes) {
    const dir = directoryOf(pane);
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

export { loadRecent, noteRecentFile, recentFilePaths } from "./recent";
