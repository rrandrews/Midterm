import { activePaneId, setPaneKind } from "../actions";
import { copyText } from "../ipc/clipboard";
import { activePlugin } from "../plugins/registry";
import { findPane } from "../state/layout";
import { findTabOfPane, useAppStore } from "../state/store";
import { rowsText } from "./blockRender";
import { type Block, outputRows, scopeOf } from "./blocks";
import { recordCommand } from "./history";
import type { TerminalSession } from "./session";
import { peekSession } from "./sessions";
import { BLOCK_TERMINAL, CLASSIC_TERMINAL, isSessionKind } from "./kinds";
import type { TerminalData, TerminalMode } from "./settings";

/*
 * Classic vs block terminal, and the block actions shared by the blocks
 * view, the terminal's right-click menu and the command registry.
 */

export type { TerminalMode };

function paneData(paneId: string): TerminalData | undefined {
  const tab = findTabOfPane(useAppStore.getState(), paneId);
  return tab && (findPane(tab.layout, paneId)?.data as TerminalData | undefined);
}

/** How a terminal pane renders: blocks for a block terminal, else classic. */
export function requestedMode(paneId: string): TerminalMode {
  return paneData(paneId)?.kind === BLOCK_TERMINAL ? "blocks" : "classic";
}

/** The other built-in terminal kind, if the pane is a terminal and that plugin is enabled. */
export function otherTerminalKind(paneId: string): string | undefined {
  const kind = paneData(paneId)?.kind;
  if (!isSessionKind(kind)) return undefined;
  const other = kind === BLOCK_TERMINAL ? CLASSIC_TERMINAL : BLOCK_TERMINAL;
  return activePlugin(other) ? other : undefined;
}

/**
 * Switches a terminal pane between the classic and block terminal. The
 * pane keeps its shell and scrollback (sessions are kept by pane id).
 */
export function toggleBlocks(paneId: string): void {
  const other = otherTerminalKind(paneId);
  if (other) setPaneKind(paneId, other);
}

/** Whether the pane's shell reports prompts, which blocks mode needs. `undefined` until known. */
export function hasIntegration(paneId: string): boolean | undefined {
  const integration = peekSession(paneId)?.blocks.snapshot().integration;
  return integration === "present" ? true : integration === "absent" ? false : undefined;
}

/** A block's output as plain text. */
export function blockOutput(session: TerminalSession, block: Block): string {
  const rows = outputRows(block, session.blocks.buffer);
  return rows ? rowsText(session.blocks.buffer, rows.from, rows.to, session.cols, rows.lastCells) : "";
}

/** Whether the shell is waiting at a prompt, so a command can be sent. */
export function canRun(session: TerminalSession): boolean {
  const snap = session.blocks.snapshot();
  return snap.integration === "present" && snap.phase === "prompt" && !snap.altScreen;
}

/**
 * Runs a command line from the blocks view (input editor, a skill). With
 * `scope`, only if the prompt still belongs to that shell: a line composed
 * at a remote prompt is not sent to the local shell after ssh ended.
 */
export function runFromBlocks(session: TerminalSession, command: string, scope?: string): void {
  if (!command.trim() || !canRun(session)) return;
  if (scope !== undefined && session.blocks.scope !== scope) return;
  // A nested shell's commands (over ssh) stay out of this machine's history.
  const root = !session.blocks.snapshot().nested;
  if (session.runCommand(command) && root) recordCommand(command);
}

/**
 * Whether a block's command can be run again now: the shell is at a prompt
 * and it is the shell that ran it (never a remote command in the local
 * shell, or the other way round).
 */
export function canReplay(session: TerminalSession, block: Block): boolean {
  return !!block.command && canRun(session) && scopeOf(block.nested, block) === session.blocks.scope;
}

/** "Run again", checked at the moment it runs. */
export function replayBlock(session: TerminalSession, block: Block): void {
  if (canReplay(session, block)) runFromBlocks(session, block.command);
}

export const copyBlockCommand = (block: Block) => void copyText(block.command);
export const copyBlockOutput = (session: TerminalSession, block: Block) => void copyText(blockOutput(session, block));

/*
 * The block under the last right-click, for the terminal's context menu.
 * The blocks view resets it at the start of every right-click (capture
 * phase) and the block sets it on the way back up.
 */
let contextBlock: { paneId: string; blockId: number } | null = null;

export function setContextBlock(paneId: string, blockId: number | null): void {
  contextBlock = blockId === null ? null : { paneId, blockId };
}

export function contextBlockOf(session: TerminalSession): Block | undefined {
  if (contextBlock?.paneId !== session.paneId) return undefined;
  const id = contextBlock.blockId;
  return session.blocks.snapshot().blocks.find((block) => block.id === id);
}

/** The active pane, if it is a built-in terminal. */
export function activeTerminal(): string | undefined {
  const id = activePaneId();
  return id && isSessionKind(paneData(id)?.kind) ? id : undefined;
}
