import { selectAllPanes, useAppStore } from "../state/store";
import type { PaneNode } from "../state/types";

/*
 * State that belongs to a pane but lives outside React: a terminal session,
 * an explorer model, an editor's document. Pane components mount and
 * unmount freely (tab switches, layout remounts, moves between tabs), so
 * the state is kept by pane id and only disposed once its pane is gone.
 *
 * The rule: an entry is disposed when no component holds it and no pane in
 * any tab of any workspace still wants it (by default: a pane with its id
 * and the given kind). That one rule covers closing a pane, a tab or a
 * workspace and changing a pane's type, without each of those having to
 * clean up. The check is deferred, so a pane that is only remounting is
 * back before anyone looks.
 */

export type PaneStateOptions<T> = {
  /** Panes of this kind keep their entries. */
  kind?: string;
  /** Whether `pane` still wants `value`; overrides `kind`. */
  isLive?: (pane: PaneNode, value: T) => boolean;
  /** Releases the entry's resources. */
  dispose: (value: T, paneId: string) => void;
};

export type PaneState<T> = {
  /**
   * The pane's entry, created with `create` if there is none (or if
   * `reuse` rejects the existing one, which is then disposed), and held
   * until `release`.
   */
  acquire(paneId: string, create: () => T, reuse?: (existing: T) => boolean): T;
  /** A component is done with the entry; it is disposed later if its pane is gone. */
  release(paneId: string, value: T): void;
  get(paneId: string): T | undefined;
  /** Every entry, by pane id. */
  entries(): [string, T][];
  /** Disposes the pane's entry now. */
  delete(paneId: string): void;
  /** Stops managing entries (disposing them all). */
  destroy(): void;
};

type Slot<T> = { value: T; holds: number };

const instances = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let subscribed = false;

/** Runs every pane state's check once the current task (and any remounts in it) is done. */
export function scheduleReconcile(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    for (const reconcile of instances) reconcile();
  }, 0);
}

export function createPaneState<T>(options: PaneStateOptions<T>): PaneState<T> {
  const slots = new Map<string, Slot<T>>();
  const isLive = options.isLive ?? ((pane: PaneNode) => pane.data.kind === options.kind);

  const dispose = (paneId: string, slot: Slot<T>) => {
    slots.delete(paneId);
    try {
      options.dispose(slot.value, paneId);
    } catch (error) {
      console.error("Disposing pane state failed:", error);
    }
  };

  const reconcile = () => {
    if (slots.size === 0) return;
    const panes = new Map<string, PaneNode>();
    for (const pane of selectAllPanes(useAppStore.getState())) panes.set(pane.id, pane);
    for (const [paneId, slot] of [...slots]) {
      if (slot.holds > 0) continue;
      const pane = panes.get(paneId);
      if (pane && isLive(pane, slot.value)) continue;
      dispose(paneId, slot);
    }
  };

  instances.add(reconcile);
  if (!subscribed) {
    subscribed = true;
    useAppStore.subscribe(scheduleReconcile);
  }

  return {
    acquire(paneId, create, reuse) {
      let slot = slots.get(paneId);
      if (slot && reuse && !reuse(slot.value)) {
        dispose(paneId, slot);
        slot = undefined;
      }
      if (!slot) {
        slot = { value: create(), holds: 0 };
        slots.set(paneId, slot);
      }
      slot.holds += 1;
      return slot.value;
    },
    release(paneId, value) {
      const slot = slots.get(paneId);
      if (slot?.value === value) slot.holds = Math.max(0, slot.holds - 1);
      scheduleReconcile();
    },
    get: (paneId) => slots.get(paneId)?.value,
    entries: () => [...slots].map(([paneId, slot]) => [paneId, slot.value]),
    delete(paneId) {
      const slot = slots.get(paneId);
      if (slot) dispose(paneId, slot);
    },
    destroy() {
      instances.delete(reconcile);
      for (const [paneId, slot] of [...slots]) dispose(paneId, slot);
    },
  };
}
