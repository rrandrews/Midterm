import { activePaneId, openPaneBeside } from "../actions";
import { paneActionCommand } from "../commands/registry";
import { validateSourceControlData } from "../plugins/builtin/data";
import type { SettingField } from "../plugins/fields";
import type { PanePlugin } from "../plugins/types";
import { scmOptionsMenu, scmPaneMenu } from "./menus";
import { peekScm, type SourceControlData } from "./registry";
import { scmSkills } from "./skills";
import { SourceControlPane } from "./SourceControlPane";
import { splitRelPath } from "./tree";

const SCM_FIELDS: SettingField[] = [
  {
    key: "defaultView",
    type: "select",
    label: "Default changes layout",
    hint: "Show changed files as a flat list or a collapsible folder tree.",
    options: [
      { value: "list", label: "List" },
      { value: "tree", label: "Tree" },
    ],
    default: "list",
  },
  {
    key: "smartCommit",
    type: "toggle",
    label: "Smart commit",
    hint: "Automatically stage all changes when committing with nothing staged.",
    default: false,
  },
  {
    key: "confirmSync",
    type: "toggle",
    label: "Confirm before sync",
    hint: "Ask for confirmation before pulling and pushing with Sync.",
    default: false,
  },
  {
    key: "historyLimit",
    type: "number",
    label: "Commits per page",
    hint: "Number of commits loaded per batch in the Graph section.",
    default: 40,
    min: 10,
    max: 200,
    integer: true,
  },
];

function diffModeShortLabel(data: SourceControlData): string | undefined {
  const target = data.diffTarget;
  if (!target) return undefined;
  const { name } = splitRelPath(target.filePath);
  switch (target.mode) {
    case "unstaged":
      return `${name} (Working Tree)`;
    case "staged":
      return `${name} (Staged)`;
    case "untracked":
      return `${name} (Untracked)`;
    case "commit":
      return `${name} (${target.label ?? target.commitHash?.slice(0, 7) ?? "Commit"})`;
    case "stash":
      return `${name} (${target.label ?? target.commitHash ?? "Stash"})`;
  }
}

export const sourceControlPlugin: PanePlugin = {
  id: "source-control",
  name: "Source Control",
  description: "Git staging, hunk diffs, commit history graph, branches, stashes, and remote sync.",
  icon: "git-branch",
  pane: {
    component: SourceControlPane,
    validateData: validateSourceControlData,
    directory: (pane) => {
      const data = pane.data as SourceControlData;
      if (data.diffTarget) return data.diffTarget.root;
      return peekScm(pane.id)?.repoRoot ?? data.root;
    },
    tabTitle: (pane) => {
      const data = pane.data as SourceControlData;
      const diffTitle = diffModeShortLabel(data);
      if (diffTitle) return diffTitle;
      const branch = peekScm(pane.id)?.snapshot().status?.branch;
      return branch ? `Source Control (${branch})` : "Source Control";
    },
    menu: (ctx) => {
      const data = ctx.data() as SourceControlData;
      if (data.diffTarget) return [];
      const model = peekScm(ctx.paneId);
      return model ? scmPaneMenu(model) : [];
    },
    optionsMenu: (ctx) => {
      const data = ctx.data() as SourceControlData;
      if (data.diffTarget) return [];
      const model = peekScm(ctx.paneId);
      return model ? scmOptionsMenu(model) : [];
    },
    hideMenuItems: (ctx) => {
      const data = ctx.data() as SourceControlData;
      return data.diffTarget ? [] : ["maximize", "moveToTab"];
    },
    splittable: false,
    subtabIconOnly: (pane) => !(pane.data as SourceControlData).diffTarget,
    background: "var(--pane-explorer)",
  },
  commands: [
    {
      id: "source-control.open",
      title: "Open Source Control",
      category: "Source Control",
      keys: ["Ctrl+Shift+G"],
      run: () => openPaneBeside("source-control", activePaneId()),
    },
    paneActionCommand(
      { id: "source-control.refresh", title: "Refresh repository", category: "Source Control" },
      "refresh",
      activePaneId,
    ),
    paneActionCommand(
      { id: "source-control.commit", title: "Commit changes", category: "Source Control" },
      "commit",
      activePaneId,
    ),
    paneActionCommand(
      { id: "source-control.stageAll", title: "Stage all changes", category: "Source Control" },
      "stageAll",
      activePaneId,
    ),
    paneActionCommand(
      { id: "source-control.unstageAll", title: "Unstage all changes", category: "Source Control" },
      "unstageAll",
      activePaneId,
    ),
  ],
  settings: { fields: SCM_FIELDS },
  skills: scmSkills,
};
