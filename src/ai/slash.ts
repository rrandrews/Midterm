import { aiCancel, aiSuggest, toAiError } from "../ipc/ai";
import { parseSuggestion, redact } from "./context";
import { contextFor } from "./engine";
import { targetFor } from "./profiles";

/*
 * Slash commands in the blocks input editor: a line starting with a
 * registered `/name` is handled by Midterm instead of going to the shell.
 * Anything else that starts with `/` (`/usr/bin/ls`) runs as usual.
 */

export type SlashCommand = {
  name: string;
  /** Shown as the completion hint, e.g. `/cmd <what to do>`. */
  usage: string;
  description: string;
};

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "cmd", usage: "/cmd <what to do>", description: "AI writes a command for it" },
  { name: "agent", usage: "/agent <task>", description: "the agent does it, working with this terminal" },
];

/**
 * What a slash command other than `/cmd` does, registered from `installAi`
 * so this module stays free of the agent's dependencies. Returns an error
 * message to show (e.g. a missing task), or nothing.
 */
export type SlashHandler = (paneId: string, args: string) => string | void;

const handlers = new Map<string, SlashHandler>();

export function registerSlashHandler(name: string, handler: SlashHandler): () => void {
  handlers.set(name, handler);
  return () => {
    if (handlers.get(name) === handler) handlers.delete(name);
  };
}

export function slashHandler(name: string): SlashHandler | undefined {
  return handlers.get(name);
}

export type ParsedSlash = { command: SlashCommand; args: string };

/** The slash command on `line`, if its name is a registered one. */
export function parseSlash(line: string): ParsedSlash | null {
  const match = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (!match) return null;
  const command = SLASH_COMMANDS.find((entry) => entry.name === match[1]);
  return command ? { command, args: (match[2] ?? "").trim() } : null;
}

/** The slash command `value` is the start of (`/c` → `/cmd`), for the ghost text. */
export function slashCompletion(value: string): SlashCommand | undefined {
  if (!/^\/[A-Za-z-]*$/.test(value)) return undefined;
  return SLASH_COMMANDS.find((entry) => `/${entry.name}`.startsWith(value));
}

export const CMD_SYSTEM_PROMPT = [
  "You write shell commands for a user working in a terminal.",
  "The user describes a task; from the shell, directory and recent commands with their output, write the single command line that does it.",
  "Reply with only that command on one line: no explanation, no quotes around it, no backticks, no leading $.",
  "Use tools that are standard on the user's OS and shell. Chain with && or pipes when one line needs several steps.",
  "Prefer safe commands; if the task is destructive, write the command exactly as asked and nothing more.",
  "If the task cannot be done with a command, reply with nothing.",
].join("\n");

/** The request for `/cmd`: the terminal's context body, then the task. */
export function buildCmdRequest(body: string, task: string): { system: string; prompt: string } {
  return { system: CMD_SYSTEM_PROMPT, prompt: `${body}\n\nTask: ${redact(task.trim())}\n\nCommand:` };
}

/** Reply budget: one command line, possibly a long pipeline. */
const CMD_MAX_TOKENS = 400;

let counter = 0;

export type CmdRequest = { result: Promise<string>; cancel: () => void };

/**
 * Asks the model for a command doing `task` in the pane's context. Rejects
 * with an `AiError` (kind `other` when `/cmd` has no ready model profile,
 * `empty` when there is no usable command). Needs a profile, but not the
 * suggestions switch: this is asked for explicitly.
 */
export function writeCommand(paneId: string, task: string): CmdRequest {
  const requestId = `cmd-${paneId}-${++counter}`;
  let cancelled = false;
  const result = (async () => {
    const target = targetFor("cmd");
    if (!target) throw { kind: "other", message: "Choose a model for /cmd in Settings → AI." };
    const context = await contextFor(paneId);
    if (!context) throw { kind: "other", message: "This terminal is not available." };
    if (cancelled) throw { kind: "cancelled", message: "Cancelled" };
    const request = buildCmdRequest(context.body, task);
    const { text } = await aiSuggest({
      requestId,
      target,
      system: request.system,
      prompt: request.prompt,
      maxTokens: CMD_MAX_TOKENS,
    });
    const command = parseSuggestion(text);
    if (!command) throw { kind: "empty", message: "The model did not suggest a command." };
    return command;
  })().catch((error: unknown) => {
    throw toAiError(error);
  });
  return {
    result,
    cancel: () => {
      cancelled = true;
      void aiCancel(requestId).catch(() => {});
    },
  };
}
