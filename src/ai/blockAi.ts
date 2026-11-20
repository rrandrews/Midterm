import { aiCancel, aiStream, toAiError } from "../ipc/ai";
import { blockOutput, canReplay } from "../terminal/blockMode";
import type { Block } from "../terminal/blocks";
import { peekSession } from "../terminal/sessions";
import { type ContextBlock, type OutputLimits, formatBlock, parseSuggestion, redact } from "./context";
import { editorDraft, focusEditor, startEditorRequest } from "./editorRequests";
import { contextFor } from "./engine";
import { targetFor } from "./profiles";
import type { CmdRequest } from "./slash";

/*
 * "Explain this error/output" and "Fix this command" on a finished block
 * (see docs/ai.md#explain-and-fix). Both use the `explain` feature's model
 * profile. Explain streams Markdown into a note under the block
 * (src/ai/blockNotes.ts); Fix asks for one corrected command and puts it in
 * the blocks editor, never runs it (one request, not shown as it streams).
 */

export type BlockRequest = { system: string; prompt: string };

export const EXPLAIN_SYSTEM_PROMPT = [
  "You explain the result of a command a user ran in a terminal.",
  "From the shell, directory, earlier commands and the command with its output, explain briefly in Markdown:",
  "what went wrong (or what the output means, if nothing failed), the likely cause, and how to fix it.",
  "Put commands the user could run in fenced code blocks. Do not repeat the output back. Keep it short: a few sentences and at most a few commands.",
].join("\n");

export const FIX_SYSTEM_PROMPT = [
  "You fix a shell command that failed in a user's terminal.",
  "From the shell, directory, earlier commands and the failed command with its output, write the corrected command line.",
  "Reply with only that command on one line: no explanation, no quotes around it, no backticks, no leading $.",
  "If the command cannot be fixed by changing it (or nothing is wrong with it), reply with nothing.",
].join("\n");

/** How much of the block in question's output is sent: more than for context blocks. */
export const EXPLAIN_OUTPUT_LIMITS: OutputLimits = { head: 40, tail: 80, chars: 12000 };
/** Reply budgets. */
export const EXPLAIN_MAX_TOKENS = 1200;
export const FIX_MAX_TOKENS = 400;

function withBlock(body: string, block: ContextBlock, question: string): string {
  // `(in cwd)` always: the body's directory may be the prompt's, not the block's.
  const shown = formatBlock(block, undefined, EXPLAIN_OUTPUT_LIMITS);
  return redact(`${body}\n\nThe command in question:\n\n${shown}\n\n${question}`);
}

/** The Explain request: the context before the block, the block (output trimmed generously), "Explain:". */
export function buildExplainRequest(body: string, block: ContextBlock): BlockRequest {
  return { system: EXPLAIN_SYSTEM_PROMPT, prompt: withBlock(body, block, "Explain:") };
}

/** The Fix request: as Explain, ending in "Corrected command:". */
export function buildFixRequest(body: string, block: ContextBlock): BlockRequest {
  return { system: FIX_SYSTEM_PROMPT, prompt: withBlock(body, block, "Corrected command:") };
}

/** A block as a request shows it, its directory `host:path` when remote. */
export function contextBlockOf(paneId: string, block: Block): ContextBlock | null {
  const session = peekSession(paneId);
  if (!session) return null;
  return {
    command: block.command,
    exitCode: block.exitCode,
    output: blockOutput(session, block),
    cwd: block.host ? `${block.host}:${block.cwd ?? "?"}` : block.cwd,
  };
}

/** The request for Explain on `block`, or null when its pane is gone. */
export async function explainRequest(paneId: string, block: Block): Promise<BlockRequest | null> {
  const context = await contextFor(paneId, { block });
  const shown = contextBlockOf(paneId, block);
  return context && shown ? buildExplainRequest(context.body, shown) : null;
}

export const NO_MODEL_MESSAGE = "Choose a model for Explain and fix in Settings → AI.";

let counter = 0;

/**
 * Asks for the corrected command of a failed block. Rejects with an
 * `AiError` (`other` without a ready profile, `empty` when there is no fix).
 */
export function fixCommand(paneId: string, block: Block): CmdRequest {
  const requestId = `fix-${paneId}-${++counter}`;
  let cancelled = false;
  const result = (async () => {
    const target = targetFor("explain");
    if (!target) throw { kind: "other", message: NO_MODEL_MESSAGE };
    const context = await contextFor(paneId, { block });
    const shown = contextBlockOf(paneId, block);
    if (!context || !shown) throw { kind: "other", message: "This terminal is not available." };
    if (cancelled) throw { kind: "cancelled", message: "Cancelled" };
    const request = buildFixRequest(context.body, shown);
    // Through the streaming path for its stop reason: a fix cut off at the
    // token limit may still parse as a command, minus what matters.
    const reply = await aiStream({ requestId, target, system: request.system, prompt: request.prompt, maxTokens: FIX_MAX_TOKENS }, () => {});
    if (reply.stop === "length") throw { kind: "other", message: "The fix was cut off at the token limit." };
    const command = parseSuggestion(reply.text);
    if (!command) throw { kind: "empty", message: "The model has no fix for this command." };
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

/** Whether Fix applies to a block now: it failed, and its shell waits at a prompt. */
export function canFix(paneId: string, block: Block): boolean {
  const session = peekSession(paneId);
  const failed = block.exitCode !== undefined && block.exitCode !== 0;
  return !!session && failed && canReplay(session, block) && editorDraft(paneId) !== undefined;
}

/** Fix: the corrected command lands in the blocks editor (whose draft comes back on an error or Esc). */
export function fixBlock(paneId: string, block: Block): void {
  if (!canFix(paneId, block)) return;
  startEditorRequest(paneId, {
    line: `fix: ${block.command}`,
    restore: editorDraft(paneId) ?? "",
    busy: "fixing the command… esc cancels",
    run: () => fixCommand(paneId, block),
  });
  focusEditor(paneId);
}
