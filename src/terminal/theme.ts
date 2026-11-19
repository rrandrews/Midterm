import type { ITerminalOptions, ITheme } from "@xterm/xterm";

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
