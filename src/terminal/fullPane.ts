import { matchesForeground } from "./solidBackground";

/*
 * Programs the block terminal runs full-pane: while one runs, the pane shows
 * the classic terminal, as it does for a program on the alternate screen.
 * For TUIs that draw inline (no alternate screen) and break inside a block.
 * Pure; unit-tested.
 */

/** Words that run the command after them, with the options of theirs that take a value. */
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"]),
  env: new Set(["-u", "-C", "-S", "-P"]),
  nice: new Set(["-n"]),
  exec: new Set(["-a"]),
  command: new Set(),
  builtin: new Set(),
  nohup: new Set(),
  time: new Set(),
  caffeinate: new Set(["-t", "-w"]),
};

type Segment = { words: string[]; conditional: boolean };

/**
 * Splits a command line into simple commands at unquoted `;`, `&`, `&&`,
 * `||`, `|` and newlines, each a list of words with quotes removed.
 * `conditional`: it follows `||`, so it may never run.
 */
function segments(line: string): Segment[] {
  const out: Segment[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let conditional = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = (nextConditional: boolean) => {
    endWord();
    if (words.length) out.push({ words, conditional });
    words = [];
    conditional = nextConditional;
  };
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (char === "|" && line[i + 1] === "|") {
      endSegment(true);
      i++;
    } else if (char === ";" || char === "&" || char === "|" || char === "\n") {
      if (char === "&" && line[i + 1] === "&") i++;
      endSegment(false);
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  endSegment(false);
  return out;
}

/** The program a simple command runs: its first word after `VAR=x` assignments and wrappers (with their options). */
function programOf(words: readonly string[]): string | undefined {
  let options: ReadonlySet<string> | undefined;
  let wrapper: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word) continue;
    if (options && word.startsWith("-")) {
      // `command -v name` looks a program up; it does not run it.
      if (wrapper === "command" && (word === "-v" || word === "-V")) return undefined;
      if (options.has(word)) i++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (word in WRAPPERS) {
      wrapper = word;
      options = WRAPPERS[word];
      continue;
    }
    return word;
  }
  return undefined;
}

/**
 * The programs a command line runs, in order: the first word of each
 * simple command, quote-aware. Commands after `||` are left out (they run
 * only if what precedes fails; the foreground lookup catches them).
 */
export function commandPrograms(command: string): string[] {
  const programs: string[] = [];
  for (const segment of segments(command)) {
    if (segment.conditional) continue;
    const program = programOf(segment.words);
    if (program) programs.push(program);
  }
  return programs;
}

export type FullPaneInputs = {
  /** The listed programs. */
  programs: readonly string[];
  /** The command line of the running block, if a command is running. */
  command: string | undefined;
  /** The terminal's foreground program name, if known. */
  foregroundName: string | undefined;
};

/**
 * Whether a listed program is running: by the command line (at once, before
 * any output) or by the foreground process (once looked up).
 */
export function runsFullPane({ programs, command, foregroundName }: FullPaneInputs): boolean {
  if (!programs.length || command === undefined) return false;
  return commandPrograms(command).some((program) => matchesForeground(program, programs)) || matchesForeground(foregroundName, programs);
}
