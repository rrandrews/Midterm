/*
 * Local next-command prediction. Pure: given a log of command pairs (a
 * command, then the next command run in the same terminal) and the command
 * just run, finds the likely follow-up without asking a model.
 *
 * Three levels of matching, from strict to loose:
 * - exact: the logged command is the same line;
 * - template: same program and shape, and every token that differs is an
 *   argument the next command reused (`mkdir foo` → `cd foo` predicts
 *   `cd bar` after `mkdir bar`). Quoted tokens may differ freely
 *   (`git commit -m "…"` → `git push`);
 * - last argument: same program, and the logged command's last argument
 *   carried over into the next one (`mkdir -p foo` → `cd foo` predicts
 *   `cd bar` after `mkdir bar`).
 *
 * A candidate is offered only with enough support and a large enough share
 * of the weighted matches. Recent pairs weigh more.
 */

export type CommandPair = readonly [previous: string, next: string];

export type Prediction = {
  command: string;
  /** The candidate's share of the weighted matches (0–1). */
  share: number;
  /** How many logged pairs back it. */
  support: number;
};

export type PredictOptions = {
  /** Fewest pairs that must back a candidate. */
  minSupport?: number;
  /** Smallest share of the weighted matches a candidate must have. */
  minShare?: number;
  /** Pairs back from the newest at which a pair weighs half. */
  halfLife?: number;
};

export const MIN_SUPPORT = 2;
export const MIN_SHARE = 0.5;
export const HALF_LIFE = 1000;

/** How much each level counts. */
const LEVEL_WEIGHT = { exact: 1, template: 0.8, lastArg: 0.5 } as const;

/** A word: its value (quotes and escapes removed), whether it was quoted, and its text as written. */
export type Token = { text: string; quoted: boolean; raw: string };

/**
 * Splits a command line into words, shell-like: whitespace separates,
 * quotes group (and mark the word as quoted), a backslash escapes the next
 * character. Operators stay attached to whatever they touch; good enough
 * for matching.
 */
export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  let quoted = false;
  let inWord = false;
  let start = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    if (!inWord && !quote && !/\s/.test(line[i])) start = i;
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) text += line[++i];
      else text += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      inWord = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      text += line[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) tokens.push({ text, quoted, raw: line.slice(start, i) });
      text = "";
      quoted = false;
      inWord = false;
    } else {
      text += ch;
      inWord = true;
    }
  }
  if (inWord) tokens.push({ text, quoted, raw: line.slice(start) });
  return tokens;
}

/** Quotes a word for the shell if it needs it. */
function shellWord(word: string): string {
  if (word !== "" && /^[A-Za-z0-9_@%+=:,./~-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * `next` with the arguments of `from` replaced by those of `to`, token by
 * token (a token equal to the argument, or a path inside it). `null` if a
 * substitution would leave the line ambiguous.
 */
function substitute(next: Token[], swaps: Map<string, string>): string | null {
  if (swaps.size === 0) return null;
  const out: string[] = [];
  for (const token of next) {
    let text = token.text;
    for (const [from, to] of swaps) {
      if (text === from) {
        text = to;
        break;
      }
      if (text.startsWith(`${from}/`)) {
        text = to + text.slice(from.length);
        break;
      }
    }
    // Untouched words stay exactly as written (`"$HOME/x"` keeps its expansion).
    out.push(text === token.text ? token.raw : shellWord(text));
  }
  return out.join(" ");
}

/** Whether a token appears in `next` as a word or a path prefix. */
function carried(word: string, next: Token[]): boolean {
  return next.some((token) => token.text === word || token.text.startsWith(`${word}/`));
}

/**
 * The template-level candidate: same program and token count, and each
 * differing token is quoted (free text) or carried over into the next
 * command. Returns the next command adapted to `last`, or `null`.
 */
function templateMatch(prev: Token[], next: Token[], last: Token[]): string | null {
  if (prev.length !== last.length || prev.length < 2 || prev[0].text !== last[0].text) return null;
  const swaps = new Map<string, string>();
  let differs = false;
  for (let i = 1; i < prev.length; i++) {
    const a = prev[i];
    const b = last[i];
    if (a.text === b.text) continue;
    differs = true;
    if (carried(a.text, next)) {
      if (a.text.startsWith("-") || b.text.startsWith("-")) return null; // flags are not arguments
      if (swaps.has(a.text) && swaps.get(a.text) !== b.text) return null;
      swaps.set(a.text, b.text);
    } else if (!(a.quoted && b.quoted)) {
      return null;
    }
  }
  if (!differs) return null; // that is an exact match
  if (swaps.size === 0) return next.map((token) => token.raw).join(" ");
  return substitute(next, swaps);
}

/** The last-argument candidate: same program, the last argument carried over. */
function lastArgMatch(prev: Token[], next: Token[], last: Token[]): string | null {
  if (prev.length < 2 || last.length < 2 || prev[0].text !== last[0].text) return null;
  const from = prev[prev.length - 1].text;
  const to = last[last.length - 1].text;
  if (from === to || from.startsWith("-") || to.startsWith("-") || !carried(from, next)) return null;
  return substitute(next, new Map([[from, to]]));
}

/**
 * The most likely command to follow `last`, or `null` when nothing in the
 * log clears the thresholds. `pairs` is oldest first.
 */
export function predictNext(
  pairs: readonly CommandPair[],
  last: string,
  options: PredictOptions = {},
  tokens: (line: string) => Token[] = tokenize,
): Prediction | null {
  const minSupport = options.minSupport ?? MIN_SUPPORT;
  const minShare = options.minShare ?? MIN_SHARE;
  const halfLife = options.halfLife ?? HALF_LIFE;
  const lastLine = last.trim();
  if (!lastLine) return null;
  const lastTokens = tokens(lastLine);
  if (lastTokens.length === 0) return null;

  const scores = new Map<string, { score: number; support: number }>();
  let total = 0;
  for (let i = pairs.length - 1; i >= 0; i--) {
    const [prev, next] = pairs[i];
    const recency = 0.5 ** ((pairs.length - 1 - i) / halfLife);
    let candidate: string | null = null;
    let weight = 0;
    if (prev === lastLine) {
      candidate = next;
      weight = LEVEL_WEIGHT.exact;
    } else {
      const prevTokens = tokens(prev);
      if (prevTokens[0]?.text !== lastTokens[0].text) continue;
      const nextTokens = tokens(next);
      candidate = templateMatch(prevTokens, nextTokens, lastTokens);
      weight = LEVEL_WEIGHT.template;
      if (candidate === null) {
        candidate = lastArgMatch(prevTokens, nextTokens, lastTokens);
        weight = LEVEL_WEIGHT.lastArg;
      }
      // Same program, but nothing to learn from this pair: it still counts
      // against the candidates (the program is followed by many things).
      if (candidate === null) {
        total += recency * LEVEL_WEIGHT.lastArg * 0.5;
        continue;
      }
    }
    const value = recency * weight;
    total += value;
    const entry = scores.get(candidate) ?? { score: 0, support: 0 };
    entry.score += value;
    entry.support += 1;
    scores.set(candidate, entry);
  }

  let best: Prediction | null = null;
  for (const [command, { score, support }] of scores) {
    const share = total > 0 ? score / total : 0;
    if (support < minSupport || share < minShare) continue;
    if (!best || share > best.share) best = { command, share, support };
  }
  return best;
}
