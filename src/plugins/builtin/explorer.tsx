import { activePaneId } from "../../actions";
import { paneActionCommand } from "../../commands/registry";
import { ExplorerPane } from "../../components/panes/ExplorerPane";
import { explorerMenu, explorerOptionsMenu } from "../../components/panes/ExplorerMenus";
import { type ExplorerData, peekExplorer } from "../../explorer/explorers";
import type { SettingField } from "../fields";
import type { PanePlugin, PaneProps } from "../types";
import { validateExplorerData } from "./data";
import { explorerSkills } from "./explorerSkills";

function Explorer({ paneId }: PaneProps) {
  return <ExplorerPane paneId={paneId} />;
}

// Following a terminal and hidden files are per explorer, in its … menu.
const EXPLORER_FIELDS: SettingField[] = [
  {
    key: "striped",
    type: "toggle",
    label: "Striped rows",
    hint: "Alternate rows get a slightly different shade.",
    default: false,
  },
];

/** File explorer panes: a live tree of a directory. */
export const explorerPlugin: PanePlugin = {
  id: "explorer",
  name: "Explorer",
  description: "A live file tree with git badges that follows the focused terminal.",
  icon: "folder-tree",
  pane: {
    component: Explorer,
    validateData: validateExplorerData,
    directory: (pane) => peekExplorer(pane.id)?.snapshot().root ?? (pane.data as ExplorerData).root,
    menu: (ctx) => {
      const model = peekExplorer(ctx.paneId);
      return model ? explorerMenu(model) : [];
    },
    optionsMenu: (ctx) => {
      const model = peekExplorer(ctx.paneId);
      return model ? explorerOptionsMenu(model) : [];
    },
    hideMenuItems: ["maximize", "moveToTab"],
    splittable: false,
    subtabIconOnly: true,
    background: "var(--pane-explorer)",
  },
  // ⌘F (the app's Find) searches names; this searches what files contain.
  commands: [
    paneActionCommand(
      { id: "explorer.searchText", title: "Search in files", category: "Explorer", keys: ["Cmd+Ctrl+F"] },
      "searchText",
      activePaneId,
    ),
  ],
  settings: { fields: EXPLORER_FIELDS },
  skills: explorerSkills,
};
