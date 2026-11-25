import type { LucideIcon } from "lucide-react";
import { type ComponentType, useSyncExternalStore } from "react";

/*
 * The settings dialog's sections, registered by the modules that own them
 * (General, Keyboard and Plugins in src/settings, Appearance and the theme
 * editor in src/theme, AI in src/ai). Each plugin also gets a section of
 * its own, generated from the plugin registry (see SettingsDialog).
 */

export type SettingsSection = {
  id: string;
  label: string;
  /** Position in the list; lower first. */
  order: number;
  component: ComponentType;
  /** Shown before the label in the dialog's list. */
  icon?: LucideIcon;
  /** Words the dialog's search also matches (setting names in the section). */
  keywords?: readonly string[];
  /**
   * Which scopes show the section: `all` (default; a workspace may
   * override its settings), `shared` (one value for every workspace, shown
   * with a note while a workspace is edited) or `workspace` (only while a
   * workspace is edited).
   */
  scope?: "all" | "shared" | "workspace";
};

const sections = new Map<string, SettingsSection>();
const listeners = new Set<() => void>();
let version = 0;

export function registerSettingsSection(section: SettingsSection): () => void {
  sections.set(section.id, section);
  version += 1;
  for (const listener of listeners) listener();
  return () => {
    if (sections.get(section.id) !== section) return;
    sections.delete(section.id);
    version += 1;
    for (const listener of listeners) listener();
  };
}

export function settingsSections(): SettingsSection[] {
  return [...sections.values()].sort((a, b) => a.order - b.order);
}

export function useSettingsSections(): SettingsSection[] {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  return settingsSections();
}
