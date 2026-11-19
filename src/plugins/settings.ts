import { useSettings } from "../settings/settings";
import type { Settings } from "../settings/schema";
import { getSettings } from "../settings/settings";
import { type SettingField, resolveFields } from "./fields";
import { getPlugin } from "./registry";

/*
 * Reading a plugin's own settings: the raw values saved under
 * `settings.plugins[id].settings`, validated against the plugin's declared
 * fields (invalid or missing values give the field's default).
 */

const cache = new WeakMap<object, Map<string, Record<string, unknown>>>();
const EMPTY = {};

/** The plugin's settings, resolved against `fields` (by default the plugin's declared fields). */
export function pluginSettings(
  pluginId: string,
  fields: readonly SettingField[] | undefined = getPlugin(pluginId)?.plugin.settings?.fields,
  settings: Settings = getSettings(),
): Record<string, unknown> {
  const raw = settings.plugins[pluginId]?.settings ?? EMPTY;
  // No declared fields: the saved object itself (stable, so React sees no change).
  if (!fields) return raw;
  // Resolved once per saved object, so callers get a stable value to compare.
  let byPlugin = cache.get(raw);
  if (!byPlugin) {
    byPlugin = new Map();
    cache.set(raw, byPlugin);
  }
  const key = `${pluginId}:${fields.map((field) => field.key).join(",")}`;
  let resolved = byPlugin.get(key);
  if (!resolved) {
    resolved = resolveFields(fields, raw);
    byPlugin.set(key, resolved);
  }
  return resolved;
}

/** `pluginSettings` as a React hook. */
export function usePluginSettings(pluginId: string, fields?: readonly SettingField[]): Record<string, unknown> {
  return useSettings((state) => pluginSettings(pluginId, fields ?? getPlugin(pluginId)?.plugin.settings?.fields, state));
}
