import { activePaneId } from "../actions";
import { registerCommands } from "../commands/registry";
import { peekEditor } from "./registry";

/*
 * Editor commands beyond the shared pane actions (find, save, go to line,
 * registered in src/commands/core.ts and forwarded to the pane).
 */

/** The active pane's editor, if it is an editable one showing its file. */
function activeEditor() {
  const editor = peekEditor(activePaneId() ?? "");
  return editor && !editor.readOnly && editor.snapshot().status === "ready" ? editor : undefined;
}

registerCommands([
  {
    id: "editor.revert",
    title: "Revert file",
    category: "Editor",
    run: () => activeEditor()?.revert(),
    enabled: () => activeEditor()?.isDirty ?? false,
  },
]);
