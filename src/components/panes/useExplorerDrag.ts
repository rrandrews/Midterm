import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";
import { type DropTarget, explorerDrag, setExplorerDrag } from "../../explorer/drag";
import { peekExplorer } from "../../explorer/explorers";
import type { ExplorerModel } from "../../explorer/model";
import { isWithin, parentPath } from "../../explorer/tree";
import { posixPathOf, remoteIdOf, sameHost } from "../../files/location";
import { highlightPane, unhighlightPane } from "../../layout/paneHighlight";
import { activePlugin } from "../../plugins/registry";
import { pasteIntoTerminal } from "../../terminal/menu";
import { peekSession } from "../../terminal/sessions";
import { shellQuoteArg } from "../../terminal/shellQuote";
import { transferEntries } from "./ExplorerMenus";

/*
 * Dragging entries out of an explorer, with pointer events rather than
 * HTML drag and drop (which the webview shares with the window's own file
 * drops). Drop targets are found under the pointer by their markup:
 * anything with `data-drop-dir` takes entries into that folder (rows, the
 * top folder, the tree's empty space, in any explorer), and a terminal
 * pane gets the paths typed in. ⌥ copies instead of moving.
 */

/** How far the pointer moves before a press becomes a drag. */
const DRAG_THRESHOLD = 4;
/** Hovering a closed folder this long opens it. */
const EXPAND_DELAY_MS = 700;
/** Within this distance of a tree's top or bottom edge, it scrolls. */
const SCROLL_EDGE = 28;
const SCROLL_SPEED = 12;

/** Whether every dragged path belongs to the same host as the destination terminal. */
function terminalAcceptsPaths(paneId: string, paths: string[]): boolean {
  const session = peekSession(paneId);
  if (!session || session.isUntrackedNested) return false;
  const termRemoteId = session.remoteId;
  return paths.every((path) => remoteIdOf(path) === termRemoteId);
}

/** The drop target under a point, for dragging `paths`; `null` if none or it would change nothing. */
function targetAt(x: number, y: number, paths: string[], copy: boolean): DropTarget | null {
  const el = document.elementFromPoint(x, y);
  if (!(el instanceof Element)) return null;
  const folder = el.closest<HTMLElement>("[data-drop-dir]");
  if (folder?.dataset.dropDir) {
    const dir = folder.dataset.dropDir;
    const effectiveCopy = copy || paths.some((path) => !sameHost(path, dir));
    if (paths.some((path) => isWithin(dir, path))) return null;
    if (!effectiveCopy && paths.every((path) => parentPath(path) === dir)) return null;
    return { type: "dir", dir, paneId: folder.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? null };
  }
  const pane = el.closest<HTMLElement>(".pane[data-pane-id]");
  if (pane?.dataset.paneId && pane.dataset.paneKind && activePlugin(pane.dataset.paneKind)?.terminal) {
    if (!terminalAcceptsPaths(pane.dataset.paneId, paths)) return null;
    return { type: "terminal", paneId: pane.dataset.paneId };
  }
  return null;
}

/** The closed folder row under a point, and its explorer: hovering it long enough opens it. */
function closedFolderAt(x: number, y: number): { paneId: string; dir: string } | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-path][aria-expanded=false]");
  const paneId = row?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
  return row?.dataset.path && paneId ? { paneId, dir: row.dataset.path } : null;
}

type Options = {
  model: ExplorerModel;
  /** The paths a drag starting on `path` carries (the selection, if `path` is in it). */
  pathsFor: (path: string) => string[];
};

/**
 * Returns the pointer-down handler for rows, and `consumeClick`, which
 * says (once) whether the click that follows a drag should be ignored.
 */
