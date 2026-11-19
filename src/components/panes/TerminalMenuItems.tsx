import { copyText, pasteText } from "../../ipc/clipboard";
import { peekSession } from "../../terminal/sessions";
import { MenuItem } from "../ui/Menu";

/** Right-click commands for a terminal pane. Mounted only while the menu is open. */
export function TerminalMenuItems({ paneId }: { paneId: string }) {
  const session = peekSession(paneId);
  // Right-clicking a word selects it (xterm's default on macOS), so Copy
  // usually has something to copy.
  const selection = session?.selection ?? "";

  return (
    <>
      <MenuItem shortcut="⌘C" disabled={!selection} onSelect={() => void copyText(selection)}>
        Copy
      </MenuItem>
      <MenuItem
        shortcut="⌘V"
        disabled={!session}
        onSelect={() => void pasteText().then((text) => session?.paste(text))}
      >
        Paste
      </MenuItem>
      <MenuItem disabled={!session} onSelect={() => session?.selectAll()}>
        Select all
      </MenuItem>
      <MenuItem disabled={!session} onSelect={() => session?.clear()}>
        Clear
      </MenuItem>
    </>
  );
}
