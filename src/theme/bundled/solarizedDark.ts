import type { Theme } from "../types";

/*
 * Solarized Dark: the official palette, by Ethan Schoonover.
 * Source: https://ethanschoonover.com/solarized/
 * License: MIT
 */
export const solarizedDark: Theme = {
  id: "solarized-dark",
  name: "Solarized Dark",
  kind: "dark",
  author: "Ethan Schoonover",
  source: "https://ethanschoonover.com/solarized/",
  license: "MIT",
  background: "#002b36",
  foreground: "#839496",
  accent: "#268bd2",
  cursor: "#93a1a1",
  selection: "#073642",
  ansi: {
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#002b36",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  overrides: {
    field: "#073642",
    popover: "#073642",
    "fg-bright": "#93a1a1",
    comment: "#586e75",
    keyword: "#859900",
    string: "#2aa198",
    function: "#268bd2",
    type: "#b58900",
  },
};
