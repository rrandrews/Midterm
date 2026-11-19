import type { Theme } from "../types";

/*
 * Dracula: the official palette, by Zeno Rocha.
 * Source: https://draculatheme.com
 * License: MIT
 */
export const dracula: Theme = {
  id: "dracula",
  name: "Dracula",
  kind: "dark",
  author: "Zeno Rocha",
  source: "https://draculatheme.com",
  license: "MIT",
  background: "#282a36",
  foreground: "#f8f8f2",
  accent: "#bd93f9",
  cursor: "#f8f8f2",
  selection: "#44475a",
  ansi: {
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  overrides: {
    comment: "#6272a4",
    keyword: "#ff79c6",
    function: "#50fa7b",
    string: "#f1fa8c",
    type: "#8be9fd",
    warn: "#ffb86c",
  },
};
