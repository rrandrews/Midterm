import { openDirectory, openFile } from "../actions";
import { copyText } from "../ipc/clipboard";
import * as fs from "../ipc/fs";
import { openWithDefaultApp, revealInFileManager } from "../ipc/shell";
import { homeDirectory } from "../ipc/system";
import type { MenuItemSpec } from "../plugins/types";
import { editorDraft } from "../ai/editorRequests";
import { canRun, runFromBlocks } from "./blockMode";
import type { Block } from "./blocks";
import { peekSession } from "./sessions";
import { shellQuoteArg } from "./shellQuote";
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

/** Whether a click on a link is a ⌘-click (Ctrl-click elsewhere): open in a new pane. */
export function isNewPaneClick(event: MouseEvent | { metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey;
}

/**
 * The `cd` argument for `dir` from `cwd`: `./sub/dir` inside it (the `./`
 * keeps `CDPATH` out and a name like `-P` from being an option), else the
 * absolute path. Quoted for the shell.
 */
export function cdArgument(dir: string, cwd: string | undefined): string {
  return shellQuoteArg(cwd && dir.startsWith(`${cwd}/`) ? `./${dir.slice(cwd.length + 1)}` : dir);
}

/**
 * Whether a click on a folder can `cd` the pane's shell there: it is idle
 * at a prompt of this machine's shell, no program it started without a
 * command mark (bash's `(cat)`) has the terminal, and no command is being
 * written (in the input editor or on the shell's line), which the `cd`
 * would throw away.
 */
export function canChangeDirectory(paneId: string): boolean {
  const session = peekSession(paneId);
  if (!session || !canRun(session) || session.blocks.snapshot().nested) return false;
  if (session.foregroundProgram && !session.foregroundProgram.isShell) return false;
  return !session.blocks.typedPromptInput() && !editorDraft(paneId)?.trim();
}

/** Runs `cd <dir>` in the pane's shell when `canChangeDirectory`. Returns whether it did. */
export function changeDirectory(paneId: string, dir: string): boolean {
  const session = peekSession(paneId);
  if (!session || !canChangeDirectory(paneId)) return false;
  if (dir === session.cwd) return true;
  // Typed as keystrokes: a control character would act (a tab completes),
  // and quoting a backslash differs between shells (fish).
  if (/[\\\u0000-\u001f\u007f]/.test(dir)) return false;
  runFromBlocks(session, `cd ${cdArgument(dir, session.cwd)}`);
  return true;
}

/**
 * A click on a link: a file opens in an editor or viewer (in a new pane
 * with ⌘), a folder becomes the shell's directory (with ⌘, opens in a new
 * explorer pane).
 */
export function clickPath(target: PathTarget, paneId: string, { newPane = false } = {}): void {
  if (target.kind === "dir" && !newPane) changeDirectory(paneId, target.path);
  else openPathTarget(target, paneId, { newPane });
}

/*
 * What the pointer is over, per pane, and in which view (the classic
 * terminal or the blocks view: both can be in a pane, one covering the
 * other). A right click on it opens the link's own menu instead of the
 * pane's (`pathUnderPointer`, in TerminalPane); hovering it a while shows
 * its tooltip (`PathTip`).
 */
export type PathView = "terminal" | "blocks";

/** Where a link is on screen, for its tooltip. */
export type AnchorRect = { left: number; top: number; width: number; height: number };

const hovered = new Map<string, { target: PathTarget; view: PathView }>();

export function setHoveredPath(paneId: string, target: PathTarget, view: PathView, rect?: AnchorRect): void {
  hovered.set(paneId, { target, view });
  if (rect) scheduleTip({ paneId, target, view, rect });
}

/** The same entry (a line looked up again gives new target objects for it). */
function samePath(a: PathTarget | undefined, b: PathTarget): boolean {
  return !!a && a.path === b.path && a.kind === b.kind;
}

/** Clears the hover only if it is still `target` (a newer hover may have replaced it). */
export function leaveHoveredPath(paneId: string, target: PathTarget): void {
  const hover = hovered.get(paneId);
  if (hover && samePath(hover.target, target)) hovered.delete(paneId);
  if ((pendingTip?.paneId === paneId && samePath(pendingTip.target, target)) || (shownTip?.paneId === paneId && samePath(shownTip.target, target))) {
    hideTip();
  }
}

/** The link a right click on `clicked` is about: what is hovered, if it is in the view clicked (on a link, in the blocks view). */
export function pathUnderPointer(paneId: string, clicked: EventTarget | null): PathTarget | undefined {
  const element = clicked instanceof Element ? clicked : null;
  const view: PathView = element?.closest(".blocks-view") ? "blocks" : "terminal";
  const hover = hovered.get(paneId);
  const onLink = view === "terminal" || element?.closest(".block-link") !== null;
  return hover && hover.view === view && onLink ? hover.target : undefined;
}

/** Forgets a pane's targets (its session is gone). */
export function forgetPathTargets(paneId: string): void {
  hovered.delete(paneId);
  if (shownTip?.paneId === paneId || pendingTip?.paneId === paneId) hideTip();
}

/*
 * The tooltip of the hovered link: one at a time, shown after a short
 * hover (at once when moving from one link to the next, as the app's other
 * tooltips do), hidden on leave, click, right click or scroll.
 */
export type PathTipState = { paneId: string; target: PathTarget; view: PathView; rect: AnchorRect };

const TIP_DELAY = 350;
let shownTip: PathTipState | null = null;
let pendingTip: PathTipState | null = null;
let tipTimer: ReturnType<typeof setTimeout> | undefined;
const tipListeners = new Set<() => void>();

function setShownTip(tip: PathTipState | null): void {
  shownTip = tip;
  for (const listener of tipListeners) listener();
}

function scheduleTip(tip: PathTipState): void {
  clearTimeout(tipTimer);
  pendingTip = null;
  if (shownTip) {
    setShownTip(tip);
    return;
  }
  pendingTip = tip;
  tipTimer = setTimeout(() => {
    pendingTip = null;
    setShownTip(tip);
  }, TIP_DELAY);
}

export function hideTip(): void {
  clearTimeout(tipTimer);
  pendingTip = null;
  if (shownTip) setShownTip(null);
}

export function subscribeTip(listener: () => void): () => void {
  tipListeners.add(listener);
  return () => tipListeners.delete(listener);
}

export const currentTip = (): PathTipState | null => shownTip;

/** `~`-relative path for display. */
export function displayPath(path: string): string {
  const home = homeDirectory();
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** The right-click menu of a file or folder in a terminal's output (instead of the pane's). */
export function pathMenuItems(paneId: string, target: PathTarget): MenuItemSpec[] {
  const dir = target.kind === "dir";
  return [
    dir
      ? { label: "Change to this folder", shortcut: "Click", disabled: !canChangeDirectory(paneId), run: () => changeDirectory(paneId, target.path) }
      : { label: "Open file", shortcut: "Click", run: () => openPathTarget(target, paneId) },
    { label: "Open in new pane", shortcut: "⌘Click", run: () => openPathTarget(target, paneId, { newPane: true }) },
    { label: "Open in default application", run: () => openWithDefaultApp(target.path) },
    { label: "Reveal in Finder", run: () => revealInFileManager(target.path) },
    { type: "separator" },
    { label: dir ? "Copy folder name" : "Copy file name", run: () => void copyText(baseName(target.path)) },
    { label: "Copy full path", run: () => void copyText(target.path) },
  ];
}
