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
  if (url.protocol !== "file:") return null;
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
