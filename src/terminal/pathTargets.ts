import { openDirectory, openFile } from "../actions";
import { copyText } from "../ipc/clipboard";
import * as fs from "../ipc/fs";
import { openWithDefaultApp, revealInFileManager } from "../ipc/shell";
import { homeDirectory } from "../ipc/system";
import type { MenuItemSpec } from "../plugins/types";
import type { Block } from "./blocks";
import { findFileLinks, resolveLinkPath } from "./fileLinks";

/*
 * Files and folders named in terminal output, in either view of a terminal
 * (the classic xterm view through fileLinkProvider.ts, the blocks view
 * through BlocksView's output lines): which names exist, what the pointer
 * is over (for the pane's right-click menu), and what opening one does.
 */

export type PathKind = "file" | "dir";

export type PathTarget = {
  /** Absolute path on this machine. */
  path: string;
  kind: PathKind;
  /** 1-based line (and column) the reference names, for a file. */
  line?: number;
  column?: number;
};

/** A target found in a line of text, as string indices (end exclusive). */
export type PathLink = { start: number; end: number; target: PathTarget };

const FOUND_MS = 10_000;
const MISSING_MS = 3_000;
const CACHE_LIMIT = 2000;
/** Lookups by path, kept until `until` (a miss for less long: it may be about to appear). */
const cache = new Map<string, { kind: Promise<PathKind | null>; until: number }>();

/**
 * Whether `path` is a file, a directory or nothing; cached briefly, so
 * hovering a busy screen stats little. `fresh` skips the cache (an explicit
 * request for something that may have just been created).
 */
export function pathKind(path: string, { fresh = false } = {}): Promise<PathKind | null> {
  const cached = cache.get(path);
  if (!fresh && cached && Date.now() < cached.until) return cached.kind;
  const entry = {
    kind: fs.stat(path).then(
      (found): PathKind | null => (found?.kind === "file" || found?.kind === "dir" ? found.kind : null),
      () => null,
    ),
    until: Date.now() + MISSING_MS,
  };
  void entry.kind.then((kind) => {
    if (kind) entry.until = Date.now() + FOUND_MS;
  });
  cache.delete(path);
  cache.set(path, entry);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return entry.kind;
}

/**
 * The files and folders named in `text` (one unwrapped line of output)
 * that exist. Bare names (`ls` output) count as well as paths and
 * `file:line` references. Relative names are resolved against each of
 * `cwds` in turn (e.g. where a command started, then where it ended, for
 * `cd x && ls`); the first that exists wins.
 */
export async function findPathLinks(text: string, cwds: string | readonly (string | undefined)[] | undefined): Promise<PathLink[]> {
  const matches = findFileLinks(text, { names: true });
  if (matches.length === 0) return [];
  const home = homeDirectory();
  const dirs = [...new Set(typeof cwds === "string" || cwds === undefined ? [cwds] : cwds)];
  const links = await Promise.all(
    matches.map(async (match): Promise<PathLink | null> => {
      for (const cwd of dirs) {
        const resolved = resolveLinkPath(match.path, cwd, home);
        if (!resolved) continue;
        let path = resolved;
        let kind = await pathKind(path);
        // `link@` is `link` (ls -F), unless an entry is really called `link@`.
        if (!kind && match.unmarked !== undefined) {
          const unmarked = resolveLinkPath(match.unmarked, cwd, home);
          kind = unmarked ? await pathKind(unmarked) : null;
          if (unmarked && kind) path = unmarked;
        }
        if (!kind) {
          // An absolute or ~ path does not depend on the directory.
          if (!cwd || path === resolveLinkPath(match.path, undefined, home)) break;
          continue;
        }
        const target: PathTarget = { path, kind };
        if (kind === "file" && match.line !== undefined) {
          target.line = match.line;
          if (match.column !== undefined) target.column = match.column;
        }
        return { start: match.start, end: match.end, target };
      }
      return null;
    }),
  );
  return links.filter((link): link is PathLink => link !== null);
}

