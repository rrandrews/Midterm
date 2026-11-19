import { shortcutLabel } from "../../commands/registry";
import { peekEditor } from "../../editor/registry";
import { copyText } from "../../ipc/clipboard";
import { revealInFileManager } from "../../ipc/shell";
import { MenuItem, MenuSeparator } from "../ui/Menu";

/** Runs after the menu has closed and handed focus back to the pane, so a panel opened by `run` keeps it. */
const later = (run: () => void) => setTimeout(run, 0);

/** Right-click items of an editor or viewer pane showing `path`. */
export function FileMenuItems({ paneId, path }: { paneId: string; path: string }) {
  const editor = peekEditor(paneId);
  const ready = editor?.snapshot().status === "ready";
  return (
    <>
      {editor && ready && (
        <>
          {!editor.readOnly && (
            <>
              <MenuItem shortcut={shortcutLabel("pane.save")} onSelect={() => void editor.save()}>
                Save
              </MenuItem>
              <MenuItem disabled={!editor.isDirty} onSelect={editor.revert}>
                Revert file
              </MenuItem>
            </>
          )}
          <MenuItem shortcut={shortcutLabel("pane.find")} onSelect={() => later(editor.find)}>
            Find…
          </MenuItem>
          <MenuItem shortcut={shortcutLabel("pane.goToLine")} onSelect={() => later(editor.goToLine)}>
            Go to line…
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      <MenuItem onSelect={() => revealInFileManager(path)}>Reveal in Finder</MenuItem>
      <MenuItem onSelect={() => void copyText(path)}>Copy path</MenuItem>
    </>
  );
}
