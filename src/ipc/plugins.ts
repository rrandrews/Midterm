import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/*
 * Installed (imported) plugins, managed by the backend
 * (src-tauri/src/plugins/): listed, imported from a folder or .zip into
 * `<app data>/plugins/<id>/`, removed. Their files are served to the
 * webview by the `plugin://` scheme. In a plain browser there are none.
 */

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  /** Relative path of the ES module. */
  main: string;
  style?: string;
  /** Relative paths of `SKILL.md` files. */
  skills: string[];
  description?: string;
  author?: string;
};

export type InstalledPlugin = {
  /** Folder name. */
  id: string;
  dir: string;
  manifest: PluginManifest | null;
  skills: { path: string; content: string }[];
  /** Why the manifest is unusable. */
  error: string | null;
};

export type PluginError = { kind: "invalid" | "exists" | "notFound" | "io"; message: string };

export function isPluginError(value: unknown): value is PluginError {
  return typeof value === "object" && value !== null && "kind" in value && "message" in value;
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
  if (!isTauri()) return [];
  return invoke<InstalledPlugin[]>("plugins_list");
}

export async function pluginsDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string>("plugins_dir");
}

/** Installs a plugin from a folder or a .zip. Rejects with a `PluginError` (`exists` unless `replace`). */
export function importPlugin(path: string, replace: boolean): Promise<InstalledPlugin> {
  return invoke<InstalledPlugin>("plugins_import", { path, replace });
}

export function removePlugin(id: string): Promise<void> {
  return invoke("plugins_remove", { id });
}

/** Asks for a plugin folder or .zip to import; `null` if cancelled. */
export async function pickPluginSource(kind: "folder" | "zip"): Promise<string | null> {
  if (!isTauri()) return null;
  const picked = await open(
    kind === "folder"
      ? { directory: true, title: "Import plugin folder" }
      : { directory: false, title: "Import plugin", filters: [{ name: "Plugin archive", extensions: ["zip"] }] },
  );
  return typeof picked === "string" ? picked : null;
}

/**
 * URL of a file inside an installed plugin, served by the `plugin://`
 * scheme. `generation` versions the whole folder (`<id>@<n>/…`), so a
 * reloaded module's relative imports are fetched afresh too.
 */
export function pluginFileUrl(id: string, path: string, generation?: number): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  // Windows maps custom schemes to http://<scheme>.localhost.
  const base = navigator.userAgent.includes("Windows") ? "http://plugin.localhost" : "plugin://localhost";
  const folder = generation === undefined ? encodeURIComponent(id) : `${encodeURIComponent(id)}@${generation}`;
  return `${base}/${folder}/${encoded}`;
}
