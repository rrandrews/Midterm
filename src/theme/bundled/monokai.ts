import type { Theme } from "../types";

/*
 * Monokai: the official palette, by Wimer Hazenberg.
 * Source: https://monokai.nl
 * License: Unspecified (color palette only)
 */
export const monokai: Theme = {
  id: "monokai",
  name: "Monokai",
  kind: "dark",
  author: "Wimer Hazenberg",
  source: "https://monokai.nl",
  license: "Unspecified (color palette only)",
  background: "#272822",
  foreground: "#f8f8f2",
  accent: "#a6e22e",
  cursor: "#f8f8f0",
  selection: "#49483e",
  ansi: {
    black: "#272822",
    red: "#f92672",
    green: "#a6e22e",
    yellow: "#f4bf75",
    blue: "#66d9ef",
    magenta: "#ae81ff",
    cyan: "#a1efe4",
    white: "#f8f8f2",
    brightBlack: "#75715e",
    brightRed: "#f92672",
    brightGreen: "#a6e22e",
    brightYellow: "#f4bf75",
    brightBlue: "#66d9ef",
    brightMagenta: "#ae81ff",
    brightCyan: "#a1efe4",
    brightWhite: "#f9f8f5",
  },
  overrides: {
    comment: "#75715e",
    keyword: "#f92672",
    string: "#e6db74",
    function: "#a6e22e",
    type: "#66d9ef",
    warn: "#fd971f",
  },
};
