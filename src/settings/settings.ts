import { create } from "zustand";
import { type JsonFile, openJsonFile } from "../ipc/jsonFile";
import {
  AI_OVERRIDABLE,
  DEFAULT_SETTINGS,
  OVERRIDABLE,
  type PluginEntry,
  type Settings,
  type SettingsOverrides,
  type WorkspaceSettings,
  effectiveSettings,
  isOverridden,
  validateOverrides,
  validateSettings,
  withoutOverride,
  workspaceEntry,
} from "./schema";

/*
 * The live settings, loaded from `settings.json` in the app data directory
 * before the first render and saved after every change. Components read
 * them with `useSettings(selector)`; other code with `getSettings()` and
 * `useSettings.subscribe`.
 *
 * The store's settings fields are the *effective* settings: the defaults
 * (`base`, what is saved) with the active workspace's overrides laid over
 * them, so switching workspaces switches the theme, fonts, shell and so on.
 * The settings dialog edits one scope at a time (`settingsFor`, the
 * `scope` argument of the actions; see `scope.tsx`). See docs/workspaces.md.
 */

const FILE = "settings.json";
const KEY = "settings";
const SAVE_DELAY_MS = 200;

/** Which settings an edit goes to: `"default"` (every workspace) or a workspace id. */
export type SettingsScope = string;
export const DEFAULT_SCOPE: SettingsScope = "default";

type SettingsActions = {
  /**
   * Merges `patch` into the settings (validated) and saves them. With a
   * scope, each overridable field goes to that scope; without one, to
   * where its current value comes from: the active workspace if it
   * overrides that field, otherwise the defaults. Fields no workspace may
   * override always go to the defaults.
   */
  updateSettings: (patch: Partial<Settings>, scope?: SettingsScope) => void;
  /** Sets one command's bindings; `null` restores its defaults. */
  setKeybinding: (commandId: string, bindings: string[] | null) => void;
  /** Merges `patch` into a plugin's entry (enabled flag, skill switches). */
  updatePluginEntry: (pluginId: string, patch: Partial<PluginEntry>) => void;
  /** Merges `patch` into a plugin's own settings (scoped like `updateSettings`). */
  updatePluginSettings: (pluginId: string, patch: Record<string, unknown>, scope?: SettingsScope) => void;
  /**
   * The defaults scope: every setting back to its default, keeping which
   * plugins are enabled, the skill switches, environment and workspaces. A
   * workspace scope: drops all its overrides but its Python environment.
   */
  resetSettings: (scope?: SettingsScope) => void;
  /** AI settings (scoped like `updateSettings`; profiles are always shared). */
  updateAi: (patch: Partial<Settings["ai"]>, scope?: SettingsScope) => void;
  /** Drops a workspace's override of the setting at `path` (see `isOverridden`). */
  clearOverride: (workspaceId: string, path: string) => void;
  /** Environment variables and secret names of a scope. */
  updateEnvironment: (scope: SettingsScope, patch: Partial<Pick<WorkspaceSettings, "env" | "secrets">>) => void;
  /** Forgets a workspace's settings (it was deleted). */
  removeWorkspaceSettings: (workspaceId: string) => void;
  /** The workspace whose settings are in effect. Wired to the app store in `src/workspaces/settings.ts`. */
  setActiveWorkspace: (workspaceId: string | null) => void;
};

type SettingsInternals = {
  /** The saved settings: the defaults scope, with every workspace's in `workspaces`. */
  base: Settings;
  activeWorkspace: string | null;
};

const EMPTY_WORKSPACE: WorkspaceSettings = { overrides: {}, env: [], secrets: [] };

/** Where a write without a scope goes, field by field. */
function autoScope(base: Settings, active: string | null, path: string): SettingsScope {
  return active && isOverridden(workspaceEntry(base, active)?.overrides, path) ? active : DEFAULT_SCOPE;
}

