import type { PtyForeground } from "../ipc/pty";

/**
 * A terminal's automatic title: the program in the foreground, or, while
 * the shell itself waits for input, the last part of its directory (`~` for
 * the home directory). `undefined` when there is nothing to go on yet.
 */
export function terminalTitle(
  foreground: PtyForeground | null,
  cwd: string | undefined,
  home: string | undefined,
): string | undefined {
  if (foreground && !foreground.isShell && foreground.name) return foreground.name;
  if (!cwd) return foreground?.name || undefined;
  const dir = cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd;
  if (home && dir === home.replace(/\/+$/, "")) return "~";
  if (dir === "/") return "/";
  return dir.slice(dir.lastIndexOf("/") + 1) || dir;
}
