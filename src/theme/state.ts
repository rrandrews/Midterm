import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { type JsonFile, openJsonFile } from "../ipc/jsonFile";
import type { Settings } from "../settings/schema";
import { type SettingsScope, activeSettings, getSettings, settingsFor, useSettings } from "../settings/settings";
import { BUNDLED_THEMES, DEFAULT_THEME_ID, bundledTheme } from "./bundled";
import { resolveTheme } from "./resolve";
import type { ResolvedTheme, Theme } from "./types";
import { validateTheme } from "./validate";

/*
 * Which theme is showing. The settings pick a theme (or a light and a
 * dark one that follow the system); custom themes are kept in
 * `themes.json`. On top of that, two transient layers: a preview (the
 * palette's "Theme: Select…" while moving through the list) and a draft
 * (the theme editor's unsaved edits), which show instead while set.
 */

type ThemeState = {
  /** User themes: imported, duplicated or edited. */
  custom: Theme[];
  /** Shown while browsing themes; not saved. */
  preview: Theme | null;
  /** The theme editor's unsaved edits; shown while set. */
  draft: Theme | null;
  /** The system appearance is dark. */
  systemDark: boolean;
};

const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export const useThemeState = create<ThemeState>()(() => ({
  custom: [],
  preview: null,
  draft: null,
  systemDark: media?.matches ?? true,
}));

media?.addEventListener("change", (event) => useThemeState.setState({ systemDark: event.matches }));

/** Every theme: bundled first, then the user's. */
export function allThemes(): Theme[] {
  return [...BUNDLED_THEMES, ...useThemeState.getState().custom];
}

export function findTheme(id: string): Theme | undefined {
  return useThemeState.getState().custom.find((theme) => theme.id === id) ?? bundledTheme(id);
}

export function isBundled(id: string): boolean {
  return bundledTheme(id) !== undefined;
}

/** The id the settings pick, following the system if asked to. */
export function selectedThemeId(settings: Settings = getSettings(), systemDark = useThemeState.getState().systemDark): string {
  if (!settings.themeFollowSystem) return settings.theme;
  return systemDark ? settings.themeDark : settings.themeLight;
}

/** The theme that is showing, before the accent override: preview, else draft, else the selected one. */
export function currentTheme(): Theme {
  const { preview, draft } = useThemeState.getState();
  return preview ?? draft ?? findTheme(selectedThemeId()) ?? (bundledTheme(DEFAULT_THEME_ID) as Theme);
}

let cache: { theme: Theme; accent: string; resolved: ResolvedTheme } | null = null;

/** The showing theme, resolved, with the accent override applied. */
export function currentResolvedTheme(): ResolvedTheme {
  const theme = currentTheme();
  const accent = getSettings().accent;
  if (cache && cache.theme === theme && cache.accent === accent) return cache.resolved;
  const resolved = resolveTheme(accent ? withAccent(theme, accent) : theme);
  cache = { theme, accent, resolved };
  return resolved;
}

/** The theme with another accent; the accent-derived tokens follow it unless the theme overrides them. */
export function withAccent(theme: Theme, accent: string): Theme {
  const overrides = { ...theme.overrides };
  // Values pinned to the theme's own accent would no longer match.
  for (const key of ["accent", "accent-soft", "accent-fg", "terminal-cursor", "terminal-selection", "terminal-selection-inactive", "terminal-match", "terminal-match-active"] as const) {
    delete overrides[key];
  }
  return { ...theme, accent: accent.toLowerCase(), cursor: undefined, selection: undefined, overrides };
}

/*
 * Custom themes, saved in themes.json.
 */

const FILE = "themes.json";
let file: JsonFile | null = null;

