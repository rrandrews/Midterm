import type { Theme } from "../types";
import { catppuccinLatte } from "./catppuccinLatte";
import { catppuccinMocha } from "./catppuccinMocha";
import { dracula } from "./dracula";
import { githubDark } from "./githubDark";
import { githubLight } from "./githubLight";
import { gruvboxDark } from "./gruvboxDark";
import { gruvboxLight } from "./gruvboxLight";
import { midtermDark } from "./midtermDark";
import { midtermLight } from "./midtermLight";
import { monokai } from "./monokai";
import { nord } from "./nord";
import { oneDark } from "./oneDark";
import { rosePine } from "./rosePine";
import { solarizedDark } from "./solarizedDark";
import { solarizedLight } from "./solarizedLight";
import { tokyoNight } from "./tokyoNight";

export { midtermDark, midtermLight };

/** The themes that ship with the app, in gallery order. Midterm Dark is the default. */
export const BUNDLED_THEMES: readonly Theme[] = [
  midtermDark,
  midtermLight,
  dracula,
  nord,
  solarizedDark,
  solarizedLight,
  gruvboxDark,
  gruvboxLight,
  tokyoNight,
  catppuccinMocha,
  catppuccinLatte,
  oneDark,
  githubDark,
  githubLight,
  rosePine,
  monokai,
];

export const DEFAULT_THEME_ID = midtermDark.id;
export const DEFAULT_LIGHT_THEME_ID = midtermLight.id;

/** A bundled theme by id. */
export function bundledTheme(id: string): Theme | undefined {
  return BUNDLED_THEMES.find((theme) => theme.id === id);
}
