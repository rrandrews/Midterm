import { activePaneId, livePane, updatePaneData } from "../actions";
import { homeDirectory } from "../ipc/system";
import type { SettingField } from "../plugins/fields";
import { directoryOf } from "../plugins/panes";
import { pluginSettings } from "../plugins/settings";
import type { PanePlugin, PaneProps } from "../plugins/types";
import { startNewSession } from "./commands";
import {
  getSession,
  interrupt,
  paneIsRunning,
  paneSessionKey,
  sessionWork,
  setHostActions,
  setPaneDataWriter,
  setPanel,
  useAntigravityStore,
} from "./store";
import { ANTIGRAVITY_KIND, type AntigravityPaneData, type SidePanel } from "./types";
import { AntigravityPane } from "./ui/AntigravityPane";

/*
 * The `antigravity` built-in pane plugin: runs full interactive Google
 * Antigravity sessions over ACP (`agy acp`) in a project folder (MID-104).
 * See docs/antigravity.md.
 */

setPaneDataWriter((paneId, patch) => updatePaneData(paneId, patch));

export function validateAntigravityData(raw: Record<string, unknown>): AntigravityPaneData {
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined);
  return {
    cwd: (text(raw.cwd) ?? homeDirectory() ?? "/").replace(/(.)\/+$/, "$1"),
    sessionId: text(raw.sessionId),
    mode: text(raw.mode),
    model: text(raw.model),
    thoughtLevel: text(raw.thoughtLevel),
  };
}

const FIELDS: SettingField[] = [
  {
    type: "text",
    key: "agyPath",
    label: "Antigravity CLI executable",
    default: "",
    placeholder: "agy (from your login shell's PATH)",
    hint: "A path, ~/… or a name on the PATH. Applies to new sessions.",
  },
  {
    type: "toggle",
    key: "sandbox",
    label: "Sandbox mode",
    hint: "Pass --sandbox to `agy acp` to isolate terminal commands. Applies to new sessions.",
    default: false,
  },
  {
    type: "select",
    key: "defaultMode",
    label: "Mode for new sessions",
    options: [
      { value: "default", label: "Ask before edits" },
      { value: "accept-edits", label: "Accept edits" },
      { value: "plan", label: "Plan mode" },
    ],
    default: "default",
  },
  {
    type: "text",
    key: "agentPreset",
    label: "Agent preset",
    default: "",
    placeholder: "default",
    hint: "Optional `--agent <name>` preset passed to `agy acp`.",
  },
  {
    type: "list",
    key: "additionalDirs",
    label: "Additional workspace directories",
    default: [],
    hint: "Extra paths passed via `--add-dir` for multi-root sessions.",
  },
  {
    type: "toggle",
    key: "showThinking",
    label: "Show thinking",
    hint: "Shown collapsed in the transcript.",
    default: true,
  },
  {
    type: "toggle",
    key: "followFiles",
    label: "Follow edited files",
    hint: "Automatically reveal files in an editor pane as Antigravity edits them.",
    default: false,
  },
];

const PANELS: { panel: SidePanel; title: string }[] = [
  { panel: "history", title: "history" },
  { panel: "files", title: "files" },
  { panel: "session", title: "session" },
  { panel: "plan", title: "plan" },
];

function activeSession(): string | undefined {
  const paneId = activePaneId();
  const pane = livePane(paneId);
  return pane?.data.kind === ANTIGRAVITY_KIND && paneId ? paneSessionKey(paneId) : undefined;
}

function Pane(props: PaneProps) {
  return <AntigravityPane {...props} />;
}

export const antigravityPlugin: PanePlugin = {
  id: ANTIGRAVITY_KIND,
  name: "Antigravity",
  description: "Google Antigravity coding sessions over ACP (`agy acp`) with your own tools, rules, skills and MCP servers.",
  icon: "orbit",
  pane: {
    component: Pane,
    validateData: validateAntigravityData,
    createData: (from) => {
      const mode = pluginSettings(ANTIGRAVITY_KIND, FIELDS).defaultMode;
      return {
        cwd: (from && directoryOf(from)) ?? homeDirectory() ?? "/",
        ...(typeof mode === "string" && mode && mode !== "default" ? { mode } : {}),
      };
    },
    tabTitle: (pane) => {
      const key = paneSessionKey(pane.id);
      return (key && getSession(key)?.title) || "Antigravity";
    },
    directory: (pane) => {
      const key = paneSessionKey(pane.id);
      return (key && getSession(key)?.cwd) || (pane.data as unknown as AntigravityPaneData).cwd;
    },
    closeBlockers: async (paneId) => {
      const key = paneSessionKey(paneId);
      const work = key ? sessionWork(key) : undefined;
      return work ? [{ type: "running", name: work }] : [];
    },
    menu: (ctx) => {
      const key = paneSessionKey(ctx.paneId);
      const running = paneIsRunning(ctx.paneId);
      return [
        { label: "New session", commandId: "antigravity.newSession", run: () => key && void startNewSession(key) },
        { label: "Interrupt", commandId: "antigravity.interrupt", disabled: !running, run: () => key && void interrupt(key) },
        { type: "separator" },
        {
          type: "submenu",
          label: "Panels",
          items: PANELS.map(({ panel, title }) => ({
            label: title[0].toUpperCase() + title.slice(1),
            checked: key ? getSession(key)?.panel === panel : false,
            run: () => key && setPanel(key, panel),
          })),
        },
      ];
    },
  },
  commands: [
    {
      id: "antigravity.newSession",
      title: "Antigravity: New session",
      category: "Antigravity",
      enabled: () => activeSession() !== undefined,
      run: () => {
        const key = activeSession();
        if (key) void startNewSession(key);
      },
    },
    {
      id: "antigravity.interrupt",
      title: "Antigravity: Interrupt",
      category: "Antigravity",
      enabled: () => {
        const key = activeSession();
        return key !== undefined && getSession(key)?.status === "running";
      },
      run: () => {
        const key = activeSession();
        if (key) void interrupt(key);
      },
    },
    ...PANELS.map(({ panel, title }) => ({
      id: `antigravity.panel.${panel}`,
      title: `Antigravity: Toggle the ${title} panel`,
      category: "Antigravity",
      enabled: () => activeSession() !== undefined,
      run: () => {
        const key = activeSession();
        if (key) setPanel(key, panel);
      },
    })),
  ],
  settings: { fields: FIELDS },
  activate: (api) => {
    setHostActions({
      openFile: (path, options) => api.files.open(path, options),
      markActivity: (paneId) => api.panes.markActivity(paneId),
      runInTerminal: (command) => api.terminals.run(command),
      isActivePane: (paneId) => api.panes.active() === paneId,
    });
    let titles = "";
    return useAntigravityStore.subscribe((state) => {
      const next = Object.values(state.sessions)
        .map((session) => `${session.paneId}:${session.title ?? ""}`)
        .join("\n");
      if (next === titles) return;
      titles = next;
      api.panes.refreshTitles();
    });
  },
};