export const useSettings = create<Settings & SettingsInternals & SettingsActions>()((set, get) => {
  /** Sets new saved settings and recomputes the effective ones. */
  const commit = (base: Settings, active: string | null = get().activeWorkspace) => {
    set({ ...memoEffective(base, active), base, activeWorkspace: active });
  };
  const workspaceOf = (base: Settings, id: string) => workspaceEntry(base, id) ?? EMPTY_WORKSPACE;
  /** `base` with a workspace's overrides replaced (and normalized). */
  const withOverrides = (base: Settings, id: string, overrides: SettingsOverrides): Settings => ({
    ...base,
    workspaces: { ...base.workspaces, [id]: { ...workspaceOf(base, id), overrides: validateOverrides(overrides, base) } },
  });
  /**
   * Applies a write field by field: `paths` names each field's setting
   * path, `toBase` folds the fields meant for the defaults into the saved
   * settings, `toOverrides` the others into a workspace's overrides.
   */
  const write = (
    scope: SettingsScope | undefined,
    paths: string[],
    toBase: (base: Settings, paths: string[]) => Settings,
    toOverrides: (overrides: SettingsOverrides, paths: string[]) => SettingsOverrides,
  ) => {
    const { activeWorkspace } = get();
    let base = get().base;
    const byScope = new Map<SettingsScope, string[]>();
    for (const path of paths) {
      const target = scope ?? autoScope(base, activeWorkspace, path);
      byScope.set(target, [...(byScope.get(target) ?? []), path]);
    }
    for (const [target, fields] of byScope) {
      if (target === DEFAULT_SCOPE) base = toBase(base, fields);
      else base = withOverrides(base, target, toOverrides(workspaceOf(base, target).overrides, fields));
    }
    commit(base);
  };
  const isOverridable = (key: string) => (OVERRIDABLE as readonly string[]).includes(key);

  return {
    ...DEFAULT_SETTINGS,
    base: DEFAULT_SETTINGS,
    activeWorkspace: null,
    updateSettings: (patch, scope) => {
      const shared = Object.fromEntries(Object.entries(patch).filter(([key]) => !isOverridable(key)));
      if (Object.keys(shared).length) commit(keepWorkspaces(get().base, validateSettings({ ...get().base, ...shared })));
      const fields = Object.keys(patch).filter(isOverridable);
      if (!fields.length) return;
      write(
        scope,
        fields,
        (b, keys) => keepWorkspaces(b, validateSettings({ ...b, ...pick(patch, keys) })),
        (o, keys) => ({ ...o, ...(pick(patch, keys) as SettingsOverrides) }),
      );
    },
    setKeybinding: (commandId, bindings) => {
      const keybindings = { ...get().base.keybindings };
      if (bindings === null) delete keybindings[commandId];
      else keybindings[commandId] = bindings;
      commit({ ...get().base, keybindings });
    },
    updatePluginEntry: (pluginId, patch) => {
      const base = get().base;
      commit({ ...base, plugins: { ...base.plugins, [pluginId]: { ...base.plugins[pluginId], ...patch } } });
    },
    updatePluginSettings: (pluginId, patch, scope) => {
      const prefix = `plugins.${pluginId}.settings.`;
      write(
        scope,
        Object.keys(patch).map((key) => prefix + key),
        (b, paths) => {
          const entry = b.plugins[pluginId] ?? {};
          const values = pick(patch, paths.map((path) => path.slice(prefix.length)));
          return { ...b, plugins: { ...b.plugins, [pluginId]: { ...entry, settings: { ...entry.settings, ...values } } } };
        },
        (o, paths) => {
          const values = pick(patch, paths.map((path) => path.slice(prefix.length)));
          const current = o.plugins?.[pluginId]?.settings ?? {};
          return { ...o, plugins: { ...o.plugins, [pluginId]: { settings: { ...current, ...values } } } };
        },
      );
    },
    updateAi: (patch, scope) => {
      const overridable = (key: string) => (AI_OVERRIDABLE as readonly string[]).includes(key);
      const shared = Object.fromEntries(Object.entries(patch).filter(([key]) => !overridable(key)));
      if (Object.keys(shared).length) {
        // Profiles changed: workspace overrides are checked against them again.
        const base = get().base;
        commit(revalidateWorkspaces({ ...base, ai: validateSettings({ ...base, ai: { ...base.ai, ...shared } }).ai }));
      }
      const fields = Object.keys(patch).filter(overridable);
      if (!fields.length) return;
      write(
        scope,
        fields.map((key) => `ai.${key}`),
        (b, paths) => {
          const values = pick(patch, paths.map((path) => path.slice(3)));
          return { ...b, ai: validateSettings({ ...b, workspaces: {}, ai: { ...b.ai, ...values } }).ai };
        },
        (o, paths) => ({ ...o, ai: { ...o.ai, ...pick(patch, paths.map((path) => path.slice(3))) } }),
      );
    },
    resetSettings: (scope = DEFAULT_SCOPE) => {
      const base = get().base;
      if (scope !== DEFAULT_SCOPE) {
        // The Python environment belongs with the workspace's environment, which is kept.
        const python = workspaceEntry(base, scope)?.overrides.python;
        commit(withOverrides(base, scope, python ? { python } : {}));
        return;
      }
      const plugins: Record<string, PluginEntry> = {};
      for (const [id, entry] of Object.entries(base.plugins)) {
        const kept: PluginEntry = {};
        if (entry.enabled !== undefined) kept.enabled = entry.enabled;
        if (entry.skills) kept.skills = entry.skills;
        if (Object.keys(kept).length) plugins[id] = kept;
      }
      const { env, secrets, workspaces } = base;
      commit(revalidateWorkspaces({ ...DEFAULT_SETTINGS, plugins, env, secrets, workspaces }));
    },
    clearOverride: (workspaceId, path) => {
      const base = get().base;
      const workspace = workspaceEntry(base, workspaceId);
      if (!workspace || !isOverridden(workspace.overrides, path)) return;
      commit(withOverrides(base, workspaceId, withoutOverride(workspace.overrides, path)));
    },
    updateEnvironment: (scope, patch) => {
      const base = get().base;
      const env = patch.env && validateSettings({ env: patch.env }).env;
      const secrets = patch.secrets && validateSettings({ secrets: patch.secrets }).secrets;
      const changes = { ...(env && { env }), ...(secrets && { secrets }) };
      if (scope === DEFAULT_SCOPE) commit({ ...base, ...changes });
      else commit({ ...base, workspaces: { ...base.workspaces, [scope]: { ...workspaceOf(base, scope), ...changes } } });
    },
    removeWorkspaceSettings: (workspaceId) => {
      const base = get().base;
      if (!workspaceEntry(base, workspaceId)) return;
      const workspaces = { ...base.workspaces };
      delete workspaces[workspaceId];
      commit({ ...base, workspaces });
    },
    setActiveWorkspace: (workspaceId) => {
      if (workspaceId === get().activeWorkspace) return;
      commit(get().base, workspaceId);
    },
  };
});

