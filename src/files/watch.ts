import * as fs from "../ipc/fs";
import type { Watcher } from "../ipc/fs";
import { parentPath } from "../explorer/tree";

/*
 * One backend watcher shared by every open file (editors and viewers). The
 * backend watches directories, so each file is watched through its parent:
 * a report for that directory means the file may have changed, and the
 * subscriber looks (stat) to find out.
 */

type Subscription = { dir: string; onChange: () => void };

const subscriptions = new Set<Subscription>();
let watcher: Watcher | null = null;
let starting: Promise<void> | null = null;

function watchedDirs(): string[] {
  return [...new Set([...subscriptions].map((subscription) => subscription.dir))];
}

function update(): void {
  if (subscriptions.size === 0) {
    watcher?.stop();
    watcher = null;
    return;
  }
  if (watcher) {
    watcher.setDirs(watchedDirs());
    return;
  }
  if (starting) return;
  starting = fs
    .watch(({ dirs }) => {
      const changed = new Set(dirs);
      for (const subscription of [...subscriptions]) {
        if (changed.has(subscription.dir)) subscription.onChange();
      }
    })
    .then(
      (started) => {
        starting = null;
        if (subscriptions.size === 0) {
          started.stop();
          return;
        }
        watcher = started;
        watcher.setDirs(watchedDirs());
        // Anything that changed before the watch started went unseen.
        for (const subscription of [...subscriptions]) subscription.onChange();
      },
      (error: unknown) => {
        starting = null;
        console.warn("Watching files failed:", error);
      },
    );
}

/** Calls `onChange` when the file at `path` may have changed. Returns a function that stops. */
export function watchFile(path: string, onChange: () => void): () => void {
  const subscription = { dir: parentPath(path), onChange };
  subscriptions.add(subscription);
  update();
  return () => {
    if (subscriptions.delete(subscription)) update();
  };
}
