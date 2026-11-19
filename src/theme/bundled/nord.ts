import type { Theme } from "../types";

/*
 * Nord: the official palette, by Arctic Ice Studio and Sven Greb.
 * Source: https://www.nordtheme.com
 * License: MIT
 */
export const nord: Theme = {
  id: "nord",
  name: "Nord",
  kind: "dark",
  author: "Arctic Ice Studio and Sven Greb",
  source: "https://www.nordtheme.com",
  license: "MIT",
  background: "#2e3440",
  foreground: "#d8dee9",
  accent: "#88c0d0",
  cursor: "#d8dee9",
  selection: "#434c5e",
  ansi: {
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  overrides: {
    field: "#3b4252",
    popover: "#3b4252",
    raised: "#434c5e",
    "line-strong": "#434c5e",
    comment: "#616e88",
    keyword: "#81a1c1",
    function: "#88c0d0",
    type: "#8fbcbb",
  },
};
