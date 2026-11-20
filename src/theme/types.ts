import type { ITheme } from "@xterm/xterm";

/*
 * The theme model (docs/themes.md). A theme is a small base palette plus
 * optional overrides; `resolveTheme` (resolve.ts) derives every token.
 * All colors are lowercase hex: `#rrggbb` or `#rrggbbaa`.
 */

/** The 16 ANSI colors, in terminal order. */
export const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export type AnsiName = (typeof ANSI_NAMES)[number];
export type AnsiPalette = Record<AnsiName, string>;

/** `brightBlack` → `ansi-bright-black`: the token holding that ANSI color. */
export const ansiToken = (name: AnsiName): TokenName =>
  `ansi-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}` as TokenName;

/**
 * Every resolved color token, grouped as the theme editor shows them. The
 * order inside a group is the order they are derived in.
 */
export const TOKEN_GROUPS = {
  surfaces: ["app", "field", "popover", "raised", "terminal-solid"],
  lines: ["line", "line-menu", "line-strong", "line-block", "line-input"],
  text: ["fg-bright", "fg", "fg-soft", "fg-mid", "fg-muted", "fg-dim", "fg-faint"],
  accent: ["accent", "accent-soft", "accent-fg"],
  states: ["hover", "selected", "scrim", "shadow"],
  status: ["ok", "warn", "err", "info"],
  syntax: ["keyword", "comment", "string", "function", "type", "punctuation"],
  terminal: [
    "terminal-bg",
    "terminal-fg",
    "terminal-cursor",
    "terminal-cursor-accent",
    "terminal-selection",
    "terminal-selection-inactive",
    "terminal-match",
    "terminal-match-active",
  ],
  ansi: [
    "ansi-black",
    "ansi-red",
    "ansi-green",
    "ansi-yellow",
    "ansi-blue",
    "ansi-magenta",
    "ansi-cyan",
    "ansi-white",
    "ansi-bright-black",
    "ansi-bright-red",
    "ansi-bright-green",
    "ansi-bright-yellow",
    "ansi-bright-blue",
    "ansi-bright-magenta",
    "ansi-bright-cyan",
    "ansi-bright-white",
  ],
  tab: ["tab-active-from", "tab-active-to"],
} as const;

export type TokenGroup = keyof typeof TOKEN_GROUPS;
export type TokenName = (typeof TOKEN_GROUPS)[TokenGroup][number];

/** All token names, group by group. */
export const TOKEN_NAMES: readonly TokenName[] = Object.values(TOKEN_GROUPS).flat();

const TOKEN_SET = new Set<string>(TOKEN_NAMES);
export const isTokenName = (name: string): name is TokenName => TOKEN_SET.has(name);

/**
 * A pane background: a two-stop linear gradient (`from` at the top, `to` at
 * the bottom, `angle` in degrees). A solid color is `from === to`.
 */
export interface PaneBackground {
  from: string;
  to: string;
  angle: number;
}

/**
 * The pane background keys every resolved theme has, because the app's CSS
 * uses them. Other keys (one per pane plugin id) are open: a plugin's pane
 * falls back to `default` when the theme has nothing for it.
 * `terminal-active` is the terminal pane that has focus.
 */
export const BUILTIN_PANES = ["default", "terminal", "terminal-active", "explorer", "editor", "viewer"] as const;

export type ThemeKind = "dark" | "light";

export interface Theme {
  /** Stable identifier, lowercase letters, digits and dashes (`midterm-dark`). */
  id: string;
  /** Display name. */
  name: string;
  kind: ThemeKind;
  background: string;
  foreground: string;
  accent: string;
  /** Terminal cursor; defaults to the accent. */
  cursor?: string;
  /** Terminal selection; defaults to the accent at 25%. */
  selection?: string;
  ansi: AnsiPalette;
  /** Resolved token values that win over derivation. */
  overrides?: Partial<Record<TokenName, string>>;
  /** Pane backgrounds by pane plugin id (see `BUILTIN_PANES`); missing fields are derived. */
  panes?: Record<string, Partial<PaneBackground>>;
  /** File icons: the id of an icon set (bundled or custom, see docs/icons.md); the settings' choice when unset. */
  icons?: { set: string };
  author?: string;
  /** Where the palette comes from (URL). */
  source?: string;
  /** License of the palette (SPDX identifier where there is one). */
  license?: string;
}

export interface ResolvedTheme {
  id: string;
  name: string;
  kind: ThemeKind;
  /** For CodeMirror's `EditorView.theme({}, { dark })` and `color-scheme`. */
  dark: boolean;
  tokens: Record<TokenName, string>;
  /** Pane backgrounds: every `BUILTIN_PANES` key plus the theme's own keys. */
  panes: Record<string, PaneBackground>;
  /** The xterm palette (transparent background; see `tokens["terminal-solid"]`). */
  xterm: ITheme;
}
