/*
 * Tab completion for the blocks input editor: the pure part. The line is
 * tokenized shell-style, the word at the caret classified (command name,
 * path, directory), and candidates filtered and inserted with the escaping
 * the shell needs. Listing the candidates (PATH, directories) is
 * `completionSource.ts`; the keys and the list are `useCompletion.ts`.
 */

/** A quote left open at the end of a word. */
export type Quote = "'" | '"';

/** One word of the line, with its text as typed and as the shell sees it. */
export type Word = {
  kind: "word";
  /** Offsets in the line: `[start, end)`. */
  start: number;
  end: number;
  /** The word with quotes and escapes removed. */
  value: string;
  /** The quote still open at the end of the word (only the last word of a prefix can have one). */
  quote: Quote | null;
  /** Contains an unquoted or double-quoted `$` or a backquote: the value is not literal. */
  expands: boolean;
  /**
   * The last place the word can be cut for completion: after its last `/`
   * or the start of the open quote's text, whichever is later (else the
   * word's start). `raw` is the line offset, `value` how much of `value`
   * comes before it.
   */
  cut: { raw: number; value: number };
};

export type Operator = { kind: "op"; start: number; end: number; op: string };

export type Token = Word | Operator;

/** Operators that end a command: what follows is a new command name. */
const SEPARATORS = new Set(["|", "||", "&", "&&", ";", ";;", "(", "|&", "\n"]);
/** Longest first. */
const OPERATORS = ["&&", "||", ";;", "|&", ">>", "<<", ">&", "<&", "&>", "|", "&", ";", "(", ")", "<", ">", "\n"];

/**
 * Splits `line` into words and operators the way a POSIX shell would:
 * single quotes are literal, double quotes keep `\` before `"$\`` and
 * backquote, a backslash outside quotes escapes the next character. A word
 * that ends inside an open quote records it. Comments are not recognised.
 */
export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    const op = OPERATORS.find((candidate) => line.startsWith(candidate, i));
    if (op) {
      tokens.push({ kind: "op", start: i, end: i + op.length, op });
      i += op.length;
      continue;
    }
    const start = i;
    let value = "";
    let quote: Quote | null = null;
    let expands = false;
    let cut = { raw: start, value: 0 };
    while (i < line.length) {
      const c = line[i];
      if (quote === "'") {
        if (c === "'") quote = null;
        else value += c;
        i++;
      } else if (quote === '"') {
        if (c === '"') {
          quote = null;
          i++;
        } else if (c === "\\" && i + 1 < line.length && '"$`\\\n'.includes(line[i + 1])) {
          value += line[i + 1];
          i += 2;
        } else {
          if (c === "$" || c === "`") expands = true;
          value += c;
          i++;
        }
      } else if (c === " " || c === "\t" || OPERATORS.some((candidate) => line.startsWith(candidate, i))) {
        break;
      } else if (c === "'" || c === '"') {
        quote = c;
        i++;
        cut = { raw: i, value: value.length };
        continue;
      } else if (c === "\\") {
        if (i + 1 < line.length) {
          value += line[i + 1];
          i += 2;
        } else {
          // A trailing backslash escapes nothing yet.
          i++;
        }
        if (value.endsWith("/")) cut = { raw: i, value: value.length };
        continue;
      } else {
        if (c === "$" || c === "`") expands = true;
        value += c;
        i++;
      }
      if (value.endsWith("/") && line[i - 1] === "/") cut = { raw: i, value: value.length };
    }
    tokens.push({ kind: "word", start, end: i, value, quote, expands, cut });
  }
  return tokens;
}

/** Words after which the next word is a command name (prefix commands and shell keywords). */
const PREFIXES = new Set([
  "sudo",
  "env",
  "time",
  "nohup",
  "exec",
  "command",
  "builtin",
  "nice",
  "doas",
  "caffeinate",
  "xargs",
  "watch",
  "!",
  "{",
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
]);
/** Commands whose arguments are directories. */
const DIR_COMMANDS = new Set(["cd", "pushd", "rmdir"]);

/** What the word at the caret completes to. */
export type CompletionKind =
  /** A command name: PATH executables and builtins. */
  | "command"
  /** A command typed as a path (`./run`, `bin/x`): executables and directories. */
  | "executable"
  /** Any file or directory. */
  | "path"
  /** Directories only (`cd`, `pushd`, `rmdir`). */
  | "dir";

