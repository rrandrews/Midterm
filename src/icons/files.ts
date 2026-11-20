import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { fileVersion, readTextFile, writeTextFile } from "../ipc/fs";
import { MAX_ICON_LENGTH } from "./sanitize";
import { BUNDLED_IDS, freeIconSetId, getCustomIconSet, saveIconSet } from "./state";
import type { IconSet } from "./types";
import { ICON_SET_LIMITS, exportIconSet, parseIconSet } from "./validate";

/* Importing and exporting Midterm icon set files. */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The directory part of a path, with its trailing slash. */
const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

/**
 * Parses a Midterm icon set file. Definitions given as `{ "path": "icons/x.svg" }`
 * (relative to the file) are read and inlined, so the stored set needs no
 * other files. The limits are checked before and while reading, so a set
 * cannot make Midterm read thousands of large files.
 */
export async function parseIconSetFile(path: string, text: string): Promise<IconSet> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not an icon set: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(data)) throw new Error("Not an icon set: expected a JSON object");
  const marker = data.midtermIconSet;
  if (typeof marker === "number" && marker > 1) throw new Error(`This icon set needs a newer Midterm (format ${marker})`);
  if (isObject(data.definitions)) {
    const entries = Object.entries(data.definitions);
    if (entries.length > ICON_SET_LIMITS.definitions) {
      throw new Error(`Invalid icon set: more than ${ICON_SET_LIMITS.definitions} icons`);
    }
    let total = text.length;
    const definitions: [string, unknown][] = [];
    for (const [id, definition] of entries) {
      if (isObject(definition) && typeof definition.path === "string" && definition.svg === undefined) {
        const relative = definition.path;
        if (!relative.toLowerCase().endsWith(".svg") || relative.startsWith("/")) {
          throw new Error(`definitions.${id}.path: expected a relative path to an .svg file`);
        }
        const full = dirOf(path) + relative;
        const version = await fileVersion(full);
        if (!version) throw new Error(`definitions.${id}: ${relative} was not found`);
        if (version.size > MAX_ICON_LENGTH) throw new Error(`definitions.${id}: ${relative} is larger than 64 KB`);
        total += version.size;
        if (total > ICON_SET_LIMITS.totalLength) throw new Error("Invalid icon set: larger than 4 MB");
        const file = await readTextFile(full);
        if (file.kind !== "text") throw new Error(`definitions.${id}: ${relative} is not a text file`);
        // It may have grown since it was measured.
        if (file.text.length > MAX_ICON_LENGTH) throw new Error(`definitions.${id}: ${relative} is larger than 64 KB`);
        definitions.push([id, { svg: file.text, ...(definition.mono === true ? { mono: true } : {}) }]);
      } else definitions.push([id, definition]);
    }
    data = { ...data, definitions: Object.fromEntries(definitions) };
  }
  return parseIconSet(data, BUNDLED_IDS);
}

/** Saves an imported set under an id no other set uses. */
export function addImportedIconSet(set: IconSet): IconSet {
  return saveIconSet({ ...set, id: freeIconSetId(set.id) });
}

/** Asks for an icon set file and adds it. Returns it, or null if cancelled. */
export async function importIconSetInteractively(): Promise<IconSet | null> {
  if (!isTauri()) return null;
  const path = await open({ title: "Import icon set", filters: [{ name: "Midterm icon set", extensions: ["json"] }] });
  if (typeof path !== "string") return null;
  const file = await readTextFile(path);
  if (file.kind !== "text") throw new Error("That file is not text.");
  return addImportedIconSet(await parseIconSetFile(path, file.text));
}

/** Asks where to save a custom set as a Midterm icon set file. Returns whether it was saved. */
export async function exportIconSetInteractively(id: string): Promise<boolean> {
  const set = await getCustomIconSet(id);
  if (!set || !isTauri()) return false;
  const path = await save({ title: "Export icon set", defaultPath: `${set.id}.json`, filters: [{ name: "Midterm icon set", extensions: ["json"] }] });
  if (!path) return false;
  const result = await writeTextFile(path, exportIconSet(set), { kind: "any" });
  if (result.kind !== "written") throw new Error("The file changed while saving.");
  return true;
}
