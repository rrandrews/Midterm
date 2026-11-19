import { activePaneId, updatePaneData } from "../actions";
import { registerCommands } from "../commands/registry";
import { copyText } from "../ipc/clipboard";
import { focusPane } from "../layout/dock";
import { getSettings } from "../settings/settings";
import { findPane } from "../state/layout";
import { findTabOfPane, useAppStore } from "../state/store";
import type { PaneData } from "../state/types";
import { rowsText } from "./blockRender";
import { type Block, outputRows } from "./blocks";
import { recordCommand } from "./history";
import type { TerminalSession } from "./session";
import { peekSession } from "./sessions";

/*
 * Per-pane blocks/classic mode and the block actions shared by the blocks
 * view, the terminal's right-click menu and the command registry.
 */

export type TerminalMode = NonNullable<PaneData["terminalMode"]>;

function paneData(paneId: string): PaneData | undefined {
  const tab = findTabOfPane(useAppStore.getState(), paneId);
  return tab && findPane(tab.layout, paneId)?.data;
}

/** The mode a terminal pane asks for: its own, else the `terminalMode` setting. */
export function requestedMode(paneId: string): TerminalMode {
  return paneData(paneId)?.terminalMode ?? getSettings().terminalMode;
}

/** Switches a terminal pane between blocks and classic rendering. */
export function toggleBlocks(paneId: string): void {
  const data = paneData(paneId);
  if (data?.kind !== "terminal") return;
  updatePaneData(paneId, { terminalMode: requestedMode(paneId) === "blocks" ? "classic" : "blocks" });
  // The focus target (input editor or terminal) changes with the mode.
  requestAnimationFrame(() => focusPane(paneId));
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

/** Runs a command line from the blocks view (input editor or re-run). */
export function runFromBlocks(session: TerminalSession, command: string): void {
  if (!command.trim() || !canRun(session)) return;
  if (session.runCommand(command)) recordCommand(command);
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

function activeTerminal(): string | undefined {
  const id = activePaneId();
  return id && paneData(id)?.kind === "terminal" ? id : undefined;
}

registerCommands([
  {
    id: "terminal.toggleBlocks",
    title: "Toggle blocks mode",
    category: "Terminal",
    run: () => {
      const id = activeTerminal();
      if (id) toggleBlocks(id);
    },
    enabled: () => activeTerminal() !== undefined,
  },
]);
