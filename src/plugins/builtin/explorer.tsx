import { ExplorerPane } from "../../components/panes/ExplorerPane";
import { explorerMenu } from "../../components/panes/ExplorerMenus";
import { type ExplorerData, peekExplorer } from "../../explorer/explorers";
import type { SettingField } from "../fields";
import type { PanePlugin, PaneProps } from "../types";
import { validateExplorerData } from "./data";
import { explorerSkills } from "./explorerSkills";

function Explorer({ paneId }: PaneProps) {
  return <ExplorerPane paneId={paneId} />;
}

const EXPLORER_FIELDS: SettingField[] = [
  {
    key: "followTerminal",
    type: "toggle",
    label: "Follow the terminal",
    hint: "New explorers show the directory of the terminal last focused in their tab (each can be pinned)",
    default: true,
  },
  { key: "showHidden", type: "toggle", label: "Show hidden and ignored files", hint: "In new explorers", default: false },
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
    splittable: false,
    background: "var(--pane-explorer)",
  },
  settings: { fields: EXPLORER_FIELDS },
  skills: explorerSkills,
};
