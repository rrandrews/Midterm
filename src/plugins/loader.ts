import { create } from "zustand";
import { confirm } from "../components/ui/ConfirmDialog";
import {
  type InstalledPlugin,
  importPlugin,
  isPluginError,
  listPlugins,
  pickPluginSource,
  pluginFileUrl,
  removePlugin,
} from "../ipc/plugins";
import { useSettings } from "../settings/settings";
import { API_VERSION } from "./api";
import { checkFields } from "./fields";
import { getPlugin, isPluginEnabled, registerPlugin, setLoadError, unregisterPlugin } from "./registry";
import { parseSkillFile } from "./skillFiles";
import { setFileSkills } from "./skills";
import { PLUGIN_ID_PATTERN, type PanePlugin, type Skill } from "./types";

/*
 * Imported plugins: folders in `<app data>/plugins/` (see src/ipc/plugins.ts)
 * holding a manifest and an ES module, loaded into the main window with
 * the app's full access (they are trusted; importing one shows a warning).
 *
 * Enabled plugins load after startup. A disabled one is registered as a
 * stub from its manifest only (listed in the settings, its panes show a
 * placeholder) and its code is not run until it is enabled. A plugin that
 * fails to load is reported and leaves the rest of the app alone.
 */

type LoaderState = {
  installed: InstalledPlugin[];
  /** Ids being loaded right now. */
  loading: string[];
};

export const useInstalledPlugins = create<LoaderState>()(() => ({ installed: [], loading: [] }));

/** Bumped on every (re)load, so the module URLs change and a replaced plugin's new code runs. */
let generation = 0;
/** The latest load started per plugin id; a load that finishes after a newer one (or a removal) is dropped. */
const latestLoad = new Map<string, number>();

function stubOf(info: InstalledPlugin): PanePlugin | null {
  const manifest = info.manifest;
  if (!manifest) return null;
  return { id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description, pane: {} };
}

function fileSkillsOf(info: InstalledPlugin): { skills: Skill[]; problems: string[] } {
  const skills: Skill[] = [];
  const problems: string[] = [];
  for (const file of info.skills) {
    const parsed = parseSkillFile(file.path, file.content);
    if (typeof parsed === "string") problems.push(parsed);
    else skills.push(parsed);
  }
  return { skills, problems };
}

/** Problems with what a module exported, before it is registered. */
export function checkPluginExport(plugin: unknown, expectedId: string): string[] {
  if (typeof plugin !== "object" || plugin === null) return ["the module's default export is not a plugin object"];
  const { id, name, pane, settings, terminal } = plugin as Record<string, unknown>;
  const problems: string[] = [];
  if (id !== expectedId) problems.push(`the plugin's id "${String(id)}" does not match the manifest's "${expectedId}"`);
  if (typeof name !== "string" || !name) problems.push("the plugin has no name");
  if (terminal !== undefined && typeof terminal !== "boolean") problems.push("`terminal` must be true or false");
  if (typeof pane !== "object" || pane === null) problems.push("the plugin has no pane");
  else {
    const { component, mount, optionsMenu, hideMenuItems } = pane as Record<string, unknown>;
    if (typeof component !== "function" && typeof mount !== "function") problems.push("pane needs a component or a mount function");
    if (optionsMenu !== undefined && typeof optionsMenu !== "function") problems.push("`pane.optionsMenu` must be a function");
    if (hideMenuItems !== undefined && !Array.isArray(hideMenuItems) && typeof hideMenuItems !== "function") {
      problems.push("`pane.hideMenuItems` must be a list or a function");
    }
  }
  const fields = (settings as Record<string, unknown> | undefined)?.fields;
  if (fields !== undefined) problems.push(...checkFields(fields));
  return problems;
}

const styles = new Map<string, HTMLLinkElement>();

function setStyle(id: string, href: string | null): void {
  styles.get(id)?.remove();
  styles.delete(id);
  if (!href) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.plugin = id;
  document.head.append(link);
  styles.set(id, link);
}

