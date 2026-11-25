import type { SettingField } from "../plugins/fields";
import { pluginSettings, usePluginSettings } from "../plugins/settings";
import type { PaneData } from "../state/types";
import type { ITheme } from "@xterm/xterm";
import { getSettings } from "../settings/settings";
import { selectAllPanes, useAppStore } from "../state/store";
import { appliedTheme } from "../theme/apply";
import { paneResolvedTheme } from "../theme/paneTheme";
import { BLOCK_TERMINAL } from "./kinds";

/*
 * The terminals' settings and pane data. Settings are shared by the classic
 * and block terminals (they belong to the shell session, not the view),
 * saved under `settings.plugins.terminal.settings` and declared here as
 * fields, which the settings dialog renders.
 */

export type CursorStyle = "block" | "bar" | "underline";
/** How a terminal pane renders: the classic terminal or the block terminal. */
export type TerminalMode = "classic" | "blocks";
export type BellMode = "off" | "visual" | "sound";
export type TerminalBackground = "transparent" | "solid";

export type TerminalSettings = {
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** Lines of scrollback per terminal. */
  scrollback: number;
  /** Selecting text in a terminal copies it. */
  copyOnSelect: boolean;
  bell: BellMode;
  /**
   * `transparent` lets the pane gradient show through the terminal (costs
   * some rendering speed); `solid` paints a flat background.
   */
  terminalBackground: TerminalBackground;
  /** With a transparent background: solid while the alternate screen is active (vim, htop, less). */
  solidForFullscreen: boolean;
  /** With a transparent background: programs that get a solid one while in the foreground. */
  solidBackgroundCommands: string[];
  /** Program to run in new terminals; the login shell when empty. */
  shell: string;
  /** Arguments for `shell` (ignored when `shell` is empty). */
  shellArgs: string[];
  /** `ssh host` loads the shell integration on the remote (blocks over ssh). */
  sshIntegration: boolean;
};

export const SCROLLBACK_RANGE = { min: 0, max: 1_000_000 } as const;

export const TERMINAL_FIELDS: SettingField[] = [
  { key: "cursorStyle", type: "select", label: "Cursor style", options: ["block", "bar", "underline"], default: "block" },
  { key: "cursorBlink", type: "toggle", label: "Cursor blinks", default: true },
  {
    key: "scrollback",
    type: "number",
    label: "Scrollback",
    hint: `Lines kept per terminal, up to ${SCROLLBACK_RANGE.max.toLocaleString("en-US")}.`,
    min: SCROLLBACK_RANGE.min,
    max: SCROLLBACK_RANGE.max,
    integer: true,
    default: 10_000,
  },
  { key: "copyOnSelect", type: "toggle", label: "Copy on select", default: false },
  {
    key: "bell",
    type: "select",
    label: "Bell",
    options: [
      { value: "off", label: "Off" },
      { value: "visual", label: "Flash" },
      { value: "sound", label: "Sound" },
    ],
    default: "visual",
  },
  {
    key: "terminalBackground",
    type: "select",
    label: "Background",
    hint: "Transparent shows the pane gradient; solid renders faster.",
    options: ["transparent", "solid"],
    default: "transparent",
  },
  {
    key: "solidForFullscreen",
    type: "toggle",
    label: "Solid for fullscreen apps",
    hint: "With a transparent background, go solid while a fullscreen app (vim, htop, less) runs.",
    default: true,
  },
  {
    key: "solidBackgroundCommands",
    type: "programs",
    label: "Solid for programs",
    hint: "Programs that paint their own background and so get a solid one. Matched by program name.",
    placeholder: "Add a program…",
    default: ["codex"],
  },
  {
    key: "shell",
    type: "text",
    label: "Shell",
    hint: "Empty uses your login shell. A custom program runs without shell integration (no cwd or blocks).",
    placeholder: "/bin/zsh",
    default: "",
  },
  {
    key: "shellArgs",
    type: "list",
    label: "Shell arguments",
    hint: "For a custom shell. Quote arguments with spaces.",
    placeholder: "-l",
    default: [],
  },
  {
    key: "sshIntegration",
    type: "toggle",
    label: "Shell integration over ssh",
    hint: "`ssh host` loads it on the remote, leaving nothing behind. New terminals only; `command ssh` skips it once.",
    default: true,
  },
];

/**
 * The block terminal's own settings (saved under its plugin entry; the
 * shared ones above are under the classic terminal's).
 */
export type BlockTerminalSettings = {
  /** Programs that run full-pane (the classic terminal shows) instead of in a block. */
  fullPanePrograms: string[];
};

export const BLOCK_TERMINAL_FIELDS: SettingField[] = [
  {
    key: "fullPanePrograms",
    type: "programs",
    label: "Run full-pane",
    hint: "Programs that take over the whole pane while they run, like vim or htop do, instead of running in a block. For interactive apps that misbehave in a block. Matched by program name.",
    placeholder: "Add a program…",
    default: ["agy"],
  },
];

export function terminalSettings(): TerminalSettings {
  return pluginSettings("terminal", TERMINAL_FIELDS) as TerminalSettings;
}

export function useTerminalSettings(): TerminalSettings {
  return usePluginSettings("terminal", TERMINAL_FIELDS) as TerminalSettings;
}

export function useBlockTerminalSettings(): BlockTerminalSettings {
  return usePluginSettings(BLOCK_TERMINAL, BLOCK_TERMINAL_FIELDS) as BlockTerminalSettings;
}

/**
 * Everything a terminal session follows: the terminal's settings, the
 * global font, and the theme's terminal colors.
 */
export type TerminalConfig = TerminalSettings & {
  fontFamily: string;
  fontSize: number;
  /** The theme's xterm colors (cursor and selection follow the accent). */
  colors: ITheme;
  /** Background for `terminalBackground: "solid"`. */
  solidBackground: string;
  /** Find highlights. */
  match: string;
  matchActive: string;
  accent: string;
};

/** The kind of a pane in any tab, if it exists. */
function kindOfPane(paneId: string): string | undefined {
  return selectAllPanes(useAppStore.getState()).find((pane) => pane.id === paneId)?.data.kind;
}

/** The config for a pane's terminal: its kind's own theme (see src/theme/paneTheme.ts), else the app's. */
export function terminalConfig(paneId?: string): TerminalConfig {
  const { fontFamily, fontSize } = getSettings();
  const kind = paneId ? kindOfPane(paneId) : undefined;
  const theme = (kind && paneResolvedTheme(kind)) || appliedTheme();
  return {
    ...terminalSettings(),
    fontFamily,
    fontSize,
    colors: theme.xterm,
    solidBackground: theme.tokens["terminal-solid"],
    match: theme.tokens["terminal-match"],
    matchActive: theme.tokens["terminal-match-active"],
    accent: theme.tokens.accent.slice(0, 7),
  };
}

/** A terminal pane's data. */
export type TerminalData = PaneData & {
  /** Last working directory the shell reported (OSC 7). New shells for this pane start there. */
  cwd?: string;
};
