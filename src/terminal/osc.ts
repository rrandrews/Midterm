import { isValidRemoteId } from "../files/location";

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

/**
 * Midterm's sequence for SSH lifecycle and remote shell metadata:
 * - Local-only (authenticated by per-PTY secret `token`):
 *   `OSC 6974 ; ssh=start ; id=<id> ; label=<enc> ; host=<enc> ; user=<enc> ; port=<n> ; sock=<enc> ; owned=<0|1> ; args=<enc_csv> ; token=<tok> BEL`
 *   `OSC 6974 ; ssh=end ; id=<id> ; token=<tok> BEL`
 * - Local or remote shell metadata (one-time on shell startup):
 *   `OSC 6974 ; meta=1 ; home=<enc> ; shell=<name> [; aid=<aid>] BEL`
 */
export const OSC_SSH = 6974;

export type SshOscEvent =
  | {
      kind: "start";
      id: string;
      label: string;
      host: string;
      user: string;
      port: number;
      controlPath: string;
      ownedSocket: boolean;
      sshArgs: string[];
      token: string;
    }
  | {
      kind: "end";
      id: string;
      token: string;
    }
  | {
      kind: "meta";
      home: string | undefined;
      shell: string | undefined;
      aid: string | undefined;
    };

function decodeField(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Parses an OSC 6974 payload; returns `null` if malformed. */
export function parseSshOsc(data: string): SshOscEvent | null {
  const fields = new Map<string, string>();
  for (const part of data.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }

  const ssh = fields.get("ssh");
  if (ssh === "start") {
    const id = fields.get("id") ?? "";
    const token = fields.get("token") ?? "";
    const rawHost = fields.get("host");
    const rawSock = fields.get("sock");
    if (!isValidRemoteId(id) || !token || rawHost === undefined || rawSock === undefined) return null;
    const host = decodeField(rawHost);
    const controlPath = decodeField(rawSock);
    if (!host || !controlPath) return null;

    const rawLabel = fields.get("label");
    const label = rawLabel !== undefined ? decodeField(rawLabel) : host;
    if (label === null) return null;

    const rawUser = fields.get("user");
    const user = rawUser !== undefined ? decodeField(rawUser) : "";
    if (user === null) return null;

    const rawPort = fields.get("port");
    let port = 22;
    if (rawPort !== undefined && rawPort !== "") {
      if (!/^\d+$/.test(rawPort)) return null;
      port = Number(rawPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    }

    const ownedSocket = fields.get("owned") === "1";
    const rawArgs = fields.get("args") ?? "";
    const sshArgs: string[] = [];
    if (rawArgs !== "") {
      for (const item of rawArgs.split(",")) {
        const decoded = decodeField(item);
        if (decoded === null) return null;
        sshArgs.push(decoded);
      }
    }

    return {
      kind: "start",
      id,
      label: label || host,
      host,
      user,
      port,
      controlPath,
      ownedSocket,
      sshArgs,
      token,
    };
  }

  if (ssh === "end") {
    const id = fields.get("id") ?? "";
    const token = fields.get("token") ?? "";
    if (!isValidRemoteId(id) || !token) return null;
    return { kind: "end", id, token };
  }

  if (fields.get("meta") === "1") {
    const rawHome = fields.get("home");
    let home: string | undefined;
    if (rawHome !== undefined && rawHome !== "") {
      const decoded = decodeField(rawHome);
      if (decoded === null) return null;
      if (decoded.startsWith("/")) {
        home = decoded.length > 1 ? decoded.replace(/\/+$/, "") : decoded;
      }
    }
    const rawShell = fields.get("shell");
    const shell = rawShell && /^[A-Za-z0-9._+-]{1,32}$/.test(rawShell) ? rawShell : undefined;
    const rawAid = fields.get("aid");
    const aid = rawAid || undefined;
    if (!home && !shell) return null;
    return { kind: "meta", home, shell, aid };
  }

  return null;
}