async function loadModule(info: InstalledPlugin): Promise<void> {
  const manifest = info.manifest;
  if (!manifest) return;
  const id = manifest.id;
  const version = ++generation;
  latestLoad.set(id, version);
  useInstalledPlugins.setState((state) => ({ loading: [...state.loading, id] }));
  try {
    if (manifest.apiVersion !== API_VERSION) throw new Error(`apiVersion ${manifest.apiVersion} is not supported`);
    const module = (await import(/* @vite-ignore */ pluginFileUrl(id, manifest.main, version))) as { default?: unknown };
    if (latestLoad.get(id) !== version) return;
    const plugin = module.default;
    const problems = checkPluginExport(plugin, id);
    if (problems.length) throw new Error(problems.join("; "));
    setStyle(id, manifest.style && isPluginEnabled(id) ? pluginFileUrl(id, manifest.style, version) : null);
    registerPlugin(
      { ...(plugin as PanePlugin), version: manifest.version },
      { type: "imported", dir: info.dir, author: manifest.author },
    );
  } catch (error) {
    if (latestLoad.get(id) !== version) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Plugin ${id} failed to load:`, error);
    setLoadError(id, message);
  } finally {
    useInstalledPlugins.setState((state) => ({ loading: state.loading.filter((loading) => loading !== id) }));
  }
}

/** Registers what is installed: stubs for everything, then loads the enabled ones. */
async function applyInstalled(installed: InstalledPlugin[], reload: Set<string> = new Set()): Promise<void> {
  const previous = useInstalledPlugins.getState().installed;
  useInstalledPlugins.setState({ installed });
  // Removed since last time.
  for (const old of previous) {
    if (!installed.some((info) => info.id === old.id)) {
      latestLoad.delete(old.id);
      unregisterPlugin(old.id);
      setFileSkills(old.id, []);
      setLoadError(old.id, null);
      setStyle(old.id, null);
    }
  }
  const loads: Promise<void>[] = [];
  for (const info of installed) {
    if (!PLUGIN_ID_PATTERN.test(info.id)) continue;
    if (!info.manifest) {
      setLoadError(info.id, info.error ?? "The manifest is unusable");
      continue;
    }
    const { skills, problems } = fileSkillsOf(info);
    const registered = getPlugin(info.id);
    const loaded = registered?.source.type === "imported" && !registered.source.stub;
    if (!loaded || reload.has(info.id)) {
      const stub = stubOf(info);
      if (stub && !loaded) registerPlugin(stub, { type: "imported", dir: info.dir, author: info.manifest.author, stub: true });
      if (isPluginEnabled(info.id)) loads.push(loadModule(info));
      else latestLoad.delete(info.id);
    }
    setFileSkills(info.id, skills);
    if (problems.length) console.warn(`Skill files of ${info.id}:`, problems);
  }
  await Promise.all(loads);
}

let started = false;

/** Lists installed plugins and loads the enabled ones. Called once, after the first render. */
export async function loadImportedPlugins(): Promise<void> {
  if (started) return;
  started = true;
  try {
    await applyInstalled(await listPlugins());
  } catch (error) {
    console.error("Could not list the installed plugins:", error);
  }
  // Enabling a plugin loads its code again (a stub's for the first time,
  // an edited plugin's anew); disabling takes its stylesheet away.
  const enabledNow = () => new Map(useInstalledPlugins.getState().installed.map((info) => [info.id, isPluginEnabled(info.id)]));
  let wasEnabled = enabledNow();
  useSettings.subscribe(() => {
    const now = enabledNow();
    for (const info of useInstalledPlugins.getState().installed) {
      const enabled = now.get(info.id) ?? false;
      if (enabled === wasEnabled.get(info.id)) continue;
      if (enabled) void loadModule(info);
      else {
        latestLoad.delete(info.id);
        setStyle(info.id, null);
      }
    }
    wasEnabled = now;
  });
}

/** Lists the installed plugins again, reloading `reload` (every plugin by default, so edits take effect). */
export async function refreshInstalled(reload?: string[]): Promise<void> {
  const installed = await listPlugins();
  await applyInstalled(installed, new Set(reload ?? installed.map((info) => info.id)));
}

const TRUST_WARNING =
  "Plugins run inside Midterm with full access to your files, terminals and network, like the app itself. " +
  "Only import plugins from people you trust.";

/** Imports a plugin from a folder or .zip the user picks, after the trust warning. Returns its id, or null. */
export async function importPluginInteractively(kind: "folder" | "zip"): Promise<string | null> {
  const ok = await confirm({ title: "Import a plugin?", message: TRUST_WARNING, action: "Choose…" });
  if (!ok) return null;
  const path = await pickPluginSource(kind);
  if (!path) return null;
  let installed: InstalledPlugin;
  try {
    installed = await importPlugin(path, false);
  } catch (error) {
    if (!isPluginError(error) || error.kind !== "exists") throw error;
    const replace = await confirm({
      title: "Replace the installed plugin?",
      message: `${error.message} Importing replaces it with this version.`,
      action: "Replace",
    });
    if (!replace) return null;
    installed = await importPlugin(path, true);
  }
  // A plugin with the same id imported before is enabled again: the user just chose it.
  const id = installed.manifest?.id ?? installed.id;
  if (useSettings.getState().plugins[id]?.enabled === false) useSettings.getState().updatePluginEntry(id, { enabled: true });
  await refreshInstalled([id]);
  return id;
}

/** Removes an imported plugin after asking. Its panes stay, with a placeholder. */
export async function removePluginInteractively(id: string): Promise<boolean> {
  const name = getPlugin(id)?.plugin.name ?? id;
  const ok = await confirm({
    title: `Remove “${name}”?`,
    message: "Its files are deleted. Panes of this kind stay open with a placeholder until it is imported again.",
    action: "Remove",
  });
  if (!ok) return false;
  await removePlugin(id);
  await refreshInstalled([]);
  return true;
}
