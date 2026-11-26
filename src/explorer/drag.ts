/*
 * The entries being dragged out of an explorer, shared by every explorer so
 * each can outline the folder about to receive them. The pointer handling
 * is in src/components/panes/useExplorerDrag.ts.
 */

export type DropTarget =
  /** A folder, in any explorer (`paneId` is the explorer showing it). */
  | { type: "dir"; dir: string; paneId: string | null }
  /** A terminal: the paths are typed into it. */
  | { type: "terminal"; paneId: string };

export type ExplorerDrag = {
  /** The explorer the entries come from (it draws the drag image). */
  source: string;
  paths: string[];
  /** Pointer position, for the drag image. */
  x: number;
  y: number;
  /** Where a drop would go; `null` if nowhere (or it would change nothing). */
  target: DropTarget | null;
  /** ⌥ held: copy instead of move. */
  copy: boolean;
};

let current: ExplorerDrag | null = null;
const listeners = new Set<() => void>();

export function explorerDrag(): ExplorerDrag | null {
  return current;
}

export function setExplorerDrag(next: ExplorerDrag | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeExplorerDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The folder a drag would drop into, if it is `dir`. */
export function dropDir(drag: ExplorerDrag | null): string | null {
  return drag?.target?.type === "dir" ? drag.target.dir : null;
}
