import { type ComponentType, useSyncExternalStore } from "react";

/*
 * The settings dialog's sections, registered by the modules that own them
 * (General and Keyboard in the dialog itself, Plugins, later Appearance and
 * AI). Each plugin also gets a section of its own, generated from the
 * plugin registry (see SettingsDialog).
 */

export type SettingsSection = {
  id: string;
  label: string;
  /** Position in the list; lower first. */
  order: number;
  component: ComponentType;
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
