import type { Theme } from "../types";

/*
 * Rosé Pine: the official palette, by Rosé Pine.
 * Source: https://rosepinetheme.com/palette
 * License: MIT
 */
export const rosePine: Theme = {
  id: "rose-pine",
  name: "Rosé Pine",
  kind: "dark",
  author: "Rosé Pine",
  source: "https://rosepinetheme.com/palette",
  license: "MIT",
  background: "#191724",
  foreground: "#e0def4",
  accent: "#c4a7e7",
  cursor: "#524f67",
  selection: "#403d52",
  ansi: {
    black: "#26233a",
    red: "#eb6f92",
    green: "#31748f",
    yellow: "#f6c177",
    blue: "#9ccfd8",
    magenta: "#c4a7e7",
    cyan: "#ebbcba",
    white: "#e0def4",
    brightBlack: "#6e6a86",
    brightRed: "#eb6f92",
    brightGreen: "#31748f",
    brightYellow: "#f6c177",
    brightBlue: "#9ccfd8",
    brightMagenta: "#c4a7e7",
    brightCyan: "#ebbcba",
    brightWhite: "#e0def4",
  },
  overrides: {
    field: "#1f1d2e",
    popover: "#1f1d2e",
    raised: "#26233a",
    "line-strong": "#403d52",
    "fg-mid": "#908caa",
    "fg-faint": "#6e6a86",
    comment: "#6e6a86",
    ok: "#9ccfd8",
    info: "#c4a7e7",
    keyword: "#31748f",
    string: "#f6c177",
    function: "#ebbcba",
    type: "#9ccfd8",
  },
};