export async function loadCustomThemes({ persist }: { persist: boolean }): Promise<void> {
  if (!persist) return;
  try {
    file = await openJsonFile(FILE);
    const saved = await file.get<unknown[]>("themes");
    if (!Array.isArray(saved)) return;
    const custom: Theme[] = [];
    for (const raw of saved) {
      const result = validateTheme(raw);
      if (result.ok && !isBundled(result.theme.id) && !custom.some((theme) => theme.id === result.theme.id)) {
        custom.push(result.theme);
      }
    }
    useThemeState.setState({ custom });
  } catch (error) {
    console.error("Could not load the custom themes:", error);
  }
}

function saveCustom(custom: Theme[]): void {
  useThemeState.setState({ custom });
  void file?.set("themes", custom).catch((error) => console.error("Could not save the themes:", error));
}

/** An id not used by any theme, from `base`. */
export function freeThemeId(base: string): string {
  const taken = new Set(allThemes().map((theme) => theme.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** A name not used by any theme, from `base`. */
export function freeThemeName(base: string): string {
  const taken = new Set(allThemes().map((theme) => theme.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Adds or replaces a custom theme (bundled ids are never replaced: the theme gets a new id). */
export function saveTheme(theme: Theme): Theme {
  const saved = isBundled(theme.id) ? { ...theme, id: freeThemeId(theme.id) } : theme;
  const custom = useThemeState.getState().custom;
  const index = custom.findIndex((candidate) => candidate.id === saved.id);
  saveCustom(index === -1 ? [...custom, saved] : custom.map((candidate, i) => (i === index ? saved : candidate)));
  return saved;
}

export function deleteTheme(id: string): void {
  saveCustom(useThemeState.getState().custom.filter((theme) => theme.id !== id));
  // Whatever pointed at it falls back to the defaults.
  const settings = getSettings();
  const patch: Partial<Settings> = {};
  if (settings.theme === id) patch.theme = DEFAULT_THEME_ID;
  if (settings.themeDark === id) patch.themeDark = DEFAULT_THEME_ID;
  if (settings.themeLight === id) patch.themeLight = "midterm-light";
  if (Object.keys(patch).length) useSettings.getState().updateSettings(patch);
}

/** A copy of a theme under a new id and name. */
export function duplicateTheme(id: string): Theme | undefined {
  const theme = findTheme(id);
  if (!theme) return undefined;
  const name = freeThemeName(`${theme.name} copy`);
  return saveTheme({ ...theme, id: freeThemeId(`${theme.id}-copy`), name });
}

export function renameTheme(id: string, name: string): void {
  const theme = useThemeState.getState().custom.find((candidate) => candidate.id === id);
  const trimmed = name.trim();
  if (theme && trimmed) saveTheme({ ...theme, name: trimmed });
}

/** Makes a theme the one showing (the light or dark pick when following the system). */
export function selectTheme(id: string, scope?: SettingsScope): void {
  const settings = scope ? settingsFor(scope) : getSettings();
  const theme = findTheme(id);
  if (!settings.themeFollowSystem || !theme) {
    useSettings.getState().updateSettings({ theme: id }, scope);
    return;
  }
  useSettings.getState().updateSettings(theme.kind === "dark" ? { themeDark: id } : { themeLight: id }, scope);
}

/**
 * The theme a scope's settings show, resolved with its accent. The active
 * workspace's (and outside the dialog): what is on screen, draft and
 * preview included.
 */
export function scopeResolvedTheme(settings: Settings, systemDark: boolean): ResolvedTheme {
  if (settings === activeSettings()) return currentResolvedTheme();
  const theme = findTheme(selectedThemeId(settings, systemDark)) ?? (bundledTheme(DEFAULT_THEME_ID) as Theme);
  return resolveTheme(settings.accent ? withAccent(theme, settings.accent) : theme);
}

/*
 * Revision: bumped whenever the applied theme changes, for views that
 * render with theme colors (blocks).
 */

let revision = 0;
const listeners = new Set<() => void>();

export function noteThemeApplied(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function subscribeThemeApplied(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function themeRevision(): number {
  return revision;
}

/** Re-renders when the theme changes; returns a number to put in memo dependencies. */
export function useThemeRevision(): number {
  return useSyncExternalStore(subscribeThemeApplied, themeRevision);
}
