import { gitStatus } from "../ipc/fs";

/*
 * Git branch of a directory, for block headers and the input editor's
 * status line. Looked up with `gitStatus` and cached briefly per directory,
 * since a prompt and the command after it ask about the same one.
 */

const TTL_MS = 3000;
const cache = new Map<string, { at: number; branch: Promise<string | null> }>();

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
