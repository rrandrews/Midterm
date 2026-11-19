import { create } from "zustand";
import { type JsonFile, openJsonFile } from "../ipc/jsonFile";
import { DEFAULT_SETTINGS, type Settings, validateSettings } from "./schema";

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
  resetSettings: () => set({ ...DEFAULT_SETTINGS }),
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
  useSettings.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const settings = getSettings();
      const json = JSON.stringify(settings);
      if (json === lastSaved) return;
      lastSaved = json;
      void file?.set(KEY, settings).catch((error) => console.error("Could not save the settings:", error));
    }, SAVE_DELAY_MS);
  });
}
