import { createContext, useContext, useMemo } from "react";
import type { Settings } from "./schema";
import { type SettingsScope, DEFAULT_SCOPE, settingsFor, useSettings } from "./settings";
import { isOverridden, workspaceEntry } from "./schema";

/*
 * The scope the settings dialog is editing: the defaults or one workspace.
 * Sections read and write through these hooks so the same component edits
 * either. Outside the dialog (no provider) they read the effective
 * settings and write the way the store's actions do without a scope.
 */

const ScopeContext = createContext<SettingsScope | undefined>(undefined);

export const SettingsScopeProvider = ScopeContext.Provider;

/** The scope being edited; `undefined` outside the settings dialog. */
export function useSettingsScope(): SettingsScope | undefined {
  return useContext(ScopeContext);
}

/** The workspace being edited, or `null` when editing the defaults (or outside the dialog). */
export function useEditedWorkspace(): string | null {
  const scope = useSettingsScope();
  return scope && scope !== DEFAULT_SCOPE ? scope : null;
}

/** `useSettings(selector)` over the edited scope's effective settings. */
export function useScopedSettings<T>(selector: (settings: Settings) => T): T {
  const scope = useSettingsScope();
  return useSettings((state) => selector(scope === undefined ? state : settingsFor(scope, state.base)));
}

/** The store's actions, writing to the edited scope. */
export function useScopedActions() {
  const scope = useSettingsScope();
  return useMemo(() => {
    const store = () => useSettings.getState();
    return {
      scope,
      updateSettings: (patch: Partial<Settings>) => store().updateSettings(patch, scope),
      updatePluginSettings: (pluginId: string, patch: Record<string, unknown>) =>
        store().updatePluginSettings(pluginId, patch, scope),
      updateAi: (patch: Partial<Settings["ai"]>) => store().updateAi(patch, scope),
      resetSettings: () => store().resetSettings(scope ?? DEFAULT_SCOPE),
    };
  }, [scope]);
}

/**
 * Whether the edited workspace overrides the setting at `path`, and how to
 * drop the override. Never overridden when editing the defaults.
 */
export function useOverride(path: string | undefined): { overridden: boolean; reset: () => void } {
  const workspace = useEditedWorkspace();
  const overridden = useSettings((state) =>
    !!workspace && !!path && isOverridden(workspaceEntry(state.base, workspace)?.overrides, path),
  );
  return useMemo(
    () => ({
      overridden,
      reset: () => {
        if (workspace && path) useSettings.getState().clearOverride(workspace, path);
      },
    }),
    [overridden, workspace, path],
  );
}
