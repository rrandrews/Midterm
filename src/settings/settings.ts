import { create } from "zustand";
import { type JsonFile, openJsonFile } from "../ipc/jsonFile";
import { DEFAULT_SETTINGS, type PluginEntry, type Settings, validateSettings } from "./schema";

/*
 * The live settings, loaded from `settings.json` in the app data directory
 * before the first render and saved after every change. Components read
 * them with `useSettings(selector)`; other code with `getSettings()` and
 * `useSettings.subscribe`.
 */

const FILE = "settings.json";
const KEY = "settings";
const SAVE_DELAY_MS = 200;

type SettingsActions = {
  /** Merges `patch` into the settings (validated) and saves them. */
  updateSettings: (patch: Partial<Settings>) => void;
  /** Sets one command's bindings; `null` restores its defaults. */
  setKeybinding: (commandId: string, bindings: string[] | null) => void;
  /** Merges `patch` into a plugin's entry (enabled flag, skill switches). */
  updatePluginEntry: (pluginId: string, patch: Partial<PluginEntry>) => void;
  /** Merges `patch` into a plugin's own settings. */
  updatePluginSettings: (pluginId: string, patch: Record<string, unknown>) => void;
  resetSettings: () => void;
};

export const useSettings = create<Settings & SettingsActions>()((set, get) => ({
  ...DEFAULT_SETTINGS,
  updateSettings: (patch) => set(validateSettings({ ...pickSettings(get()), ...patch })),
  setKeybinding: (commandId, bindings) => {
    const keybindings = { ...get().keybindings };
    if (bindings === null) delete keybindings[commandId];
    else keybindings[commandId] = bindings;
    set({ keybindings });
  },
  updatePluginEntry: (pluginId, patch) => {
    const plugins = get().plugins;
    set({ plugins: { ...plugins, [pluginId]: { ...plugins[pluginId], ...patch } } });
  },
  updatePluginSettings: (pluginId, patch) => {
    const plugins = get().plugins;
    const entry = plugins[pluginId] ?? {};
    set({ plugins: { ...plugins, [pluginId]: { ...entry, settings: { ...entry.settings, ...patch } } } });
  },
  /** Keeps which plugins are enabled and the skill switches: those are managed in the Plugins section. */
  resetSettings: () => {
    const plugins: Record<string, PluginEntry> = {};
    for (const [id, entry] of Object.entries(get().plugins)) {
      const kept: PluginEntry = {};
      if (entry.enabled !== undefined) kept.enabled = entry.enabled;
      if (entry.skills) kept.skills = entry.skills;
      if (Object.keys(kept).length) plugins[id] = kept;
    }
    set({ ...DEFAULT_SETTINGS, plugins });
  },
}));

export function getSettings(): Settings {
  return pickSettings(useSettings.getState());
}

/** Just the settings fields of the store state (no actions). */
function pickSettings(state: Settings): Settings {
  const settings = {} as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    settings[key] = state[key as keyof Settings];
  }
  return settings as Settings;
}

let file: JsonFile | null = null;

/**
 * Loads the settings file and starts saving changes to it. Never throws: a
 * missing or broken file means defaults. `persist: false` (dev seeds,
 * self-tests) keeps the defaults and saves nothing.
 */
export async function loadSettings({ persist }: { persist: boolean }): Promise<void> {
  if (!persist) return;
  try {
    file = await openJsonFile(FILE);
    const saved = await file.get(KEY);
    if (saved !== undefined) useSettings.setState(validateSettings(saved));
  } catch (error) {
    console.error("Could not load the settings:", error);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSaved = JSON.stringify(getSettings());
  const save = async () => {
    clearTimeout(timer);
    timer = undefined;
    const settings = getSettings();
    const json = JSON.stringify(settings);
    if (json === lastSaved) return;
    lastSaved = json;
    await file?.set(KEY, settings).catch((error) => console.error("Could not save the settings:", error));
  };
  flushPending = save;
  useSettings.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_DELAY_MS);
  });
  window.addEventListener("pagehide", () => void save());
}

let flushPending: (() => Promise<void>) | null = null;

/** Writes a pending change now, e.g. before quitting. */
export async function flushSettings(): Promise<void> {
  await flushPending?.();
}
