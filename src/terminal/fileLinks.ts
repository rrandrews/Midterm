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

/** File references in one (unwrapped) line of output. */
export function findFileLinks(text: string): FileLinkMatch[] {
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

    if (!looksLikeFile(path)) continue;
    matches.push({ start, end, path, ...(line ? { line } : {}), ...(column ? { column } : {}) });
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

/** An absolute path for a reference in output, resolved against the terminal's directory. */
export function resolveLinkPath(path: string, cwd: string | undefined, home: string | undefined): string | null {
  if (path.startsWith("/")) return normalizePath(path);
  if (path === "~" || path.startsWith("~/")) return home ? normalizePath(home + path.slice(1)) : null;
  if (path.startsWith("~")) return null; // ~user
  return cwd ? normalizePath(`${cwd}/${path}`) : null;
}
