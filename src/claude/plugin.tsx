import { activePaneId, livePane, updatePaneData } from "../actions";
import { homeDirectory } from "../ipc/system";
import { directoryOf } from "../plugins/panes";
import { pluginSettings } from "../plugins/settings";
import type { PanePlugin, PaneProps } from "../plugins/types";
import type { SettingField } from "../plugins/fields";
import { CLAUDE_KIND } from "./client";
import type { EffortLevel, PermissionMode } from "./protocol";
import { getSession, interrupt, newSession, paneIsRunning, paneSessionKey, setPanel, setPaneDataWriter, useClaudeStore, type ClaudePaneData } from "./store";
import type { SidePanel } from "./types";
import { ClaudePane } from "./ui/ClaudePane";
import { MODE_LABELS } from "./ui/format";

/*
 * The `claude-code` pane plugin: a Claude Code session in a folder (see
 * docs/claude-code.md). Pane data: `{ cwd, sessionId?, model?, effort?,
 * permissionMode? }`; the store keeps it up to date.
 */

setPaneDataWriter((paneId, patch) => updatePaneData(paneId, patch));

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];
const EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Saved pane data, checked; a missing folder becomes the home folder. */
export function validateClaudeData(raw: Record<string, unknown>): ClaudePaneData {
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined);
  return {
    cwd: text(raw.cwd) ?? homeDirectory() ?? "/",
    sessionId: text(raw.sessionId),
    model: text(raw.model),
    effort: EFFORTS.includes(raw.effort as EffortLevel) ? (raw.effort as EffortLevel) : undefined,
    permissionMode: MODES.includes(raw.permissionMode as PermissionMode) ? (raw.permissionMode as PermissionMode) : undefined,
  };
}

const FIELDS: SettingField[] = [
  { type: "text", key: "claudePath", label: "Claude Code executable", default: "", placeholder: "claude (from your login shell's PATH)", hint: "A path, ~/… or a name on the PATH. Applies when the bridge restarts." },
  { type: "text", key: "nodePath", label: "Node executable", default: "", placeholder: "node (from your login shell's PATH)", hint: "Runs the bridge to Claude Code. Applies when the bridge restarts." },
  {
    type: "select",
    key: "defaultPermissionMode",
    label: "Permission mode for new sessions",
    options: (["default", "acceptEdits", "plan"] as const).map((mode) => ({ value: mode, label: MODE_LABELS[mode] })),
    default: "default",
  },
  {
    type: "toggle",
    key: "allowBypassPermissions",
    label: "Allow bypass permissions",
    hint: "Offer the bypass permissions mode, which runs every tool without asking. Applies to new sessions.",
    default: false,
  },
  { type: "toggle", key: "showThinking", label: "Show thinking", hint: "Claude's thinking, collapsed, in the transcript.", default: true },
];

const PANELS: { panel: SidePanel; title: string }[] = [
  { panel: "context", title: "context" },
  { panel: "usage", title: "usage" },
  { panel: "agents", title: "agents" },
  { panel: "plugins", title: "plugins" },
  { panel: "config", title: "settings" },
  { panel: "history", title: "history" },
];

/** The active pane's session key, when the active pane is a Claude Code pane. */
function activeSession(): string | undefined {
  const paneId = activePaneId();
  const pane = livePane(paneId);
  return pane?.data.kind === CLAUDE_KIND && paneId ? paneSessionKey(paneId) : undefined;
}

function Pane(props: PaneProps) {
  return <ClaudePane {...props} />;
}

export const claudeCodePlugin: PanePlugin = {
  id: CLAUDE_KIND,
  name: "Claude Code",
  description: "Claude Code sessions with your own tools, settings, plugins and MCP servers.",
  icon: "asterisk",
  pane: {
    component: Pane,
    validateData: validateClaudeData,
    createData: (from) => {
      const mode = defaultMode();
      return { cwd: (from && directoryOf(from)) ?? homeDirectory() ?? "/", ...(mode !== "default" ? { permissionMode: mode } : {}) };
    },
    tabTitle: (pane) => {
      const key = paneSessionKey(pane.id);
      return (key && getSession(key)?.title) || "Claude Code";
    },
    directory: (pane) => {
      const key = paneSessionKey(pane.id);
      return (key && getSession(key)?.cwd) || (pane.data as unknown as ClaudePaneData).cwd;
    },
    closeBlockers: async (paneId) => (paneIsRunning(paneId) ? [{ type: "running", name: "Claude Code" }] : []),
    menu: (ctx) => {
      const key = paneSessionKey(ctx.paneId);
      const running = paneIsRunning(ctx.paneId);
      return [
        { label: "New session", commandId: "claude.newSession", run: () => key && newSession(key) },
        { label: "Interrupt", commandId: "claude.interrupt", disabled: !running, run: () => key && interrupt(key) },
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
      id: "claude.newSession",
      title: "Claude Code: New session",
      category: "Claude Code",
      enabled: () => activeSession() !== undefined,
      run: () => {
        const key = activeSession();
        if (key) void newSession(key);
      },
    },
    {
      id: "claude.interrupt",
      title: "Claude Code: Interrupt",
      category: "Claude Code",
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
      id: `claude.panel.${panel}`,
      title: `Claude Code: Toggle the ${title} panel`,
      category: "Claude Code",
      enabled: () => activeSession() !== undefined,
      run: () => {
        const key = activeSession();
        if (key) setPanel(key, panel);
      },
    })),
  ],
  settings: { fields: FIELDS },
  activate: (api) => {
    // Tab titles follow session titles.
    let titles = "";
    return useClaudeStore.subscribe((state) => {
      const next = Object.values(state.sessions)
        .map((session) => `${session.paneId}:${session.title ?? ""}`)
        .join("\n");
      if (next === titles) return;
      titles = next;
      api.panes.refreshTitles();
    });
  },
};

/** The permission mode new panes start in (the plugin setting). */
function defaultMode(): PermissionMode {
  const value = pluginSettings(CLAUDE_KIND, FIELDS).defaultPermissionMode;
  return MODES.includes(value as PermissionMode) ? (value as PermissionMode) : "default";
}
