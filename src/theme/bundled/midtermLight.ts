import type { Theme } from "../types";

/*
 * Midterm Light: the light counterpart of Midterm Dark. Same cool graphite
 * neutrals (hue about 270) and the same periwinkle accent, darkened for contrast
 * on a light background; ANSI hues follow Midterm Dark's, tuned for light.
 * Author: Midterm. License: same as the app.
 */
export const midtermLight: Theme = {
  id: "midterm-light",
  name: "Midterm Light",
  kind: "light",
  author: "Midterm",
  background: "#f6f7f9",
  foreground: "#1f2329",
  accent: "#4f5fd6",
  ansi: {
    black: "#24272e",
    red: "#c4424b",
    green: "#2f8040",
    yellow: "#a4670c",
    blue: "#2f6bd0",
    magenta: "#7c4fd0",
    cyan: "#13857b",
    white: "#6e7480",
    brightBlack: "#575c66",
    brightRed: "#d6545d",
    brightGreen: "#3d9450",
    brightYellow: "#ba7a1a",
    brightBlue: "#4580e0",
    brightMagenta: "#9064e0",
    brightCyan: "#1f9a8f",
    brightWhite: "#8a909b",
  },
  overrides: {
    "fg-bright": "#0f1115",
    comment: "#7a808c",
  },
};
