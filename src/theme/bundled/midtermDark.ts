import type { Theme } from "../types";

/*
 * Midterm Dark: the app's original look (the reference mockup). Resolving it
 * reproduces the values that used to be hard-coded in src/styles/index.css
 * and src/terminal/theme.ts exactly; the overrides pin the tokens the color
 * math lands near but not on.
 * Author: Midterm. License: same as the app.
 */
export const midtermDark: Theme = {
  id: "midterm-dark",
  name: "Midterm Dark",
  kind: "dark",
  author: "Midterm",
  background: "#0c0d10",
  foreground: "#e4e5e9",
  accent: "#8b9cff",
  ansi: {
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
  },
  overrides: {
    popover: "#1a1c22",
    line: "#1f2128",
    "line-menu": "#262931",
    "line-block": "#ffffff0f",
    "line-input": "#ffffff12",
    "fg-bright": "#f2f3f5",
    "fg-soft": "#d5d7dc",
    "fg-mid": "#b9bcc4",
    "fg-muted": "#9096a1",
    "fg-dim": "#858a96",
    "fg-faint": "#5a5f6a",
    "accent-fg": "#dde2ff",
    comment: "#7f8592",
    hover: "#ffffff0f",
    selected: "#ffffff0f",
    "terminal-solid": "#0e0f12",
    "terminal-fg": "#d5d7dc",
    "tab-active-to": "#121318",
  },
  panes: {
    editor: { from: "#131419" },
    "terminal-active": { from: "#15161c" },
    viewer: { from: "#131419" },
  },
};
