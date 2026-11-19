import type { Theme } from "../types";

/*
 * GitHub Light: the official palette, by GitHub.
 * Source: https://github.com/primer/github-vscode-theme
 * License: MIT
 */
export const githubLight: Theme = {
  id: "github-light",
  name: "GitHub Light",
  kind: "light",
  author: "GitHub",
  source: "https://github.com/primer/github-vscode-theme",
  license: "MIT",
  background: "#ffffff",
  foreground: "#1f2328",
  accent: "#0969da",
  cursor: "#0969da",
  selection: "#add6ff",
  ansi: {
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#4d2d00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
  overrides: {
    field: "#f6f8fa",
    line: "#d0d7de",
    "line-strong": "#d0d7de",
    "fg-dim": "#656d76",
    comment: "#6e7781",
    keyword: "#cf222e",
    string: "#0a3069",
    function: "#8250df",
    type: "#953800",
    warn: "#9a6700",
  },
};
