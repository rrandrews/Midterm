import type { Theme } from "../types";

/*
 * Solarized Light: the official palette, by Ethan Schoonover.
 * Source: https://ethanschoonover.com/solarized/
 * License: MIT
 */
export const solarizedLight: Theme = {
  id: "solarized-light",
  name: "Solarized Light",
  kind: "light",
  author: "Ethan Schoonover",
  source: "https://ethanschoonover.com/solarized/",
  license: "MIT",
  background: "#fdf6e3",
  foreground: "#657b83",
  accent: "#268bd2",
  cursor: "#586e75",
  selection: "#eee8d5",
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
    field: "#eee8d5",
    raised: "#e4ddc8",
    "fg-bright": "#586e75",
    "fg-muted": "#839496",
    comment: "#93a1a1",
    keyword: "#859900",
    string: "#2aa198",
    function: "#268bd2",
    type: "#b58900",
  },
};
