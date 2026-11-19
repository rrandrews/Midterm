import type { Theme } from "../types";

/*
 * One Dark: the official palette, by GitHub (Atom).
 * Source: https://github.com/atom/atom/tree/master/packages/one-dark-syntax
 * License: MIT
 */
export const oneDark: Theme = {
  id: "one-dark",
  name: "One Dark",
  kind: "dark",
  author: "GitHub (Atom)",
  source: "https://github.com/atom/atom/tree/master/packages/one-dark-syntax",
  license: "MIT",
  background: "#282c34",
  foreground: "#abb2bf",
  accent: "#61afef",
  cursor: "#528bff",
  selection: "#3e4451",
  ansi: {
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
  overrides: {
    comment: "#5c6370",
    keyword: "#c678dd",
    function: "#61afef",
    string: "#98c379",
    type: "#e5c07b",
    punctuation: "#abb2bf",
  },
};
