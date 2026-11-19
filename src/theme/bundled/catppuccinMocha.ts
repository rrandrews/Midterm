import type { Theme } from "../types";

/*
 * Catppuccin Mocha: the official palette, by Catppuccin.
 * Source: https://catppuccin.com/palette
 * License: MIT
 */
export const catppuccinMocha: Theme = {
  id: "catppuccin-mocha",
  name: "Catppuccin Mocha",
  kind: "dark",
  author: "Catppuccin",
  source: "https://catppuccin.com/palette",
  license: "MIT",
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  accent: "#cba6f7",
  cursor: "#f5e0dc",
  selection: "#585b70",
  ansi: {
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  },
  overrides: {
    field: "#313244",
    popover: "#181825",
    raised: "#45475a",
    "line-strong": "#45475a",
    "fg-soft": "#bac2de",
    "fg-mid": "#a6adc8",
    comment: "#9399b2",
    "fg-faint": "#6c7086",
    keyword: "#cba6f7",
    type: "#f9e2af",
    warn: "#fab387",
  },
};
