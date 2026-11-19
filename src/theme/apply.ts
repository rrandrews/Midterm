import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettings } from "../settings/settings";
import { cssVariables } from "./resolve";
import { currentResolvedTheme, noteThemeApplied, useThemeState } from "./state";
import type { ResolvedTheme } from "./types";

/*
 * Applying the showing theme everywhere: CSS variables and `color-scheme`
 * on <html>, then everyone who draws with theme colors outside CSS (xterm
 * sessions, blocks, CodeMirror's light/dark flag, plugins) through
 * `noteThemeApplied` (`subscribeThemeApplied`), and the native window (its
 * appearance and background, so resizing shows no wrong color).
 */

let applied: ResolvedTheme | null = null;

export function appliedTheme(): ResolvedTheme {
  return applied ?? currentResolvedTheme();
}

/** What the native window was last told, so it is only told again on a change. */
let nativeAppearance: "dark" | "light" | "system" | undefined;
let nativeBackground: string | undefined;

/**
 * The native window's appearance and background. While following the
 * system the appearance is left unforced (`null`): a forced appearance would
 * also pin the webview's `prefers-color-scheme`, which is how the system's
 * changes are noticed.
 */
function applyNative(theme: ResolvedTheme): void {
  if (!isTauri()) return;
  const window = getCurrentWindow();
  const appearance = useSettings.getState().themeFollowSystem ? "system" : theme.dark ? "dark" : "light";
  if (appearance !== nativeAppearance) {
    nativeAppearance = appearance;
    void window.setTheme(appearance === "system" ? null : appearance).catch((error) => console.warn("setTheme failed:", error));
  }
  if (theme.tokens.app !== nativeBackground) {
    nativeBackground = theme.tokens.app;
    void window.setBackgroundColor(theme.tokens.app).catch((error) => console.warn("setBackgroundColor failed:", error));
  }
}

export function applyTheme(theme: ResolvedTheme): void {
  // Following the system can be switched on without the theme changing.
  applyNative(theme);
  if (applied === theme) return;
  const previous = applied;
  applied = theme;
  const root = document.documentElement;
  const style = root.style;
  const vars = cssVariables(theme);
  // Variables the previous theme set and this one does not (a plugin's pane background).
  if (previous) for (const name of Object.keys(cssVariables(previous))) if (!(name in vars)) style.removeProperty(name);
  for (const [name, value] of Object.entries(vars)) style.setProperty(name, value);
  style.colorScheme = theme.dark ? "dark" : "light";
  root.dataset.theme = theme.kind;
  noteThemeApplied();
}

let installed = false;

/** Applies the current theme now (before the first render: no flash) and whenever it changes. */
export function installThemes(): void {
  if (installed) return;
  installed = true;
  const update = () => applyTheme(currentResolvedTheme());
  update();
  useSettings.subscribe(update);
  useThemeState.subscribe(update);
}
