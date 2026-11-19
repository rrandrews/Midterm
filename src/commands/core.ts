import {
  activePaneId,
  cycleTab,
  focusNeighbourPane,
  movePaneToNewTab,
  newTab,
  newWorkspace,
  selectTabAt,
  splitPane,
  toggleMaximizePane,
} from "../actions";
import { closePane, closeTab } from "../closing";
import { type Command, paneActionCommand, registerCommands } from "./registry";

/*
 * The app's own commands. Pane plugins declare theirs (`commands` in the
 * plugin), and are registered while enabled. Ids are stable: settings refer to them.
 */

/** A command that forwards to the active pane's action of that name. */
function paneAction(id: string, title: string, action: string, keys: string[], category = "Pane"): Command {
  return paneActionCommand({ id, title, category, keys }, action, activePaneId);
}

export const CORE_COMMANDS: Command[] = [
  { id: "tab.new", title: "New tab", category: "Tab", keys: ["Cmd+T"], run: () => newTab() },
  { id: "tab.close", title: "Close tab", category: "Tab", keys: ["Cmd+Shift+W"], run: () => closeTab() },
  { id: "tab.previous", title: "Previous tab", category: "Tab", keys: ["Cmd+Shift+["], run: () => cycleTab(-1) },
  { id: "tab.next", title: "Next tab", category: "Tab", keys: ["Cmd+Shift+]"], run: () => cycleTab(1) },
  ...Array.from(
    { length: 9 },
    (_, index): Command => ({
      id: `tab.select${index + 1}`,
      title: `Go to tab ${index + 1}`,
      category: "Tab",
      keys: [`Cmd+${index + 1}`],
      hidden: true,
      run: () => selectTabAt(index),
    }),
  ),

  { id: "workspace.new", title: "New workspace", category: "Workspace", run: newWorkspace },

  { id: "pane.splitRight", title: "Split right", category: "Pane", keys: ["Cmd+D"], run: () => splitPane("right") },
  { id: "pane.splitDown", title: "Split down", category: "Pane", keys: ["Cmd+Shift+D"], run: () => splitPane("bottom") },
  { id: "pane.close", title: "Close pane", category: "Pane", keys: ["Cmd+W"], run: () => closePane() },
  {
    id: "pane.toggleMaximize",
    title: "Maximize or restore pane",
    category: "Pane",
    keys: ["Cmd+Shift+Enter"],
    run: () => toggleMaximizePane(),
  },
  {
    id: "pane.moveToNewTab",
    title: "Move pane to new tab",
    category: "Pane",
    run: () => {
      const id = activePaneId();
      if (id) movePaneToNewTab(id);
    },
  },
  { id: "pane.focusLeft", title: "Focus pane to the left", category: "Pane", keys: ["Alt+Cmd+Left"], run: () => focusNeighbourPane("left") },
  { id: "pane.focusRight", title: "Focus pane to the right", category: "Pane", keys: ["Alt+Cmd+Right"], run: () => focusNeighbourPane("right") },
  { id: "pane.focusUp", title: "Focus pane above", category: "Pane", keys: ["Alt+Cmd+Up"], run: () => focusNeighbourPane("up") },
  { id: "pane.focusDown", title: "Focus pane below", category: "Pane", keys: ["Alt+Cmd+Down"], run: () => focusNeighbourPane("down") },

  paneAction("pane.find", "Find", "find", ["Cmd+F"]),
  paneAction("pane.findNext", "Find next", "findNext", ["Cmd+G"]),
  paneAction("pane.findPrevious", "Find previous", "findPrevious", ["Cmd+Shift+G"]),
  paneAction("pane.save", "Save", "save", ["Cmd+S"], "Editor"),
  paneAction("pane.goToLine", "Go to line", "goToLine", ["Ctrl+G"], "Editor"),
];

registerCommands(CORE_COMMANDS);
