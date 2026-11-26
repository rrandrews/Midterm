import { remoteIdOf } from "../files/location";
import { gitStatus } from "../ipc/fs";
import { listConnections, subscribeConnections } from "../ssh/connections";

/*
 * Git branch of a directory (local or `ssh://<id>/<path>`), for block headers
 * and the input editor's status line. Looked up with `gitStatus` and cached
 * briefly per directory, since a prompt and the command after it ask about
 * the same one.
 */

const TTL_MS = 3000;
const cache = new Map<string, { at: number; branch: Promise<string | null> }>();

const lastStatus = new Map<string, string>();
subscribeConnections(() => {
  for (const conn of listConnections()) {
    const prev = lastStatus.get(conn.id);
    if (prev !== "connected" && conn.status === "connected") clearBranchCache(conn.id);
    lastStatus.set(conn.id, conn.status);
  }
});

/** Drops cached branch lookups (for one remote host, or all when omitted). */
export function clearBranchCache(remoteId?: string): void {
  if (!remoteId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (remoteIdOf(key) === remoteId) cache.delete(key);
  }
}

export function branchOf(cwd: string): Promise<string | null> {
  const now = Date.now();
  const hit = cache.get(cwd);
  if (hit && now - hit.at < TTL_MS) return hit.branch;
  const branch = gitStatus(cwd).then(
    (status) => status?.branch ?? null,
    () => null,
  );
  cache.set(cwd, { at: now, branch });
  if (cache.size > 64) cache.delete(cache.keys().next().value as string);
  return branch;
}
