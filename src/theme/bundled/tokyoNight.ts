import type { Theme } from "../types";

/*
 * Tokyo Night: the official palette, by Enkia.
 * Source: https://github.com/enkia/tokyo-night-vscode-theme
 * License: MIT
 */
export const tokyoNight: Theme = {
  id: "tokyo-night",
  name: "Tokyo Night",
  kind: "dark",
  author: "Enkia",
  source: "https://github.com/enkia/tokyo-night-vscode-theme",
  license: "MIT",
  background: "#1a1b26",
  foreground: "#c0caf5",
  accent: "#7aa2f7",
  cursor: "#c0caf5",
  selection: "#33467c",
  ansi: {
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
  overrides: {
    "terminal-fg": "#a9b1d6",
    comment: "#565f89",
    keyword: "#bb9af7",
    function: "#7aa2f7",
    string: "#9ece6a",
    type: "#2ac3de",
  },
};
