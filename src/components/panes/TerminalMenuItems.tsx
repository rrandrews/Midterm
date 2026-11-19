import { copyText, pasteText } from "../../ipc/clipboard";
import {
  canRun,
  contextBlockOf,
  copyBlockCommand,
  copyBlockOutput,
  hasIntegration,
  requestedMode,
  runFromBlocks,
  toggleBlocks,
} from "../../terminal/blockMode";
import { peekSession } from "../../terminal/sessions";
import { MenuItem, MenuSeparator } from "../ui/Menu";

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

/** Right-click commands for a terminal pane. Mounted only while the menu is open. */
export function TerminalMenuItems({ paneId }: { paneId: string }) {
  const session = peekSession(paneId);
  const blocks = requestedMode(paneId) === "blocks";
  const integration = hasIntegration(paneId);
  // In blocks mode text is selected in the page, not in the terminal.
  // Right-clicking a word in the terminal selects it (xterm's default on
  // macOS), so Copy usually has something to copy.
  const selection = (blocks && window.getSelection()?.toString()) || session?.selection || "";
  const block = session && blocks ? contextBlockOf(session) : undefined;

  return (
    <>
      {session && block && (
        <>
          <MenuItem disabled={!block.command} onSelect={() => copyBlockCommand(block)}>
            Copy command
          </MenuItem>
          <MenuItem disabled={!block.end} onSelect={() => copyBlockOutput(session, block)}>
            Copy output
          </MenuItem>
          <MenuItem
            disabled={!block.command || !canRun(session)}
            onSelect={() => runFromBlocks(session, block.command)}
          >
            Run again
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      <MenuItem shortcut="⌘C" disabled={!selection} onSelect={() => void copyText(selection)}>
        Copy
      </MenuItem>
      <MenuItem
        shortcut="⌘V"
        disabled={!session}
        onSelect={() => void pasteText().then((text) => paste(paneId, text))}
      >
        Paste
      </MenuItem>
      <MenuItem disabled={!session} onSelect={() => session?.selectAll()}>
        Select all
      </MenuItem>
      <MenuItem disabled={!session} onSelect={() => session?.clear()}>
        Clear
      </MenuItem>
      <MenuSeparator />
      <MenuItem checked={blocks && integration !== false} onSelect={() => toggleBlocks(paneId)}>
        {integration === false ? "Blocks mode (no shell integration)" : "Blocks mode"}
      </MenuItem>
    </>
  );
}
