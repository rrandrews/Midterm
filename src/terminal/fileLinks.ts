import { formatRemoteLocation, parseLocation } from "../files/location";
import { normalizePath } from "../viewer/links";

/*
 * Recognising file references in terminal output: `src/a.ts:12:5`,
 * `./b.rs:3`, `/abs/c.py`, tsc's `a.ts(12,5)`, Python's
 * `File "x.py", line 12`. Pure; the xterm link provider
 * (fileLinkProvider.ts) checks that the files exist. Unit-tested.
 */

export type FileLinkMatch = {
  /** Range in the text, as string indices (end exclusive). */
  start: number;
  end: number;
  /** The path as written (relative, absolute or `~/…`). */
  path: string;
  /** With `names`: the path without an `ls -F` marker (`*`, `@`), to try when `path` does not exist. */
  unmarked?: string;
  line?: number;
  column?: number;
};

/** Runs of characters that can be part of a path. Quotes, brackets and the like end one. */
const TOKEN = /[^\s"'`()<>[\]{}|,;=]+/g;
/** `:line` or `:line:column` at the end, possibly with a trailing colon (`a.ts:3:1:`). */
const COLON_POSITION = /:(\d+)(?::(\d+))?:?$/;
/** What may follow the path in the text: tsc's `(line,col)` or Python's `", line N`. */
const PAREN_POSITION = /^\((\d+)(?:,\s?(\d+))?\)/;
const PYTHON_POSITION = /^"?,\s*line\s+(\d+)/;
/** A file extension: a dot, then a letter, then letters or digits. */
const EXTENSION = /\.[A-Za-z][A-Za-z0-9_-]{0,15}$/;

export type FindOptions = {
  /**
   * Also bare names (`Makefile`, `src`, `src/`), as `ls` prints them:
   * anything that could name an entry. Callers check what exists.
   */
  names?: boolean;
};

/** File references in one (unwrapped) line of output. */
export function findFileLinks(text: string, { names = false }: FindOptions = {}): FileLinkMatch[] {
  const matches: FileLinkMatch[] = [];
  for (const token of text.matchAll(TOKEN)) {
    const start = token.index;
    if (token[0].includes("://")) continue;
    // Sentence punctuation after a path is not part of it, nor is a
    // trailing colon unless it ends a position (`a.ts:3:1:`).
    let raw = token[0].replace(/[.!?]+$/, "");
    if (!COLON_POSITION.test(raw)) raw = raw.replace(/:+$/, "");

    let path = raw;
    let line: number | undefined;
    let column: number | undefined;
    let end = start + raw.length;

    const colon = COLON_POSITION.exec(raw);
    if (colon) {
      path = raw.slice(0, colon.index);
      line = Number(colon[1]);
      column = colon[2] ? Number(colon[2]) : undefined;
      // The range covers `path:line:col`, not a trailing colon.
      end = start + colon.index + colon[0].replace(/:$/, "").length;
    } else {
      const after = text.slice(start + raw.length);
      const paren = PAREN_POSITION.exec(after);
      const python = PYTHON_POSITION.exec(after);
      if (paren) {
        line = Number(paren[1]);
        column = paren[2] ? Number(paren[2]) : undefined;
        end = start + raw.length + paren[0].length;
      } else if (python) {
        line = Number(python[1]);
      }
    }

    let unmarked: string | undefined;
    if (names && line === undefined) {
      // `ls -F` / `ls -p` markers: `dir/` is `dir`; `tool*` and `link@`
      // may be, or may be names. The range keeps them.
      path = path.replace(/(?<=[^/])\/+$/, "");
      const stripped = path.replace(/(?<=.)[*@]$/, "");
      if (stripped !== path && looksLikeName(stripped)) unmarked = stripped;
    }
    if (!(names ? looksLikeName(path) || unmarked !== undefined : looksLikeFile(path))) continue;
    matches.push({ start, end, path, ...(unmarked ? { unmarked } : {}), ...(line ? { line } : {}), ...(column ? { column } : {}) });
  }
  return matches;
}

function looksLikeFile(path: string): boolean {
  if (path.length < 2 || path.startsWith("-")) return false;
  if (/^[\d.:]+$/.test(path)) return false; // numbers, versions, times
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!name || name === "." || name === "..") return false;
  return path.includes("/") || EXTENSION.test(name);
}

/** Could name a file or directory: not an option, a number or punctuation. */
function looksLikeName(path: string): boolean {
  if (path.startsWith("-") || /^[\d.:,%+]+$/.test(path)) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!name || name === "." || name === "..") return false;
  return /[\p{L}\p{N}]/u.test(name);
}

/** An absolute location for a reference in output, resolved against the terminal's directory (preserving any SSH host). */
export function resolveLinkPath(
  path: string,
  cwd: string | undefined,
  home: string | undefined,
  remoteIdHint?: string | null,
): string | null {
  const cwdParsed = cwd ? parseLocation(cwd) : null;
  const remoteId = cwdParsed?.kind === "remote" ? cwdParsed.remoteId : (remoteIdHint ?? null);
  if (path.startsWith("/")) {
    const norm = normalizePath(path);
    return remoteId ? formatRemoteLocation(remoteId, norm) : norm;
  }
  if (path === "~" || path.startsWith("~/")) {
    if (!home) return null;
    const homeParsed = parseLocation(home);
    if (!homeParsed) return null;
    if (remoteId && (homeParsed.kind !== "remote" || homeParsed.remoteId !== remoteId)) return null;
    const norm = normalizePath(homeParsed.path + path.slice(1));
    return homeParsed.kind === "remote" ? formatRemoteLocation(homeParsed.remoteId, norm) : norm;
  }
  if (path.startsWith("~")) return null; // ~user
  if (!cwdParsed) return null;
  if (remoteId && (cwdParsed.kind !== "remote" || cwdParsed.remoteId !== remoteId)) return null;
  const norm = normalizePath(`${cwdParsed.path}/${path}`);
  return cwdParsed.kind === "remote" ? formatRemoteLocation(cwdParsed.remoteId, norm) : norm;
}
