import type { Theme } from "../types";

/*
 * GitHub Dark: the official palette, by GitHub.
 * Source: https://github.com/primer/github-vscode-theme
 * License: MIT
 */
export const githubDark: Theme = {
  id: "github-dark",
  name: "GitHub Dark",
  kind: "dark",
  author: "GitHub",
  source: "https://github.com/primer/github-vscode-theme",
  license: "MIT",
  background: "#0d1117",
  foreground: "#e6edf3",
  accent: "#2f81f7",
  cursor: "#2f81f7",
  selection: "#264f78",
  ansi: {
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#ffffff",
  },
  overrides: {
    field: "#161b22",
    popover: "#161b22",
    line: "#30363d",
    "line-strong": "#30363d",
    "fg-dim": "#8b949e",
    comment: "#8b949e",
    keyword: "#ff7b72",
    string: "#a5d6ff",
    function: "#d2a8ff",
    type: "#ffa657",
  },
};
