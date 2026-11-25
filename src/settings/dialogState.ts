import { create } from "zustand";
import { DEFAULT_SCOPE, type SettingsScope } from "./settings";

/*
 * Whether the settings dialog is open, at which section, and which scope
 * it edits (the defaults or a workspace). Its own module so sections can
 * steer the dialog without importing it.
 */

type DialogState = { open: boolean; section: string; scope: SettingsScope };

export const useSettingsDialog = create<DialogState>()(() => ({
  open: false,
  section: "general",
  scope: DEFAULT_SCOPE,
}));

/**
 * Asked before the open dialog leaves the section showing it (another
 * section, another scope, or closing): `true` to go at once, or a promise
 * of whether to go (after asking the user). A section with unsaved state
 * (the theme editor) registers one while it is shown.
 */
export type SettingsLeaveGuard = () => true | Promise<boolean>;

let leaveGuard: SettingsLeaveGuard | null = null;

/** Sets the guard for the section being shown; returns a function that removes it. */
export function guardSettingsLeave(guard: SettingsLeaveGuard): () => void {
  leaveGuard = guard;
  return () => {
    if (leaveGuard === guard) leaveGuard = null;
  };
}

/**
 * Changes what the dialog shows, asking the shown section's guard first
 * when the change leaves it. Applied at once when nothing needs asking.
 * Resolves to whether the change was made.
 */
export function changeSettingsDialog(patch: Partial<DialogState>): Promise<boolean> {
  const state = useSettingsDialog.getState();
  const leaving =
    state.open &&
    (patch.open === false || (patch.section !== undefined && patch.section !== state.section) || (patch.scope !== undefined && patch.scope !== state.scope));
  const verdict = leaving && leaveGuard ? leaveGuard() : true;
  const apply = (ok: boolean) => {
    if (ok) useSettingsDialog.setState(patch);
    return ok;
  };
  if (verdict === true) return Promise.resolve(apply(true));
  return verdict.then(apply, () => false);
}

/**
 * Opens the dialog at a section (a registered section's id, or
 * `plugin:<id>` for a plugin's own) editing `scope`: `"default"` or a
 * workspace id. Without a scope, an open dialog keeps the one it edits (a
 * link to another section), a closed one opens on the defaults.
 */
export function openSettings(section = "general", scope?: SettingsScope): void {
  const { open, scope: current } = useSettingsDialog.getState();
  void changeSettingsDialog({ open: true, section, scope: scope ?? (open ? current : DEFAULT_SCOPE) });
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

/** Closes the dialog (after the shown section's guard agrees). */
export function closeSettings(): void {
  void changeSettingsDialog({ open: false });
}

/** Switches the scope the open dialog edits, staying on the section if it exists there. */
export function setSettingsScope(scope: SettingsScope): void {
  void changeSettingsDialog({ scope });
}
