/** A working directory reported by the shell with OSC 7. */
export type ReportedCwd = { host: string; path: string };

/**
 * Parses the payload of an OSC 7 sequence, `file://<host><path>`, with the
 * path percent-encoded. Returns `null` for anything else.
 */
export function parseOsc7(data: string): ReportedCwd | null {
  let url: URL;
  try {
    url = new URL(data);
  } catch {
    return null;
  }
  // kitty's integration reports `kitty-shell-cwd://host/path` instead.
  if (url.protocol !== "file:" && url.protocol !== "kitty-shell-cwd:") return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (!path.startsWith("/")) return null;
  // Keep "/" itself, but not a trailing slash on anything else.
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return { host: url.hostname.toLowerCase(), path };
}

/**
 * Midterm's own sequence for the shell's `PATH`, sent by the integration
 * scripts before a prompt whenever it changed: `OSC 6973 ; path=<PATH,
 * percent-encoded> ; aid=<shell id> BEL`. 6973 is not used by xterm, kitty,
 * iTerm2, VS Code, Ghostty, WezTerm or ConEmu (they use 0–119, 133, 633,
 * 777, 1337, 5113, 5522, 9 and 99).
 */
export const OSC_PATH = 6973;

/** A `PATH` reported with OSC 6973, and the id of the shell that sent it. */
export type PathReport = { path: string; aid: string | undefined };

/** Parses the payload of an OSC 6973; `null` for anything malformed. */
export function parsePathReport(data: string): PathReport | null {
  let path: string | undefined;
  let aid: string | undefined;
  for (const field of data.split(";")) {
    const eq = field.indexOf("=");
    if (eq < 0) continue;
    const key = field.slice(0, eq);
    const value = field.slice(eq + 1);
    if (key === "path") {
      try {
        path = decodeURIComponent(value);
      } catch {
        return null;
      }
    } else if (key === "aid") aid = value;
  }
  return path === undefined ? null : { path, aid };
}