function pick<T extends object>(source: T, keys: string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in source) out[key] = (source as Record<string, unknown>)[key];
  return out as Partial<T>;
}

/** `next` (validated without workspaces in mind) with `base`'s workspaces kept as they are. */
function keepWorkspaces(base: Settings, next: Settings): Settings {
  return { ...next, workspaces: base.workspaces };
}

/** Re-checks every workspace's overrides against `base` (after its profiles changed). */
function revalidateWorkspaces(base: Settings): Settings {
  const workspaces: Record<string, WorkspaceSettings> = {};
  for (const [id, workspace] of Object.entries(base.workspaces)) {
    workspaces[id] = { ...workspace, overrides: validateOverrides(workspace.overrides, base) };
  }
  return { ...base, workspaces };
}

/** The effective settings: the defaults with the active workspace's overrides. */
export function getSettings(): Settings {
  return pickSettings(useSettings.getState());
}

/**
 * The effective settings as one memoized object: the same object
 * `settingsFor` gives for the active workspace, so a scope's settings can
 * be compared with it to tell whether they are what is on screen.
 */
export function activeSettings(): Settings {
  const { base, activeWorkspace } = useSettings.getState();
  return memoEffective(base, activeWorkspace);
}

/** A scope's effective settings (memoized, so React selectors may return it). */
export function settingsFor(scope: SettingsScope, base: Settings = useSettings.getState().base): Settings {
  return memoEffective(base, scope === DEFAULT_SCOPE ? null : scope);
}

const effectiveCache = new WeakMap<Settings, Map<string, Settings>>();
function memoEffective(base: Settings, workspaceId: string | null): Settings {
  if (!workspaceId) return base;
  let byWorkspace = effectiveCache.get(base);
  if (!byWorkspace) {
    byWorkspace = new Map();
    effectiveCache.set(base, byWorkspace);
  }
  let settings = byWorkspace.get(workspaceId);
  if (!settings) {
    settings = effectiveSettings(base, workspaceId);
    byWorkspace.set(workspaceId, settings);
  }
  return settings;
}

/** A workspace's settings record (empty if it has none yet). */
export function workspaceSettings(workspaceId: string, base: Settings = useSettings.getState().base): WorkspaceSettings {
  return workspaceEntry(base, workspaceId) ?? EMPTY_WORKSPACE;
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
    if (saved !== undefined) {
      const base = validateSettings(saved);
      useSettings.setState({ ...memoEffective(base, useSettings.getState().activeWorkspace), base });
    }
  } catch (error) {
    console.error("Could not load the settings:", error);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSaved = JSON.stringify(useSettings.getState().base);
  const save = async () => {
    clearTimeout(timer);
    timer = undefined;
    const settings = useSettings.getState().base;
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
