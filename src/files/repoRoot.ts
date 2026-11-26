import * as fs from "../ipc/fs";
import { joinPath, parentPath } from "../explorer/tree";
import { isRootLocation, remoteIdOf } from "./location";

/*
 * Finds the repository a file belongs to (the nearest ancestor directory
 * with a `.git` entry), for breadcrumbs. Cheaper than asking git for the
 * status; results are cached per directory for the session.
 */

const cache = new Map<string, Promise<string | null>>();

/** Clears cached repository roots (e.g. after an SSH host reconnects). */
export function clearRepoRootCache(remoteId?: string): void {
  if (!remoteId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (remoteIdOf(key) === remoteId) cache.delete(key);
  }
}

/** The work tree root containing directory `dir`, or `null`. */
export function repoRootOf(dir: string): Promise<string | null> {
  let found = cache.get(dir);
  if (!found) {
    found = fs.stat(joinPath(dir, ".git")).then(
      (entry) => (entry ? dir : isRootLocation(dir) ? null : repoRootOf(parentPath(dir))),
      () => null,
    );
    cache.set(dir, found);
  }
  return found;
}
