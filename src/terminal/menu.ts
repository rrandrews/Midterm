import { aiMenuItems } from "../ai/commands";
import { copyText, pasteText } from "../ipc/clipboard";
import type { MenuItemSpec } from "../plugins/types";
import {
  contextBlockOf,
  copyBlockCommand,
  copyBlockOutput,
  hasIntegration,
  otherTerminalKind,
  requestedMode,
  canReplay,
  replayBlock,
  toggleBlocks,
} from "./blockMode";
import { peekSession } from "./sessions";

/** Pastes into the blocks input editor if it is showing, else into the terminal. */
function paste(paneId: string, text: string): void {
  if (!text) return;
  const editor = document.querySelector<HTMLTextAreaElement>(`[data-pane-id="${CSS.escape(paneId)}"] .blocks-input-text`);
  if (editor) {
    editor.focus();
    // Through the editing pipeline, so it can be undone and React sees it.
    document.execCommand("insertText", false, text);
  } else peekSession(paneId)?.paste(text);
}

/** Right-click items of a terminal pane. Built when the menu opens. */
export function terminalMenu(paneId: string): MenuItemSpec[] {
  const session = peekSession(paneId);
  const blocks = requestedMode(paneId) === "blocks";
  const integration = hasIntegration(paneId);
  // In blocks mode text is selected in the page, not in the terminal.
  // Right-clicking a word in the terminal selects it (xterm's default on
  // macOS), so Copy usually has something to copy.
  const selection = (blocks && window.getSelection()?.toString()) || session?.selection || "";
  const block = session && blocks ? contextBlockOf(session) : undefined;
  const items: MenuItemSpec[] = [];
  if (session && block) {
    items.push(
      { label: "Copy command", disabled: !block.command, run: () => copyBlockCommand(block) },
      { label: "Copy output", disabled: !block.end, run: () => copyBlockOutput(session, block) },
      { label: "Run again", disabled: !canReplay(session, block), run: () => replayBlock(session, block) },
      { type: "separator" },
    );
  }
  items.push(
    { label: "Copy", shortcut: "⌘C", disabled: !selection, run: () => copyText(selection) },
    { label: "Paste", shortcut: "⌘V", disabled: !session, run: () => pasteText().then((text) => paste(paneId, text)) },
    { label: "Select all", disabled: !session, run: () => session?.selectAll() },
    { label: "Clear", disabled: !session, run: () => session?.clear() },
  );
  if (otherTerminalKind(paneId)) {
    const label = blocks
      ? "Switch to classic terminal"
      : integration === false
        ? "Switch to block terminal (no shell integration)"
        : "Switch to block terminal";
    items.push({ type: "separator" }, { label, commandId: "terminal.toggleBlocks", run: () => toggleBlocks(paneId) });
  }
  if (blocks && integration !== false) items.push(...aiMenuItems(paneId));
  return items;
}
