import { invoke, isTauri } from "@tauri-apps/api/core";
import * as mock from "./fsMock";

/*
 * Listings for tab completion in the blocks input editor
 * (src-tauri/src/fs/complete.rs). Outside Tauri they come from the
 * in-memory tree in `fsMock.ts` and a few made-up commands.
 */

/** A directory entry for completion; symlinks count as what they point to. */
export type CompletionEntry = { name: string; dir: boolean; executable: boolean };

const MOCK_COMMANDS = ["bun", "cargo", "cat", "cd", "git", "grep", "ls", "make", "npm", "vim"];

/**
 * The executable names on `path` (a `PATH` value, `:`-separated), sorted and
 * deduplicated. Without `path`, the app's own `PATH` is used.
 */
export function pathCommands(path: string | undefined): Promise<string[]> {
  if (!isTauri()) return Promise.resolve(MOCK_COMMANDS);
  return invoke<string[]>("fs_path_commands", { path: path ?? null });
}

/** Every entry of `dir`, dotfiles included. Rejects if it is not a readable directory. */
export async function completeList(dir: string): Promise<CompletionEntry[]> {
  if (!isTauri()) {
    const entries = await mock.listDir(dir, { showHidden: true });
    return entries.map((entry) => ({ name: entry.name, dir: entry.kind === "dir", executable: false }));
  }
  return invoke<CompletionEntry[]>("fs_complete_list", { dir });
}
