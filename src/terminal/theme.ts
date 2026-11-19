import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import { monoFontStack } from "../settings/schema";
import type { TerminalConfig } from "./settings";

/* xterm appearance. Colors mirror the tokens in src/styles/index.css. */

export const TERMINAL_THEME: ITheme = {
  // Transparent, so the pane's gradient shows through.
  background: "#00000000",
  foreground: "#d5d7dc",
  cursor: "#8b9cff",
  cursorAccent: "#0c0d10",
  selectionBackground: "#8b9cff40",
  selectionInactiveBackground: "#8b9cff26",

  black: "#15161b",
  red: "#e8868a",
  green: "#a5d6a7",
  yellow: "#f2c27b",
  blue: "#82b4ff",
  magenta: "#c3a6ff",
  cyan: "#5eead4",
  white: "#b9bcc4",

  brightBlack: "#5a5f6a",
  brightRed: "#f2a3a6",
  brightGreen: "#bfe5c0",
  brightYellow: "#f7d49b",
  brightBlue: "#a8cbff",
  brightMagenta: "#d6c2ff",
  brightCyan: "#8cf2e2",
  brightWhite: "#f2f3f5",
};

export const TERMINAL_OPTIONS: ITerminalOptions = {
  theme: TERMINAL_THEME,
  allowTransparency: true,
  fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace',
  fontSize: 12.5,
  fontWeight: "400",
  fontWeightBold: "500",
  // Tuned so rows are 19px tall, as in the mockup.
  lineHeight: 1.12,
  cursorBlink: true,
  cursorStyle: "block",
  cursorInactiveStyle: "outline",
  scrollback: 10_000,
  macOptionClickForcesSelection: true,
  // Needed for the unicode11 width tables.
  allowProposedApi: true,
};

/**
 * Background for `terminalBackground: "solid"`: the darker end of the
 * terminal pane gradient (`--pane-terminal` in src/styles/index.css).
 */
export const SOLID_BACKGROUND = "#0e0f12";

/** `#rrggbb` with an alpha byte appended. */
const withAlpha = (hex: string, alpha: string) => `${hex.slice(0, 7)}${alpha}`;

/** The colors for the given settings: the accent drives the cursor and selection. */
export function terminalTheme(settings: Pick<TerminalConfig, "accent" | "terminalBackground">): ITheme {
  const accent = settings.accent.toLowerCase();
  return {
    ...TERMINAL_THEME,
    background: settings.terminalBackground === "solid" ? SOLID_BACKGROUND : TERMINAL_THEME.background,
    cursor: accent,
    selectionBackground: withAlpha(accent, "40"),
    selectionInactiveBackground: withAlpha(accent, "26"),
  };
}

/** The xterm options that follow the settings. Everything else stays as in `TERMINAL_OPTIONS`. */
export function terminalOptions(settings: TerminalConfig): ITerminalOptions {
  return {
    theme: terminalTheme(settings),
    allowTransparency: settings.terminalBackground === "transparent",
    fontFamily: monoFontStack(settings.fontFamily),
    fontSize: settings.fontSize,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
  };
}
