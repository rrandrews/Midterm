/*
 * What a suggestion request sends: a system prompt and a plain-text prompt
 * built from the terminal's recent history. Pure; secrets that look like
 * secrets are redacted before anything leaves the machine. "Preview what is
 * sent" in Settings → AI shows exactly this text.
 */

export type ContextBlock = {
  command: string;
  exitCode: number | undefined;
  /** The block's output as plain text. */
  output: string;
  cwd?: string;
};

export type ContextInput = {
  os: string;
  shell?: string;
  cwd?: string;
  branch?: string | null;
  /** Finished blocks, oldest first (the caller limits how many). */
  blocks: readonly ContextBlock[];
  /** Earlier commands of the same terminal, oldest first. */
  recentCommands: readonly string[];
};

export type BuiltContext = { system: string; prompt: string };

/** Output lines kept from the start and the end of a block. */
export const OUTPUT_HEAD_LINES = 15;
export const OUTPUT_TAIL_LINES = 25;
/** Characters kept per output line, per block's output, and per command. */
export const LINE_CHARS = 240;
export const OUTPUT_CHARS = 3000;
export const COMMAND_CHARS = 500;
export const RECENT_COMMANDS = 20;

export const SYSTEM_PROMPT = [
  "You suggest the next command for a user working in a terminal.",
  "From the shell, directory and recent commands with their output, predict the single command the user most likely wants to run next.",
  "Reply with only that command on one line: no explanation, no quotes, no backticks, no leading $.",
  "Prefer short, safe commands. Never suggest destructive commands (rm -rf, force pushes, dropping data) unless the history clearly leads there.",
  "If there is no useful suggestion, reply with nothing.",
].join("\n");

const REDACTED = "[redacted]";

/** Patterns for likely secrets. Each match (or its group 2, when present) is replaced. */
const SECRET_PATTERNS: RegExp[] = [
  // PEM private keys, whole block.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Well-known token shapes.
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** `NAME_SECRET=value`, `export API_KEY="…"`, `password: …`, `--token value`, `Bearer …`, URL credentials: keep the name, drop the value. */
const ASSIGNMENT_PATTERNS: RegExp[] = [
  /(\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi,
  /(--?(?:password|passwd|token|secret|api-key|apikey|auth-token|access-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi,
  /(\b(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{8,})/g,
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(?=@)/gi,
];

/** `text` with likely secrets replaced by `[redacted]`. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  for (const pattern of ASSIGNMENT_PATTERNS) {
    out = out.replace(pattern, (match, name: string, value: string) => (value === REDACTED ? match : `${name}${REDACTED}`));
  }
  return out;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * A block's output cut to its head and tail, long lines clipped, ANSI and
 * trailing blank lines dropped. Redacted before it is cut, so a secret
 * that straddles a cut (a private key's header dropped, its body kept) is
 * still recognised.
 */
export function trimOutput(output: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what is stripped
  const plain = redact(output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\r/g, ""));
  const lines = plain.split("\n").map((line) => clip(line.trimEnd(), LINE_CHARS));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  let kept = lines;
  if (lines.length > OUTPUT_HEAD_LINES + OUTPUT_TAIL_LINES) {
    const skipped = lines.length - OUTPUT_HEAD_LINES - OUTPUT_TAIL_LINES;
    kept = [...lines.slice(0, OUTPUT_HEAD_LINES), `… (${skipped} lines omitted)`, ...lines.slice(-OUTPUT_TAIL_LINES)];
  }
  let text = kept.join("\n");
  if (text.length > OUTPUT_CHARS) {
    const half = Math.floor(OUTPUT_CHARS / 2);
    text = `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
  }
  return text;
}

export function buildContext(input: ContextInput): BuiltContext {
  const parts: string[] = [];
  const facts = [`OS: ${input.os}`];
  if (input.shell) facts.push(`Shell: ${input.shell}`);
  if (input.cwd) facts.push(`Working directory: ${input.cwd}`);
  if (input.branch) facts.push(`Git branch: ${input.branch}`);
  parts.push(facts.join("\n"));

  const inBlocks = new Set(input.blocks.map((block) => block.command));
  const recent: string[] = [];
  for (let i = input.recentCommands.length - 1; i >= 0 && recent.length < RECENT_COMMANDS; i--) {
    const command = input.recentCommands[i].trim();
    if (command && !inBlocks.has(command) && !recent.includes(command)) recent.unshift(command);
  }
  if (recent.length) parts.push(`Earlier commands (oldest first):\n${recent.map((c) => clip(c, COMMAND_CHARS)).join("\n")}`);

  if (input.blocks.length) {
    const blocks = input.blocks.map((block) => {
      const lines = [`$ ${clip(block.command.trim(), COMMAND_CHARS)}`];
      if (block.cwd && block.cwd !== input.cwd) lines.push(`(in ${block.cwd})`);
      const output = trimOutput(block.output);
      if (output) lines.push(output);
      lines.push(block.exitCode === undefined ? "[exit status unknown]" : `[exit ${block.exitCode}]`);
      return lines.join("\n");
    });
    parts.push(`Last commands and their output (oldest first):\n\n${blocks.join("\n\n")}`);
  } else parts.push("No commands have been run in this terminal yet.");

  parts.push("Next command:");
  return { system: SYSTEM_PROMPT, prompt: redact(parts.join("\n\n")) };
}

/** A model's reply as a single command line, or null when it has none. */
export function parseSuggestion(reply: string): string | null {
  let text = reply.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  let command = line.replace(/^`+|`+$/g, "").trim();
  command = command.replace(/^\$\s+/, "");
  if (!command || command.length > COMMAND_CHARS) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) return null;
  return command;
}
