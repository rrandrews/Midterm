import { create } from "zustand";
import { DEFAULT_SCOPE, type SettingsScope } from "./settings";

/*
 * Whether the settings dialog is open, at which section, and which scope
 * it edits (the defaults or a workspace). Its own module so sections can
 * steer the dialog without importing it.
 */

export const useSettingsDialog = create<{ open: boolean; section: string; scope: SettingsScope }>()(() => ({
  open: false,
  section: "general",
  scope: DEFAULT_SCOPE,
}));

/**
 * Opens the dialog at a section (a registered section's id, or
 * `plugin:<id>` for a plugin's own) editing `scope`: `"default"` or a
 * workspace id. Without a scope, an open dialog keeps the one it edits (a
 * link to another section), a closed one opens on the defaults.
 */
export function openSettings(section = "general", scope?: SettingsScope): void {
  const { open, scope: current } = useSettingsDialog.getState();
  useSettingsDialog.setState({ open: true, section, scope: scope ?? (open ? current : DEFAULT_SCOPE) });
}

/**
 * The scope a plugin's own settings section is editing, while the dialog
 * shows it; otherwise `undefined`. The plugin API reads and writes the
 * plugin's settings in this scope, so a custom section edits the workspace
 * picked in the dialog.
 */
export function pluginSectionScope(pluginId: string): SettingsScope | undefined {
  const { open, section, scope } = useSettingsDialog.getState();
  return open && section === `plugin:${pluginId}` ? scope : undefined;
}

export function closeSettings(): void {
  useSettingsDialog.setState({ open: false });
}

/** Switches the scope the open dialog edits, staying on the section if it exists there. */
export function setSettingsScope(scope: SettingsScope): void {
  useSettingsDialog.setState({ scope });
}
