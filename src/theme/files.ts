import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "../ipc/fs";
import { exportTheme, importThemeFile } from "./importers";
import { findTheme, freeThemeId, freeThemeName, saveTheme, selectTheme } from "./state";
import type { Theme } from "./types";

/* Importing theme files (Midterm JSON, iTerm2, VS Code, Base16/Base24) and exporting Midterm JSON. */

/** Asks for a theme file, imports it as a custom theme and shows it. Returns it, or null if cancelled. */
export async function importThemeInteractively(): Promise<Theme | null> {
  if (!isTauri()) return null;
  const path = await open({
    title: "Import theme",
    filters: [{ name: "Themes", extensions: ["json", "itermcolors", "yaml", "yml"] }],
  });
  if (typeof path !== "string") return null;
  const file = await readTextFile(path);
  if (file.kind !== "text") throw new Error("That file is not text.");
  const imported = importThemeFile(path.slice(path.lastIndexOf("/") + 1), file.text);
  const theme = saveTheme({ ...imported, id: freeThemeId(imported.id), name: freeThemeName(imported.name) });
  selectTheme(theme.id);
  return theme;
}

/** Asks where to save a theme as Midterm JSON. Returns whether it was saved. */
export async function exportThemeInteractively(id: string): Promise<boolean> {
  const theme = findTheme(id);
  if (!theme || !isTauri()) return false;
  const path = await save({ title: "Export theme", defaultPath: `${theme.id}.json`, filters: [{ name: "Midterm theme", extensions: ["json"] }] });
  if (!path) return false;
  const result = await writeTextFile(path, exportTheme(theme), { kind: "any" });
  if (result.kind !== "written") throw new Error("The file changed while saving.");
  return true;
}
