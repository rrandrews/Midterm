import type { Theme } from "../types";

/*
 * Gruvbox Light: the official palette, by Pavel Pertsev (morhetz).
 * Source: https://github.com/morhetz/gruvbox
 * License: MIT
 */
export const gruvboxLight: Theme = {
  id: "gruvbox-light",
  name: "Gruvbox Light",
  kind: "light",
  author: "Pavel Pertsev (morhetz)",
  source: "https://github.com/morhetz/gruvbox",
  license: "MIT",
  background: "#fbf1c7",
  foreground: "#3c3836",
  accent: "#af3a03",
  cursor: "#3c3836",
  selection: "#d5c4a1",
  ansi: {
    black: "#fbf1c7",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#7c6f64",
    brightBlack: "#928374",
    brightRed: "#9d0006",
    brightGreen: "#79740e",
    brightYellow: "#b57614",
    brightBlue: "#076678",
    brightMagenta: "#8f3f71",
    brightCyan: "#427b58",
    brightWhite: "#3c3836",
  },
  overrides: {
    field: "#ebdbb2",
    raised: "#d5c4a1",
    "line-strong": "#d5c4a1",
    ok: "#79740e",
    warn: "#b57614",
    err: "#9d0006",
    info: "#076678",
    keyword: "#9d0006",
    string: "#79740e",
    function: "#427b58",
    type: "#b57614",
    comment: "#928374",
  },
};