export function useExplorerDrag({ model, pathsFor }: Options) {
  const suppressClick = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const onRowPointerDown = (event: ReactPointerEvent, path: string) => {
    if (event.button !== 0 || event.metaKey || event.shiftKey || event.ctrlKey) return;
    if ((event.target as HTMLElement).closest("input")) return;
    stop.current?.();
    const start = { x: event.clientX, y: event.clientY };
    // Only the pointer that started the drag moves or ends it.
    const pointerId = event.pointerId;
    let paths: string[] | null = null;
    let copy = event.altKey;
    let x = start.x;
    let y = start.y;
    let hover: { key: string; since: number } | null = null;
    let frame = 0;
    let highlighted: string | null = null;

    const update = () => {
      if (!paths) return;
      const target = targetAt(x, y, paths, copy);
      const effectiveCopy =
        copy || (target?.type === "dir" && paths.some((p) => !sameHost(p, target.dir)));
      const terminal = target?.type === "terminal" ? target.paneId : null;
      if (terminal !== highlighted) {
        if (highlighted) unhighlightPane(highlighted);
        if (terminal) highlightPane(terminal);
        highlighted = terminal;
      }
      document.body.style.cursor = !target ? "no-drop" : effectiveCopy && target.type === "dir" ? "copy" : "grabbing";
      setExplorerDrag({ source: model.paneId, paths, x, y, target, copy: effectiveCopy });
    };

    // While dragging: scroll a tree near its edge, open a folder hovered long enough.
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const tree = document.elementFromPoint(x, y)?.closest<HTMLElement>(".explorer-tree");
      if (tree) {
        const box = tree.getBoundingClientRect();
        const delta = y < box.top + SCROLL_EDGE ? -SCROLL_SPEED : y > box.bottom - SCROLL_EDGE ? SCROLL_SPEED : 0;
        if (delta) {
          tree.scrollTop += delta;
          update();
        }
      }
      const folder = closedFolderAt(x, y);
      const key = folder ? `${folder.paneId}\n${folder.dir}` : null;
      if (!folder || !key) hover = null;
      else if (hover?.key !== key) hover = { key, since: performance.now() };
      else if (performance.now() - hover.since > EXPAND_DELAY_MS) {
        hover = null;
        peekExplorer(folder.paneId)?.expand(folder.dir);
      }
    };

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      x = move.clientX;
      y = move.clientY;
      copy = move.altKey;
      if (!paths) {
        if (Math.hypot(x - start.x, y - start.y) < DRAG_THRESHOLD) return;
        paths = pathsFor(path);
        // A selected entry inside a selected folder is carried by the folder.
        if (!paths.some((carried) => isWithin(path, carried))) {
          model.select(path);
          paths = [path];
        }
        frame = requestAnimationFrame(tick);
      }
      update();
    };

    const finish = (drop: boolean) => {
      const drag = explorerDrag();
      cleanup();
      if (!paths) return;
      // The click that ends a drag is not a click on the row.
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      const target = drop ? drag?.target : null;
      if (target?.type === "dir") {
        const destModel = (target.paneId && peekExplorer(target.paneId)) || model;
        const mode = drag?.copy ? "copy" : "move";
        void transferEntries(destModel, paths, target.dir, mode).then(() => {
          if (destModel !== model && mode === "move") model.refresh();
        });
      } else if (target?.type === "terminal" && terminalAcceptsPaths(target.paneId, paths)) {
        pasteIntoTerminal(target.paneId, `${paths.map((p) => shellQuoteArg(posixPathOf(p))).join(" ")} `);
      }
    };

    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      // The target where the pointer is released, with the keys held then.
      x = up.clientX;
      y = up.clientY;
      copy = up.altKey;
      update();
      finish(true);
    };
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId === pointerId) finish(false);
    };
    const onKey = (key: KeyboardEvent) => {
      if (!paths) return;
      if (key.key === "Escape") {
        key.preventDefault();
        key.stopPropagation();
        finish(false);
      } else if (key.key === "Alt") {
        copy = key.type === "keydown";
        update();
      }
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      cancelAnimationFrame(frame);
      if (highlighted) unhighlightPane(highlighted);
      document.body.style.cursor = "";
      if (explorerDrag()) setExplorerDrag(null);
      stop.current = null;
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    stop.current = cleanup;
  };

  const consumeClick = () => {
    const suppressed = suppressClick.current;
    suppressClick.current = false;
    return suppressed;
  };

  return { onRowPointerDown, consumeClick };
}