/** Opens a file in an editor or viewer, a folder in an explorer, in `fromPaneId`'s tab. */
export function openPathTarget(target: PathTarget, fromPaneId: string, { newPane = false } = {}): void {
  if (target.kind === "dir") openDirectory(target.path, { fromPaneId, newPane });
  else openFile(target.path, { fromPaneId, newPane, line: target.line, column: target.column });
}

/**
 * Directories to resolve block `index`'s output against: where the shell
 * was after it (the next block's directory, or `current` for the last),
 * then where it started. A command that changed directory (`cd x && ls`)
 * most likely printed names relative to where it ended. Null when the
 * output is a nested shell's (ssh): not files here.
 */
export function blockDirectories(
  blocks: readonly Pick<Block, "cwd" | "host" | "nested">[],
  index: number,
  current: string | undefined,
  nested: boolean,
): (string | undefined)[] | null {
  const block = blocks[index];
  if (!block || block.host || block.nested) return null;
  const next = blocks[index + 1];
  const after = next ? (next.host || next.nested ? undefined : next.cwd) : nested ? undefined : current;
  return [...new Set([after, block.cwd].filter((dir): dir is string => !!dir))];
}

/** Whether a click on a link opens it: ⌘-click (Ctrl-click elsewhere); plain clicks select text. */
export function opensLink(event: MouseEvent | { metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey;
}

/*
 * What the pointer is over, per pane, and in which view (the classic
 * terminal or the blocks view: both can be in a pane, one covering the
 * other). Hover sets it; a right click copies it to the context target
 * (`captureContextPath`), which the pane's menu reads when it opens, so the
 * menu does not depend on hover events that opening it may cause.
 */
export type PathView = "terminal" | "blocks";

const hovered = new Map<string, { target: PathTarget; view: PathView }>();
const contextTargets = new Map<string, PathTarget>();

export function setHoveredPath(paneId: string, target: PathTarget, view: PathView): void {
  hovered.set(paneId, { target, view });
}

/** Clears the hover only if it is still `target` (a newer hover may have replaced it). */
export function leaveHoveredPath(paneId: string, target: PathTarget): void {
  if (hovered.get(paneId)?.target === target) hovered.delete(paneId);
}

/**
 * Called on right click (capture phase): the menu about to open is about
 * what is hovered, if that is in the view that was clicked.
 */
export function captureContextPath(paneId: string, clicked: EventTarget | null): void {
  const element = clicked instanceof Element ? clicked : null;
  const view: PathView = element?.closest(".blocks-view") ? "blocks" : "terminal";
  const hover = hovered.get(paneId);
  const onLink = view === "terminal" || element?.closest(".block-link") !== null;
  if (hover && hover.view === view && onLink) contextTargets.set(paneId, hover.target);
  else contextTargets.delete(paneId);
}

// Every right click starts with no target (window capture runs before any
// pane's), so a right click that never reaches `captureContextPath` (an
// agent card over the pane) does not get the last one's.
if (typeof window !== "undefined") window.addEventListener("contextmenu", () => contextTargets.clear(), { capture: true });

export function contextPathOf(paneId: string): PathTarget | undefined {
  return contextTargets.get(paneId);
}

/** Forgets a pane's targets (its session is gone). */
export function forgetPathTargets(paneId: string): void {
  hovered.delete(paneId);
  contextTargets.delete(paneId);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** Right-click items for a file or folder in a terminal's output. */
export function pathMenuItems(paneId: string, target: PathTarget): MenuItemSpec[] {
  const dir = target.kind === "dir";
  return [
    { label: dir ? "Open folder" : "Open file", shortcut: "⌘-click", run: () => openPathTarget(target, paneId) },
    { label: "Open in new pane", run: () => openPathTarget(target, paneId, { newPane: true }) },
    { label: "Open in default application", run: () => openWithDefaultApp(target.path) },
    { label: "Reveal in Finder", run: () => revealInFileManager(target.path) },
    { type: "separator" },
    { label: dir ? "Copy folder name" : "Copy file name", run: () => void copyText(baseName(target.path)) },
    { label: "Copy full path", run: () => void copyText(target.path) },
  ];
}
