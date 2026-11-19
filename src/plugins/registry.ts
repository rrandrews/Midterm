import { useSyncExternalStore } from "react";
import { getCommand, registerCommands } from "../commands/registry";
import { getSettings, useSettings } from "../settings/settings";
import type { MidtermApi } from "./api";
import { PLUGIN_ID_PATTERN, type PanePlugin, type PaneSpec, type PluginSource } from "./types";

/*
 * The plugin registry: every pane plugin, built in or imported, with where
 * it came from and whether it is enabled (`settings.plugins[id].enabled`,
 * on unless set to false; a `required` plugin is always on).
 *
 * Enabling a plugin activates it: its commands are registered and its
 * `activate` runs with an API scoped to it. Disabling undoes both. Panes
 * of a disabled or missing plugin stay in their layouts and show a
 * placeholder (see `PaneHost`).
 */

export type RegisteredPlugin = {
  plugin: PanePlugin;
  source: PluginSource;
  /** Set when activating failed. */
  error?: string;
};

type Entry = RegisteredPlugin & { deactivate?: () => void };

const plugins = new Map<string, Entry>();
/** Imported plugins that could not be loaded at all, by id (shown in Settings → Plugins). */
const loadErrors = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
let apiFactory: ((pluginId: string) => MidtermApi) | null = null;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * Registers a plugin (replacing one with the same id, which is deactivated
 * first). Returns a function that unregisters it.
 */
export function registerPlugin(plugin: PanePlugin, source: PluginSource = { type: "builtin" }): () => void {
  if (!PLUGIN_ID_PATTERN.test(plugin.id)) throw new Error(`Invalid plugin id "${plugin.id}"`);
  const previous = plugins.get(plugin.id);
  if (previous) deactivate(previous);
  const entry: Entry = { plugin, source };
  plugins.set(plugin.id, entry);
  loadErrors.delete(plugin.id);
  syncActivation();
  changed();
  return () => {
    if (plugins.get(plugin.id) !== entry) return;
    unregisterPlugin(plugin.id);
  };
}

export function unregisterPlugin(id: string): void {
  const entry = plugins.get(id);
  if (!entry) return;
  deactivate(entry);
  plugins.delete(id);
  changed();
}

/** Records that an imported plugin could not be loaded (or clears it with `null`). */
export function setLoadError(id: string, error: string | null): void {
  if (error === null) loadErrors.delete(id);
  else loadErrors.set(id, error);
  changed();
}

export function loadErrorOf(id: string): string | undefined {
  return loadErrors.get(id);
}

export function loadErrorIds(): string[] {
  return [...loadErrors.keys()];
}

/** The plugin with this id, enabled or not. */
export function getPlugin(id: string): RegisteredPlugin | undefined {
  return plugins.get(id);
}

/** Every registered plugin, built-ins first, in registration order. */
export function allPlugins(): RegisteredPlugin[] {
  const list = [...plugins.values()];
  return [...list.filter((entry) => entry.source.type === "builtin"), ...list.filter((entry) => entry.source.type !== "builtin")];
}

/** Whether the plugin is switched on in the settings (whether or not it is registered). */
export function isPluginEnabled(id: string, settings = getSettings()): boolean {
  if (plugins.get(id)?.plugin.required) return true;
  return settings.plugins[id]?.enabled !== false;
}

/** An imported plugin known only from its manifest (disabled, loading, or failed to load). */
export function isStub(entry: RegisteredPlugin | undefined): boolean {
  return entry?.source.type === "imported" && entry.source.stub === true;
}

/** Registered, enabled and loaded plugins, in `allPlugins` order: what panes can be created with. */
export function enabledPlugins(): PanePlugin[] {
  return allPlugins()
    .filter((entry) => !isStub(entry) && isPluginEnabled(entry.plugin.id))
    .map((entry) => entry.plugin);
}

/** The plugin that renders panes of `kind`, if it is registered, loaded and enabled. */
export function activePlugin(kind: string): PanePlugin | undefined {
  const entry = plugins.get(kind);
  return entry && !isStub(entry) && isPluginEnabled(kind) ? entry.plugin : undefined;
}

/** The pane contract of `kind`'s plugin, if it is registered and enabled. */
export function paneSpec(kind: string): PaneSpec | undefined {
  return activePlugin(kind)?.pane;
}

/** A display name for a pane kind, even one whose plugin is missing. */
export function kindLabel(kind: string): string {
  return plugins.get(kind)?.plugin.name ?? kind;
}

/** Calls `listener` when plugins are registered, removed, enabled or disabled. */
export function subscribePlugins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pluginsVersion(): number {
  return version;
}

/** Re-renders the component when the plugin registry changes. */
export function usePluginsVersion(): number {
  return useSyncExternalStore(subscribePlugins, pluginsVersion);
}

/*
 * Activation.
 */

/**
 * Supplies the API factory (src/plugins/api.ts) and activates what is
 * enabled. Until then nothing is activated, which keeps the registry free
 * of an import cycle with the app's actions.
 */
export function installPluginHost(factory: (pluginId: string) => MidtermApi): void {
  apiFactory = factory;
  syncActivation();
}

/** The API instance of an active plugin (for skills and custom settings sections). */
const apis = new Map<string, MidtermApi>();

export function apiOf(pluginId: string): MidtermApi | undefined {
  if (!apiFactory) return undefined;
  let api = apis.get(pluginId);
  if (!api) {
    api = apiFactory(pluginId);
    apis.set(pluginId, api);
  }
  return api;
}

function activate(entry: Entry): void {
  const { plugin } = entry;
  const api = apiOf(plugin.id);
  if (!api) return;
  const cleanups: (() => void)[] = [];
  try {
    // A plugin may not take over another command's id (it would be lost when the plugin goes).
    const commands = (plugin.commands ?? []).filter((command) => {
      const taken = getCommand(command.id) !== undefined;
      if (taken) console.warn(`Plugin ${plugin.id}: command id "${command.id}" is already taken; ignored.`);
      return !taken;
    });
    if (commands.length) cleanups.push(registerCommands(commands));
    const result = plugin.activate?.(api);
    if (typeof result === "function") cleanups.push(result);
    entry.error = undefined;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    console.error(`Plugin ${plugin.id} failed to activate:`, error);
  }
  entry.deactivate = () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        console.error(`Plugin ${plugin.id} failed to deactivate:`, error);
      }
    }
  };
}

function deactivate(entry: Entry): void {
  const stop = entry.deactivate;
  entry.deactivate = undefined;
  stop?.();
}

function syncActivation(): void {
  if (!apiFactory) return;
  for (const entry of plugins.values()) {
    const wanted = isPluginEnabled(entry.plugin.id);
    if (wanted && !entry.deactivate) activate(entry);
    else if (!wanted && entry.deactivate) deactivate(entry);
  }
}

let lastEnabled = enabledKey();

function enabledKey(): string {
  const entries = getSettings().plugins;
  return Object.keys(entries)
    .filter((id) => entries[id].enabled === false)
    .sort()
    .join(",");
}

useSettings.subscribe(() => {
  const key = enabledKey();
  if (key === lastEnabled) return;
  lastEnabled = key;
  syncActivation();
  changed();
});
