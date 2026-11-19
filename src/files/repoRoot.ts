import * as fs from "../ipc/fs";
import { joinPath, parentPath } from "../explorer/tree";

/*
 * Finds the repository a file belongs to (the nearest ancestor directory
 * with a `.git` entry), for breadcrumbs. Cheaper than asking git for the
 * status; results are cached per directory for the session.
 */

const cache = new Map<string, Promise<string | null>>();

/** The work tree root containing directory `dir`, or `null`. */
export function repoRootOf(dir: string): Promise<string | null> {
  let found = cache.get(dir);
  if (!found) {
    found = fs.stat(joinPath(dir, ".git")).then(
      (entry) => (entry ? dir : dir === "/" ? null : repoRootOf(parentPath(dir))),
      () => null,
    );
    cache.set(dir, found);
  }
  return found;
}
