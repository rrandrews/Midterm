import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "../ipc/fs";
import type { SettingsScope } from "../settings/settings";
import { addImportedIconSet } from "../icons/files";
import { BUNDLED_IDS, getCustomIconSet } from "../icons/state";
import { parseIconSet } from "../icons/validate";
import { detectThemeFormat, embeddedIconSet, exportTheme, importThemeFile } from "./importers";
import { findTheme, freeThemeId, freeThemeName, saveTheme, selectTheme } from "./state";
import type { Theme } from "./types";

/*
 * Importing theme files (Midterm JSON, iTerm2, VS Code, Base16/Base24) and
 * exporting Midterm JSON. A Midterm theme naming a custom icon set carries
 * the set: export embeds it, import adds it and points the theme at it.
 */

/** Asks for a theme file, imports it as a custom theme and shows it. Returns it, or null if cancelled. */
export async function importThemeInteractively(scope?: SettingsScope): Promise<Theme | null> {
  if (!isTauri()) return null;
  const path = await open({
    title: "Import theme",
    filters: [{ name: "Themes", extensions: ["json", "itermcolors", "yaml", "yml"] }],
  });
  if (typeof path !== "string") return null;
  const file = await readTextFile(path);
  if (file.kind !== "text") throw new Error("That file is not text.");
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  let imported = importThemeFile(fileName, file.text);
  const embedded = detectThemeFormat(fileName, file.text) === "midterm" ? embeddedIconSet(file.text) : undefined;
  if (embedded !== undefined) {
    const set = addImportedIconSet(parseIconSet(embedded, BUNDLED_IDS));
    imported = { ...imported, icons: { set: set.id } };
  }
  const theme = saveTheme({ ...imported, id: freeThemeId(imported.id), name: freeThemeName(imported.name) });
  selectTheme(theme.id, scope);
  return theme;
}

/** Asks where to save a theme as Midterm JSON. Returns whether it was saved. */
export async function exportThemeInteractively(id: string): Promise<boolean> {
  const theme = findTheme(id);
  if (!theme || !isTauri()) return false;
  const path = await save({ title: "Export theme", defaultPath: `${theme.id}.json`, filters: [{ name: "Midterm theme", extensions: ["json"] }] });
  if (!path) return false;
  const iconSetId = theme.icons?.set;
  const iconSet = iconSetId && !BUNDLED_IDS.includes(iconSetId) ? await getCustomIconSet(iconSetId) : undefined;
  const result = await writeTextFile(path, exportTheme(theme, iconSet), { kind: "any" });
  if (result.kind !== "written") throw new Error("The file changed while saving.");
  return true;
}
