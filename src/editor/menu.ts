import { copyText } from "../ipc/clipboard";
import { revealInFileManager } from "../ipc/shell";
import type { MenuItemSpec } from "../plugins/types";
import { peekEditor } from "./registry";

/** Right-click items of an editor or viewer pane showing `path`. */
export function fileMenu(paneId: string, path: string | undefined): MenuItemSpec[] {
  if (!path) return [];
  const editor = peekEditor(paneId);
  const ready = editor?.snapshot().status === "ready";
  const items: MenuItemSpec[] = [];
  if (editor && ready) {
    if (!editor.readOnly) {
      items.push(
        { label: "Save", commandId: "pane.save", run: () => editor.save() },
        { label: "Revert file", disabled: !editor.isDirty, run: editor.revert },
      );
    }
    items.push(
      { label: "Find…", commandId: "pane.find", run: editor.find },
      { label: "Go to line…", commandId: "pane.goToLine", run: editor.goToLine },
      { type: "separator" },
    );
  }
  items.push(
    { label: "Reveal in Finder", run: () => revealInFileManager(path) },
    { label: "Copy path", run: () => copyText(path) },
  );
  return items;
}