export type CompletionContext = {
  kind: CompletionKind;
  /** The word up to the caret (an empty one when the caret follows a space or an operator). */
  word: Word;
  /** For path kinds: the directory part as the shell sees it (`~/src/`, `../`, `` for none). */
  dir: string;
  /** The name typed so far (after `dir`): what the candidates must start with. */
  prefix: string;
  /** Line offset where the inserted text replaces the line up to the caret. */
  from: number;
  /** How much of the candidate name is already typed before `from` (in value characters). */
  kept: number;
};

/**
 * The completion that applies at `caret` in `line`, or `null` if none does
 * (the word expands a variable, is a `~user`, or is after a here-doc
 * operator). Only the text before the caret is looked at.
 */
export function completionContext(line: string, caret: number): CompletionContext | null {
  const before = line.slice(0, caret);
  const tokens = tokenize(before);
  let last = tokens[tokens.length - 1];
  const endsInWord = last?.kind === "word" && last.end === caret && !(last.quote === null && /[ \t]$/.test(before));
  let word: Word;
  if (endsInWord && last.kind === "word") {
    word = last;
    tokens.pop();
  } else {
    word = { kind: "word", start: caret, end: caret, value: "", quote: null, expands: false, cut: { raw: caret, value: 0 } };
  }
  last = tokens[tokens.length - 1];
  if (word.expands) return null;
  if (last?.kind === "op" && last.op === "<<") return null;

  // Find the command this word belongs to: the words since the last separator.
  let commandWords: Word[] = [];
  for (const token of tokens) {
    if (token.kind === "op") {
      if (SEPARATORS.has(token.op)) commandWords = [];
      else if (token.op !== ")") commandWords.push(REDIRECT_TARGET);
      continue;
    }
    commandWords.push(token);
  }
  // Skip assignments, prefix words and their options, and redirections.
  let commandName: string | undefined;
  let afterPrefix = false;
  let skipNext = false;
  for (const w of commandWords) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (w === REDIRECT_TARGET) {
      skipNext = true;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value)) continue;
    if (afterPrefix && w.value.startsWith("-")) continue;
    if (PREFIXES.has(w.value)) {
      afterPrefix = true;
      continue;
    }
    commandName = w.value;
    break;
  }
  const redirected = commandWords[commandWords.length - 1] === REDIRECT_TARGET;
  const isCommand = commandName === undefined && !redirected && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value);

  const value = word.value;
  if (value.startsWith("~") && !value.startsWith("~/") && value !== "~") return null;
  let kind: CompletionKind;
  if (isCommand) kind = value.includes("/") || value === "~" ? "executable" : "command";
  else kind = commandName !== undefined && DIR_COMMANDS.has(commandName) && !redirected ? "dir" : "path";

  if (kind === "command") {
    return { kind, word, dir: "", prefix: value, from: word.cut.raw, kept: word.cut.value };
  }
  // `~` alone: the home directory itself, completed to `~/`.
  if (value === "~") return { kind, word, dir: "~", prefix: "", from: caret, kept: 0 };
  const slash = value.lastIndexOf("/");
  const dir = value.slice(0, slash + 1);
  return { kind, word, dir, prefix: value.slice(dir.length), from: word.cut.raw, kept: word.cut.value - dir.length };
}

/** Stands in for the target of a redirection in the command's word list. */
const REDIRECT_TARGET: Word = {
  kind: "word",
  start: -1,
  end: -1,
  value: "",
  quote: null,
  expands: false,
  cut: { raw: -1, value: 0 },
};

/** A completion candidate: a name in its directory, or a command. */
export type Candidate = { name: string; dir: boolean };

/** Characters escaped with a backslash outside quotes. */
const SPECIAL = new Set([..." \t'\"$`\\!&|;<>()*?[]#{}"]);

/**
 * `text` as it must be typed: outside quotes with backslashes before shell
 * characters (and a `~` that starts the word, which would expand); inside
 * an open quote, only what would end or break that quote.
 */
