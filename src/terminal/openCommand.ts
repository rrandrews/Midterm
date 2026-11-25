import { registerSlashHandler } from "../ai/slash";
import { homeDirectory } from "../ipc/system";
import { resolveLinkPath } from "./fileLinks";
import { type PathTarget, openPathTarget, pathKind } from "./pathTargets";
import { peekSession } from "./sessions";

/*
 * `/open <file or folder>` in the blocks editor: opens what it names,
 * relative to the terminal's directory, the way ⌘-clicking it in the
 * output would (a file in an editor or viewer, a folder in an explorer).
 */

export type OpenArgument = { name: string; line?: number; column?: number };

/**
 * The name `/open` was given, as typed in a shell: in quotes, or with
 * backslash escapes (as ⇥ completion inserts them). A `:line[:column]` at
 * the end is split off as a position, for when no entry has the whole name.
 */
export function parseOpenArgument(args: string): { whole: string; positioned?: OpenArgument } | null {
  const name = shellWord(args.trim());
  if (!name) return null;
  const position = /^(.+?):(\d+)(?::(\d+))?$/.exec(name);
  if (!position) return { whole: name };
  const positioned: OpenArgument = { name: position[1], line: Number(position[2]) };
  if (position[3]) positioned.column = Number(position[3]);
  return { whole: name, positioned };
}

/**
 * `text` as the shell would read it as one word: quotes removed, a
 * backslash escaping the next character outside quotes and `"`, `$`, `\``
 * and `\\` inside double quotes (what completion inserts).
 */
export function shellWord(text: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else out += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && i + 1 < text.length && '"$`\\'.includes(text[i + 1])) out += text[++i];
      else out += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "\\" && i + 1 < text.length) out += text[++i];
    else out += char;
  }
  return out;
}

/** What `/open <args>` in the pane opens, or the message to show instead. */
async function resolveOpen(paneId: string, args: string): Promise<PathTarget | string> {
  const session = peekSession(paneId);
  if (!session) return "This terminal is not available.";
  if (session.blocks.snapshot().nested) return "/open opens files on this machine; this shell is on another one.";
  const parsed = parseOpenArgument(args);
  if (!parsed) return "Name a file or folder to open: /open <file or folder>";
  const home = homeDirectory();
  const candidates: OpenArgument[] = [{ name: parsed.whole }];
  if (parsed.positioned) candidates.push(parsed.positioned);
  for (const candidate of candidates) {
    const path = resolveLinkPath(candidate.name, session.cwd, home);
    const kind = path ? await pathKind(path, { fresh: true }) : null;
    if (!path || !kind) continue;
    const target: PathTarget = { path, kind };
    if (kind === "file" && candidate.line !== undefined) {
      target.line = candidate.line;
      if (candidate.column !== undefined) target.column = candidate.column;
    }
    return target;
  }
  return `No such file or folder: ${parsed.whole}`;
}

/** Registers `/open` with the blocks editor's slash commands. */
export function installOpenCommand(): void {
  registerSlashHandler("open", async (paneId, args) => {
    const target = await resolveOpen(paneId, args);
    if (typeof target === "string") return target;
    openPathTarget(target, paneId);
  });
}
