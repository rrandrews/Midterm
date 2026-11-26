import fuzzysort from "fuzzysort";
import { baseName, isWithin, joinPath as joinLocation, parentPath, relativePath } from "../explorer/tree";
import {
  fallbackHostLabel,
  isAbsoluteLocation,
  isRemotePath,
  isRootLocation,
  parseLocation,
} from "../files/location";

/*
 * What the command palette lists for a query. Pure: the palette component
 * gathers the sources (commands, tabs, files, recent lists) and carries out
 * the chosen item's action.
 *
 * Query syntax:
 *   (plain)   everything: commands, tabs, workspaces, files, and "run"
 *   > text    commands only
 *   $ text    run `text` in a new terminal
 *
 * With an empty query the palette shows recent commands and files first.
 * Matches that were used recently get a small boost.
 */

export type PaletteMode = "all" | "files";

export type PaletteAction =
  | { kind: "command"; id: string }
  | { kind: "tab"; tabId: string; workspaceId: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "file"; path: string }
  | { kind: "run"; command: string };

export type PaletteGroup = "Recent" | "Commands" | "Tabs" | "Workspaces" | "Files" | "Run";

export type PaletteItem = {
  /** Unique within one result list. */
  key: string;
  group: PaletteGroup;
  title: string;
  /** Character indexes of `title` that matched the query. */
  highlight: readonly number[];
  /** Secondary text: a category, a directory, a workspace name. */
  detail?: string;
  shortcut?: string;
  icon: "command" | "tab" | "workspace" | "file" | "run";
  action: PaletteAction;
};

export type CommandSource = { id: string; title: string; category: string; shortcut?: string };
export type TabSource = { id: string; title: string; workspaceId: string; workspaceName: string; active: boolean };
export type WorkspaceSource = { id: string; name: string; tabCount: number; active: boolean };

export type PaletteSources = {
  commands: CommandSource[];
  tabs: TabSource[];
  workspaces: WorkspaceSource[];
  /** Directory file paths are relative to; `undefined` when unknown. */
  root?: string;
  /** Paths relative to `root`. */
  files: string[];
  /** Command ids, most recent first. */
  recentCommands: readonly string[];
  /** Absolute paths (local or `ssh://<id>/...`), most recent first. */
  recentFiles: readonly string[];
  /** Optional formatter for parent directory labels outside `root` (e.g. shortening home / host label). */
  formatDir?: (dir: string) => string;
};

export const GROUP_LIMIT = 8;
export const FILE_LIMIT = 30;
const RECENT_SHOWN = 5;
const RECENT_BONUS = 0.15;

export type ParsedQuery = { scope: "all" | "commands" | "run"; text: string };

export function parseQuery(query: string): ParsedQuery {
  if (query.startsWith(">")) return { scope: "commands", text: query.slice(1).trim() };
  if (query.startsWith("$")) return { scope: "run", text: query.slice(1).trim() };
  return { scope: "all", text: query.trim() };
}

const relativeDirName = (path: string) => {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
};

function defaultFormatDir(dir: string): string {
  const parsed = parseLocation(dir);
  if (parsed?.kind === "remote") return `${fallbackHostLabel(parsed.remoteId)}:${parsed.path}`;
  return dir;
}

/** `path` relative to `root` if inside it, else as is (home abbreviated by the caller if wanted). */
export function relativeTo(root: string | undefined, path: string): string {
  if (root && isWithin(path, root)) {
    const rel = relativePath(path, root);
    if (rel) return rel;
  }
  return path;
}

function joinPath(root: string | undefined, relative: string): string {
  if (!root) return relative;
  return joinLocation(root, relative);
}

/** A bonus for recently used things: the most recent gets the full bonus. */
function recencyBonus(index: number): number {
  return index === -1 ? 0 : RECENT_BONUS * (1 - index / 20);
}

function commandItem(command: CommandSource, highlight: readonly number[], group: PaletteGroup = "Commands"): PaletteItem {
  return {
    key: `command:${command.id}`,
    group,
    title: command.title,
    highlight,
    detail: command.category,
    shortcut: command.shortcut,
    icon: "command",
    action: { kind: "command", id: command.id },
  };
}

function fileItem(
  root: string | undefined,
  path: string,
  highlight: readonly number[],
  group: PaletteGroup = "Files",
  formatDir: (dir: string) => string = defaultFormatDir,
): PaletteItem {
  let detail: string | undefined;
  if (root && isWithin(path, root)) {
    detail = relativeDirName(relativePath(path, root)) || undefined;
  } else if (isAbsoluteLocation(path)) {
    const parent = parentPath(path);
    if (!isRootLocation(parent) || isRemotePath(path)) detail = formatDir(parent);
  } else {
    detail = relativeDirName(path) || undefined;
  }
  return {
    key: `file:${path}`,
    group,
    title: baseName(path),
    highlight,
    detail,
    icon: "file",
    action: { kind: "file", path },
  };
}