export function escapeText(text: string, quote: Quote | null, atWordStart: boolean): string {
  if (quote === "'") return text.replace(/'/g, "'\\''");
  if (quote === '"') return text.replace(/["$`\\]/g, "\\$&");
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (SPECIAL.has(c) || (c === "~" && i === 0 && atWordStart)) out += "\\";
    out += c;
  }
  return out;
}

/** The longest common prefix of `names`; case-insensitive (keeping the first name's case) if `ignoreCase`. */
export function commonPrefix(names: readonly string[], ignoreCase = false): string {
  if (names.length === 0) return "";
  let prefix = names[0];
  for (const name of names) {
    let i = 0;
    while (
      i < prefix.length &&
      i < name.length &&
      (ignoreCase ? prefix[i].toLowerCase() === name[i].toLowerCase() : prefix[i] === name[i])
    ) {
      i++;
    }
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/**
 * The candidates starting with `prefix`, sorted by name and deduplicated:
 * case-sensitive matches, or if there are none the case-insensitive ones.
 * Names starting with `.` only when `prefix` does.
 */
export function filterCandidates(
  candidates: readonly Candidate[],
  prefix: string,
): { matches: Candidate[]; ignoreCase: boolean } {
  const visible = prefix.startsWith(".") ? candidates : candidates.filter((c) => !c.name.startsWith("."));
  let matches = visible.filter((c) => c.name.startsWith(prefix));
  let ignoreCase = false;
  if (matches.length === 0 && prefix) {
    const lower = prefix.toLowerCase();
    matches = visible.filter((c) => c.name.toLowerCase().startsWith(lower));
    ignoreCase = matches.length > 0;
  }
  const seen = new Set<string>();
  matches = matches
    .filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { matches, ignoreCase };
}

/** A line with its caret, after a completion. */
export type Edit = { value: string; caret: number };

/**
 * Replaces the typed part of the name with `text` (the candidate's name
 * from where the user's typing could be cut), escaped for where it goes,
 * then appends `suffix` and keeps whatever followed the caret.
 */
function insert(line: string, caret: number, context: CompletionContext, text: string, suffix: string): Edit {
  const atWordStart = context.from === context.word.start && context.word.quote === null;
  const inserted = escapeText(text, context.word.quote, atWordStart) + suffix;
  const value = line.slice(0, context.from) + inserted + line.slice(caret);
  return { value, caret: context.from + inserted.length };
}

/**
 * Inserts the one chosen candidate: a directory gets `/`; anything else a
 * space, after closing the quote the word opened.
 */
export function applyCandidate(line: string, caret: number, context: CompletionContext, candidate: Candidate): Edit {
  if (context.dir === "~" && context.word.value === "~") {
    return { value: line.slice(0, caret) + "/" + line.slice(caret), caret: caret + 1 };
  }
  const name = candidate.name.slice(context.kept);
  const quote = context.word.quote;
  const suffix = candidate.dir ? "/" : `${quote ?? ""} `;
  // No second space if one already follows.
  const after = line.slice(caret);
  const edit = insert(line, caret, context, name, after.startsWith(" ") && !candidate.dir ? suffix.trimEnd() : suffix);
  return after.startsWith(" ") && !candidate.dir ? { ...edit, caret: edit.caret + 1 } : edit;
}

/** Inserts the common prefix of the matches; `null` if it adds nothing to what is typed. */
export function applyPrefix(
  line: string,
  caret: number,
  context: CompletionContext,
  matches: readonly Candidate[],
  ignoreCase: boolean,
): Edit | null {
  const prefix = commonPrefix(
    matches.map((m) => m.name),
    ignoreCase,
  );
  const typed = context.prefix;
  // Longer than what is typed, or as long but fixing its case.
  if (prefix.length < typed.length || (prefix.length === typed.length && (!ignoreCase || prefix === typed))) return null;
  return insert(line, caret, context, prefix.slice(context.kept), "");
}

/** Shell builtins and keywords offered as command names next to PATH. */
export const BUILTINS: readonly string[] = [
  "alias",
  "bg",
  "bind",
  "break",
  "builtin",
  "cd",
  "command",
  "continue",
  "declare",
  "dirs",
  "disown",
  "echo",
  "eval",
  "exec",
  "exit",
  "export",
  "fc",
  "fg",
  "functions",
  "hash",
  "history",
  "jobs",
  "kill",
  "let",
  "local",
  "popd",
  "printf",
  "pushd",
  "pwd",
  "read",
  "readonly",
  "rehash",
  "return",
  "set",
  "setopt",
  "shift",
  "source",
  "test",
  "time",
  "trap",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "unsetopt",
  "wait",
  "which",
];
