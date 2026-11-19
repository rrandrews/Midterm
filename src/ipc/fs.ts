import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import * as mock from "./fsMock";

/*
 * Typed wrapper around the Rust file-system and git commands
 * (src-tauri/src/fs). All paths are absolute. Outside Tauri (`bun run dev`
 * in a browser) the calls go to a small in-memory tree (`fsMock.ts`) so the
 * explorer can be worked on there.
 */

export type FsEntry = {
  name: string;
  /** Absolute path. */
  path: string;
  /** A symlink is reported as what it points to; a broken one as a file. */
  kind: "file" | "dir";
  symlink: boolean;
  /** The name starts with a dot. */
  hidden: boolean;
  /**
   * Excluded by .gitignore, .ignore, the repo's info/exclude or the global
   * excludes file. Always `false` from `stat`.
   */
  ignored: boolean;
};

export type ListOptions = {
  /** Also list dotfiles and ignored entries (flagged as such). */
  showHidden: boolean;
};

/**
 * Status of a path relative to HEAD and the index, one letter as in the
 * mockup: modified, added (staged new file), deleted, renamed, untracked,
 * conflicted.
 */
export type GitCode = "M" | "A" | "D" | "R" | "U" | "C";

export type GitStatus = {
  /** Root of the work tree, absolute. */
  root: string;
  /** Current branch (also before the first commit), or `null` when detached. */
  branch: string | null;
  /** Paths relative to `root`, `/`-separated, files only. */
  entries: Record<string, GitCode>;
};

/** Directories whose listings may have changed. */
export type WatchEvent = { dirs: string[] };

export type Watcher = {
  /** Replaces the set of watched directories (each watched non-recursively). */
  setDirs: (dirs: string[]) => void;
  stop: () => void;
};

/**
 * A directory's entries, directories first, then by name (case-insensitive).
 * Without `showHidden`, dotfiles and ignored entries are left out. Rejects if
 * the path is not a readable directory.
 */
export function listDir(path: string, options: ListOptions): Promise<FsEntry[]> {
  if (!isTauri()) return mock.listDir(path, options);
  return invoke<FsEntry[]>("fs_list_dir", { path, showHidden: options.showHidden });
}

/** One path's entry, or `null` if it does not exist. */
export function stat(path: string): Promise<FsEntry | null> {
  if (!isTauri()) return mock.stat(path);
  return invoke<FsEntry | null>("fs_stat", { path });
}

/** Creates an empty file or a directory. Rejects if something is already there. */
export function create(path: string, kind: "file" | "dir"): Promise<void> {
  if (!isTauri()) return mock.create(path, kind);
  return invoke("fs_create", { path, dir: kind === "dir" });
}

/** Renames or moves. Rejects if the destination exists. */
export function rename(from: string, to: string): Promise<void> {
  if (!isTauri()) return mock.rename(from, to);
  return invoke("fs_rename", { from, to });
}

/** Moves paths to the system trash. */
export function trash(paths: string[]): Promise<void> {
  if (!isTauri()) return mock.trash(paths);
  return invoke("fs_trash", { paths });
}

/** Git status of the work tree containing `path`, or `null` if it is not in one. */
export function gitStatus(path: string): Promise<GitStatus | null> {
  if (!isTauri()) return mock.gitStatus(path);
  return invoke<GitStatus | null>("git_status", { path });
}

/**
 * Watches directories for changes, reporting them debounced (about 150 ms).
 * A change inside a work tree's `.git` directory is reported as that `.git`
 * directory, if it is watched.
 */
export async function watch(onEvent: (event: WatchEvent) => void): Promise<Watcher> {
  if (!isTauri()) return mock.watch(onEvent);
  const channel = new Channel<WatchEvent>();
  channel.onmessage = onEvent;
  const id = await invoke<number>("fs_watch_start", { onEvent: channel });
  const fail = (command: string) => (error: unknown) => console.error(`${command} failed:`, error);
  return {
    setDirs: (dirs) => void invoke("fs_watch_set", { id, dirs }).catch(fail("fs_watch_set")),
    stop: () => void invoke("fs_watch_stop", { id }).catch(fail("fs_watch_stop")),
  };
}
