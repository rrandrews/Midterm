import { fallbackHostLabel, parseLocation, posixPathOf, sameHost } from "../files/location";
import type { PtyForeground } from "../ipc/pty";

/**
 * A terminal's automatic title: the program in the foreground, or, while
 * the shell itself waits for input, the last part of its directory (`~` for
 * the home directory). For remote SSH locations, prefixes `<host>:` without
 * ever leaking `ssh://<id>`. `undefined` when there is nothing to go on yet.
 */
export function terminalTitle(
  foreground: PtyForeground | null,
  cwd: string | undefined,
  home: string | undefined,
  hostLabel?: string,
): string | undefined {
  const parsed = cwd ? parseLocation(cwd) : null;
  if (parsed?.kind === "remote") {
    const label = hostLabel || fallbackHostLabel(parsed.remoteId);
    if (foreground && !foreground.isShell && foreground.name && foreground.name !== "ssh") {
      return `${label}: ${foreground.name}`;
    }
    const dir = parsed.path.length > 1 ? parsed.path.replace(/\/+$/, "") : parsed.path;
    const matchingHome = home && cwd && sameHost(cwd, home) ? posixPathOf(home).replace(/\/+$/, "") || "/" : undefined;
    const shortDir =
      matchingHome && dir === matchingHome ? "~" : dir === "/" ? "/" : dir.slice(dir.lastIndexOf("/") + 1) || dir;
    return `${label}:${shortDir}`;
  }
  if (foreground && !foreground.isShell && foreground.name) return foreground.name;
  if (!cwd) return foreground?.name || undefined;
  const dir = cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd;
  if (home && dir === home.replace(/\/+$/, "")) return "~";
  if (dir === "/") return "/";
  return dir.slice(dir.lastIndexOf("/") + 1) || dir;
}