function runItem(command: string): PaletteItem {
  return {
    key: "run",
    group: "Run",
    title: `Run “${command}” in a new terminal`,
    highlight: [],
    icon: "run",
    action: { kind: "run", command },
  };
}

type Scored = { item: PaletteItem; score: number };

/** The palette's items for a query, grouped, best group first ("Run" last). */
export function paletteItems(query: string, mode: PaletteMode, sources: PaletteSources): PaletteItem[] {
  const { scope, text } = parseQuery(query);
  if (scope === "run") return text ? [runItem(text)] : [];

  const commandsById = new Map(sources.commands.map((command) => [command.id, command]));
  const showCommands = scope === "commands" || mode === "all";
  const showOthers = scope === "all";
  const showTabs = showOthers && mode === "all";

  if (!text) {
    const items: PaletteItem[] = [];
    if (showCommands) {
      const recent = sources.recentCommands
        .map((id) => commandsById.get(id))
        .filter((command): command is CommandSource => command !== undefined)
        .slice(0, RECENT_SHOWN);
      items.push(...recent.map((command) => commandItem(command, [], "Recent")));
    }
    if (showOthers) {
      items.push(
        ...sources.recentFiles.slice(0, mode === "files" ? GROUP_LIMIT * 2 : RECENT_SHOWN).map((path) =>
          fileItem(sources.root, path, [], "Recent", sources.formatDir),
        ),
      );
    }
    if (showCommands) {
      const shown = new Set(items.map((item) => item.key));
      items.push(
        ...sources.commands
          .map((command) => commandItem(command, []))
          .filter((item) => !shown.has(item.key)),
      );
    }
    return items;
  }

  const groups: Scored[][] = [];

  if (showCommands) {
    const results = fuzzysort.go(text, sources.commands, {
      keys: ["title", "category"],
      limit: scope === "commands" ? 0 : GROUP_LIMIT,
      threshold: 0.3,
      scoreFn: (result) =>
        Math.max(result[0]?.score ?? 0, (result[1]?.score ?? 0) * 0.8) +
        recencyBonus(sources.recentCommands.indexOf(result.obj.id)),
    });
    groups.push(results.map((result) => ({ item: commandItem(result.obj, result[0]?.indexes ?? []), score: result.score })));
  }

  if (showTabs) {
    const tabs = fuzzysort.go(text, sources.tabs, { key: "title", limit: GROUP_LIMIT, threshold: 0.3 });
    groups.push(
      tabs.map((result) => ({
        score: result.score,
        item: {
          key: `tab:${result.obj.id}`,
          group: "Tabs",
          title: result.obj.title,
          highlight: result.indexes,
          detail: result.obj.workspaceName,
          icon: "tab",
          action: { kind: "tab", tabId: result.obj.id, workspaceId: result.obj.workspaceId },
        },
      })),
    );
    const workspaces = fuzzysort.go(text, sources.workspaces, { key: "name", limit: GROUP_LIMIT, threshold: 0.3 });
    groups.push(
      workspaces.map((result) => ({
        score: result.score,
        item: {
          key: `workspace:${result.obj.id}`,
          group: "Workspaces",
          title: result.obj.name,
          highlight: result.indexes,
          detail: `${result.obj.tabCount} ${result.obj.tabCount === 1 ? "tab" : "tabs"}`,
          icon: "workspace",
          action: { kind: "workspace", workspaceId: result.obj.id },
        },
      })),
    );
  }

  if (showOthers) {
    const known = new Set(sources.files);
    const extraRecent = sources.recentFiles
      .map((path) => relativeTo(sources.root, path))
      .filter((path) => !known.has(path));
    const candidates = [...sources.files, ...extraRecent].map((path) => ({ path, base: baseName(path) }));
    const recentRelative = sources.recentFiles.map((path) => relativeTo(sources.root, path));
    const files = fuzzysort.go(text, candidates, {
      keys: ["base", "path"],
      limit: FILE_LIMIT,
      threshold: 0.2,
      // A match in the file name beats one spread over the directories.
      scoreFn: (result) =>
        Math.max((result[0]?.score ?? 0) * 1.1, result[1]?.score ?? 0) +
        recencyBonus(recentRelative.indexOf(result.obj.path)),
    });
    groups.push(
      files.map((result) => {
        const path = isAbsoluteLocation(result.obj.path)
          ? result.obj.path
          : joinPath(sources.root, result.obj.path);
        return { item: fileItem(sources.root, path, result[0]?.indexes ?? [], "Files", sources.formatDir), score: result.score };
      }),
    );
  }

  const ordered = groups
    .filter((group) => group.length > 0)
    .sort((a, b) => b[0].score - a[0].score)
    .flatMap((group) => group.map((scored) => scored.item));
  if (scope === "all" && mode === "all") ordered.push(runItem(text));
  return ordered;
}
