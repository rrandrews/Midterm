import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import * as mock from "./fsMock";

/*
 * Typed wrapper around the Rust file, file-system and git commands
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

export type FoundFiles = {
  /** `/`-separated paths relative to the root. */
  paths: string[];
  /** There were more than `limit` files. */
  truncated: boolean;
};

/**
 * Every file under `root` (no directories), skipping hidden entries and
 * those excluded by ignore rules, up to `limit`.
 */
export function findFiles(root: string, limit: number): Promise<FoundFiles> {
  if (!isTauri()) return mock.findFiles(root, limit);
  return invoke<FoundFiles>("fs_find_files", { root, limit });
}

export type FoundEntry = {
  /** `/`-separated, relative to the root. */
  path: string;
  dir: boolean;
};

export type FoundEntries = { entries: FoundEntry[]; truncated: boolean };

/**
 * Files AND directories under `root` (not `root` itself). Without
 * `showHidden`, hidden and ignored entries are skipped (same rules as
 * `findFiles` / `listDir`); with it, everything is included except the
 * contents of `.git` directories. Symlinks are not followed (a symlink is
 * reported with its target's kind). Stops after `limit` entries.
 */
export function findEntries(root: string, options: { limit: number; showHidden: boolean }): Promise<FoundEntries> {
  if (!isTauri()) return mock.findEntries(root, options);
  return invoke<FoundEntries>("fs_find_entries", { root, limit: options.limit, showHidden: options.showHidden });
}

/**
 * Copies a file or directory (recursively) into the directory `toDir`, never replacing anything:
 * on a name clash the copy is named as Finder does ("a copy.txt", then "a copy 2.txt", …; "dir copy").
 * Resolves to the new absolute path. Rejects if `from` is a directory and `toDir` is it or inside it.
 */
export function copyInto(from: string, toDir: string): Promise<string> {
  if (!isTauri()) return mock.copyInto(from, toDir);
  return invoke<string>("fs_copy", { from, toDir });
}

export type TextSearchOptions = {
  /** Literal unless `regex`. */
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Same meaning as for `findEntries`. */
  showHidden: boolean;
  /** Total matching lines across files; the search stops after (`truncated: true`). */
  maxResults: number;
};

export type TextMatch = {
  /** 1-based line number. */
  line: number;
  /** 1-based column (UTF-16 code units) of the first match in the full line, for opening the file there. */
  column: number;
  /** The line (no trailing newline), or for lines over ~300 chars a window around the first match with "…" where cut. */
  text: string;
  /** Matches within `text`, as [start, end) UTF-16 offsets (JS string indices). */
  ranges: [number, number][];
};

export type TextSearchFile = {
  /** Relative to the root, `/`-separated. */
  path: string;
  matches: TextMatch[];
};

export type TextSearchEvent =
  /** A batch; each file appears in exactly one batch with all its matches. */
  | { type: "files"; files: TextSearchFile[] }
  | { type: "done"; truncated: boolean; cancelled: boolean; filesSearched: number }
  /** E.g. an invalid regex. No "done" follows. */
  | { type: "error"; message: string };

export type TextSearch = { cancel: () => void };

/**
 * Searches text files under `root`, streaming results to `onEvent`. Binary files are skipped
 * (stop at first NUL), as are files over 8 MiB. Resolves once the search has started.
 */
export async function searchText(
  root: string,
  options: TextSearchOptions,
  onEvent: (event: TextSearchEvent) => void,
): Promise<TextSearch> {
  if (!isTauri()) return mock.searchText(root, options, onEvent);
  const channel = new Channel<TextSearchEvent>();
  channel.onmessage = onEvent;
  const id = await invoke<number>("fs_search_text", { root, options, onEvent: channel });
  return {
    cancel: () =>
      void invoke("fs_search_cancel", { id }).catch((error: unknown) =>
        console.error("fs_search_cancel failed:", error),
      ),
  };
}

/**
 * What change detection compares: modification time (nanoseconds since the
 * epoch, as a decimal string so it survives JSON exactly) and size.
 */
export type FileVersion = { mtime: string; size: number };

export function sameVersion(a: FileVersion | null, b: FileVersion | null): boolean {
  return a === b || (a !== null && b !== null && a.mtime === b.mtime && a.size === b.size);
}

/** A file read as text, or why it cannot be (binary, or over the backend's 16 MiB limit). */
export type TextFile =
  | { kind: "text"; text: string; version: FileVersion }
  | { kind: "binary"; version: FileVersion }
  | { kind: "tooLarge"; version: FileVersion };

/** What a write expects on disk: the file at a version, no file, or anything. */
export type WriteExpect = { kind: "version"; version: FileVersion } | { kind: "absent" } | { kind: "any" };

/**
 * The outcome of a write: written, or refused because what is on disk does
 * not match the expectation (`current` is `null` if there is no file).
 */
export type WriteResult =
  | { kind: "written"; version: FileVersion }
  | { kind: "conflict"; current: FileVersion | null };

/** Reads a file as UTF-8 text. Rejects if it cannot be read. */
export function readTextFile(path: string): Promise<TextFile> {
  if (!isTauri()) return mock.readTextFile(path);
  return invoke<TextFile>("fs_read_text", { path });
}

/** A file's raw bytes (up to 64 MiB). */
export function readFileBytes(path: string): Promise<ArrayBuffer> {
  if (!isTauri()) return mock.readFileBytes(path);
  return invoke<ArrayBuffer>("fs_read_bytes", { path });
}

/**
 * Writes text to a file atomically, creating it if missing, if what is on
 * disk matches `expect`; otherwise nothing is written.
 */
export function writeTextFile(path: string, text: string, expect: WriteExpect): Promise<WriteResult> {
  if (!isTauri()) return mock.writeTextFile(path, text, expect);
  return invoke<WriteResult>("fs_write_text", { path, text, expect });
}

/** A file's version, or `null` if no file is there. */
export function fileVersion(path: string): Promise<FileVersion | null> {
  if (!isTauri()) return mock.fileVersion(path);
  return invoke<FileVersion | null>("fs_file_version", { path });
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
