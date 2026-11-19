import type { Theme } from "../types";

/*
 * Gruvbox Dark: the official palette, by Pavel Pertsev (morhetz).
 * Source: https://github.com/morhetz/gruvbox
 * License: MIT
 */
export const gruvboxDark: Theme = {
  id: "gruvbox-dark",
  name: "Gruvbox Dark",
  kind: "dark",
  author: "Pavel Pertsev (morhetz)",
  source: "https://github.com/morhetz/gruvbox",
  license: "MIT",
  background: "#282828",
  foreground: "#ebdbb2",
  accent: "#fe8019",
  cursor: "#ebdbb2",
  selection: "#504945",
  ansi: {
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
  overrides: {
    field: "#3c3836",
    popover: "#3c3836",
    raised: "#504945",
    "line-strong": "#504945",
    ok: "#b8bb26",
    warn: "#fabd2f",
    err: "#fb4934",
    info: "#83a598",
    keyword: "#fb4934",
    string: "#b8bb26",
    function: "#8ec07c",
    type: "#fabd2f",
    comment: "#928374",
  },
};
