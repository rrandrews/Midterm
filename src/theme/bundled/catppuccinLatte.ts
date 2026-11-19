import type { Theme } from "../types";

/*
 * Catppuccin Latte: the official palette, by Catppuccin.
 * Source: https://catppuccin.com/palette
 * License: MIT
 */
export const catppuccinLatte: Theme = {
  id: "catppuccin-latte",
  name: "Catppuccin Latte",
  kind: "light",
  author: "Catppuccin",
  source: "https://catppuccin.com/palette",
  license: "MIT",
  background: "#eff1f5",
  foreground: "#4c4f69",
  accent: "#8839ef",
  cursor: "#dc8a78",
  selection: "#acb0be",
  ansi: {
    black: "#5c5f77",
    red: "#d20f39",
    green: "#40a02b",
    yellow: "#df8e1d",
    blue: "#1e66f5",
    magenta: "#ea76cb",
    cyan: "#179299",
    white: "#acb0be",
    brightBlack: "#6c6f85",
    brightRed: "#d20f39",
    brightGreen: "#40a02b",
    brightYellow: "#df8e1d",
    brightBlue: "#1e66f5",
    brightMagenta: "#ea76cb",
    brightCyan: "#179299",
    brightWhite: "#bcc0cc",
  },
  overrides: {
    field: "#e6e9ef",
    raised: "#ccd0da",
    "line-strong": "#ccd0da",
    "fg-soft": "#5c5f77",
    "fg-mid": "#6c6f85",
    comment: "#7c7f93",
    "fg-faint": "#9ca0b0",
    keyword: "#8839ef",
    warn: "#fe640b",
  },
};
