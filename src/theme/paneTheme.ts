import { useSyncExternalStore } from "react";
import type { Settings } from "../settings/schema";
import { activeSettings, getSettings, useSettings } from "../settings/settings";
import { normalizeHex } from "./color";
import { cssVariables, resolveTheme } from "./resolve";
import { DEFAULT_THEME_ID, bundledTheme } from "./bundled";
import {
  currentResolvedTheme,
  currentTheme,
  findTheme,
  selectedThemeId,
  subscribeThemeApplied,
  themeRevision,
  useThemeState,
  withAccent,
} from "./state";
import { type ResolvedTheme, type Theme, type TokenName, isTokenName } from "./types";

/*
 * A pane kind's own theme. Every plugin's settings section can pick a theme
 * for its panes other than the app's, override any token on top, and set
 * the pane background. It is saved in the plugin's settings under the
 * reserved key `$theme` (so a workspace can override it like any plugin
 * setting) and applied by PaneHost (CSS variables on the pane), terminal
 * sessions (xterm colors) and editors (CodeMirror's dark flag).
 */

/** The key in `settings.plugins[id].settings` that holds the pane theme. Not a valid field key. */
export const PANE_THEME_KEY = "$theme";

export type PaneTheme = {
  /** A theme id; unset follows the app's theme. */
  theme?: string;
  /** Token values that win over the theme's. */
  overrides?: Partial<Record<TokenName, string>>;
  /** The pane's background color, active or not. */
  background?: string;
};

/** A pane theme from untrusted data: unknown tokens and invalid colors dropped; `undefined` when nothing is left. */
export function validatePaneTheme(raw: unknown): PaneTheme | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const data = raw as Record<string, unknown>;
  const result: PaneTheme = {};
  if (typeof data.theme === "string" && data.theme) result.theme = data.theme;
  if (typeof data.overrides === "object" && data.overrides !== null && !Array.isArray(data.overrides)) {
    const overrides: Partial<Record<TokenName, string>> = {};
    for (const [token, value] of Object.entries(data.overrides)) {
      const color = typeof value === "string" ? normalizeHex(value) : null;
      if (isTokenName(token) && color) overrides[token] = color;
    }
    if (Object.keys(overrides).length) result.overrides = overrides;
  }
  const background = typeof data.background === "string" ? normalizeHex(data.background) : null;
  if (background) result.background = background;
  return Object.keys(result).length ? result : undefined;
}

/** The theme with a pane theme's overrides laid over its own. */
export function withPaneOverrides(theme: Theme, overrides: PaneTheme["overrides"]): Theme {
  if (!overrides || !Object.keys(overrides).length) return theme;
  return { ...theme, overrides: { ...theme.overrides, ...overrides } };
}

/** The pane theme a kind has in these settings (the active workspace's by default). */
export function paneThemeOf(kind: string, settings: Settings = getSettings()): PaneTheme | undefined {
  return validatePaneTheme(settings.plugins[kind]?.settings?.[PANE_THEME_KEY]);
}

/** The theme a scope's settings show (before its accent override). */
function scopeTheme(settings: Settings, systemDark: boolean): Theme {
  if (settings === activeSettings()) return currentTheme();
  return findTheme(selectedThemeId(settings, systemDark)) ?? (bundledTheme(DEFAULT_THEME_ID) as Theme);
}

/**
 * The theme a pane theme's overrides go on: the picked theme with its own
 * accent, else the app's (the scope's) with the accent override. An unknown
 * theme id (deleted) means the app's.
 */
export function paneBaseTheme(paneTheme: PaneTheme | undefined, settings: Settings, systemDark: boolean): Theme {
  const picked = paneTheme?.theme ? findTheme(paneTheme.theme) : undefined;
  if (picked) return picked;
  const app = scopeTheme(settings, systemDark);
  return settings.accent ? withAccentCached(app, settings.accent) : app;
}

// `withAccent` makes a new object; one per (theme, accent) keeps the caches below hitting.
const accented = new WeakMap<Theme, { accent: string; theme: Theme }>();
function withAccentCached(theme: Theme, accent: string): Theme {
  const hit = accented.get(theme);
  if (hit?.accent === accent) return hit.theme;
  const result = withAccent(theme, accent);
  accented.set(theme, { accent, theme: result });
  return result;
}

const cache = new Map<string, { base: Theme; json: string; resolved: ResolvedTheme }>();

/**
 * The resolved theme a pane of `kind` shows in a scope's settings, or `null`
 * when it shows the app's (no theme, no overrides).
 */
export function resolvePaneTheme(kind: string, settings: Settings, systemDark: boolean): ResolvedTheme | null {
  const paneTheme = paneThemeOf(kind, settings);
  if (!paneTheme?.theme && !paneTheme?.overrides) return null;
  const base = paneBaseTheme(paneTheme, settings, systemDark);
  const json = JSON.stringify(paneTheme.overrides ?? {});
  const key = `${kind}:${settings === activeSettings() ? "active" : "scope"}`;
  const hit = cache.get(key);
  if (hit && hit.base === base && hit.json === json) return hit.resolved;
  const resolved = resolveTheme(withPaneOverrides(base, paneTheme.overrides));
  cache.set(key, { base, json, resolved });
  return resolved;
}

/** The active workspace's theme for panes of `kind`, or `null` when they show the app's. */
export function paneResolvedTheme(kind: string): ResolvedTheme | null {
  return resolvePaneTheme(kind, getSettings(), useThemeState.getState().systemDark);
}

/** What a pane of `kind` is drawn with: its own theme, else the app's. */
export function effectivePaneTheme(kind: string): ResolvedTheme {
  return paneResolvedTheme(kind) ?? currentResolvedTheme();
}

/** The CSS variables and inherited properties PaneHost sets on a pane of `kind`; `undefined` when it follows the app. */
export function paneThemeStyle(kind: string): Record<string, string> | undefined {
  const paneTheme = paneThemeOf(kind);
  const resolved = paneResolvedTheme(kind);
  if (!resolved && !paneTheme?.background) return undefined;
  const style: Record<string, string> = {};
  if (resolved) {
    Object.assign(style, cssVariables(resolved));
    // Inherited values were computed from the app's variables higher up.
    style.color = resolved.tokens.fg;
    style.colorScheme = resolved.dark ? "dark" : "light";
  }
  if (paneTheme?.background) {
    style["--pane-bg"] = paneTheme.background;
    style["--pane-bg-active"] = paneTheme.background;
  }
  return style;
}

const styleCache = new Map<string, { json: string; style: Record<string, string> | undefined }>();

/** `paneThemeStyle` as a hook: follows the settings and the app's theme, stable while nothing changes. */
export function usePaneThemeStyle(kind: string): Record<string, string> | undefined {
  // The raw saved value, plus the theme revision for the app theme beneath it.
  const raw = useSettings((state) => state.plugins[kind]?.settings?.[PANE_THEME_KEY]);
  const revision = useSyncExternalStore(subscribeThemeApplied, themeRevision);
  const json = `${revision}:${JSON.stringify(raw ?? null)}`;
  const hit = styleCache.get(kind);
  if (hit && hit.json === json) return hit.style;
  const style = paneThemeStyle(kind);
  styleCache.set(kind, { json, style });
  return style;
}
