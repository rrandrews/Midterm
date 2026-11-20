import { slugify } from "../theme/validate";
import { MAX_ICON_LENGTH, sanitizeSvg } from "./sanitize";
import type { IconDefinition, IconMapping, IconSet } from "./types";

/*
 * Validation of untrusted icon set JSON (an imported Midterm icon set, one
 * embedded in a theme file, a stored one) into an `IconSet` whose SVG is
 * sanitized. Mappings use VS Code's icon theme keys; a mapping naming an
 * icon the set does not define is an error, since it is almost always a
 * typo. Unknown top-level keys are ignored.
 */

export const MIDTERM_ICON_SET_FORMAT = 1;
export const ICON_SET_LIMITS = { definitions: 4000, totalLength: 4 * 1024 * 1024, keyLength: 128 } as const;

/** Icon set ids: like theme ids. */
export const ICON_SET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ICON_ID = /^[\w.-]{1,64}$/;
const MAPS = ["fileNames", "fileExtensions", "folderNames", "folderNamesExpanded", "languageIds"] as const;
const DEFAULTS = ["file", "folder", "folderExpanded"] as const;

export type IconSetResult = { ok: true; set: IconSet } | { ok: false; errors: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `extendsIds`: the ids a set may extend (the bundled sets). */
export function validateIconSet(data: unknown, extendsIds: readonly string[]): IconSetResult {
  const errors: string[] = [];
  if (!isObject(data)) return { ok: false, errors: ["An icon set must be a JSON object"] };
  let length = 0;
  try {
    length = JSON.stringify(data).length;
  } catch {
    return { ok: false, errors: ["An icon set must be plain JSON"] };
  }
  if (length > ICON_SET_LIMITS.totalLength) return { ok: false, errors: ["The icon set is larger than 4 MB"] };

  const text = (key: string, required: boolean): string | undefined => {
    const value = data[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`${key}: expected a non-empty string`);
      return undefined;
    }
    return value.trim();
  };
  const name = text("name", true);
  let id = text("id", false);
  if (id !== undefined && !ICON_SET_ID.test(id)) errors.push(`id: "${id}" must be lowercase letters, digits and dashes`);
  if (id === undefined && name) id = slugify(name);
  const extendsId = text("extends", false);
  if (extendsId !== undefined && !extendsIds.includes(extendsId)) {
    errors.push(`extends: "${extendsId}" is not a bundled icon set (${extendsIds.join(", ")})`);
  }

  const definitions = new Map<string, IconDefinition>();
  if (!isObject(data.definitions)) errors.push("definitions: expected an object of icons");
  else {
    const entries = Object.entries(data.definitions);
    if (entries.length > ICON_SET_LIMITS.definitions) errors.push(`definitions: more than ${ICON_SET_LIMITS.definitions} icons`);
    else {
      for (const [key, value] of entries) {
        if (!ICON_ID.test(key)) {
          errors.push(`definitions.${key}: icon ids are letters, digits, "_", "." and "-" (at most 64)`);
          continue;
        }
        if (!isObject(value) || typeof value.svg !== "string") {
          errors.push(`definitions.${key}: expected { "svg": "<svg…>" }`);
          continue;
        }
        if (value.svg.length > MAX_ICON_LENGTH) {
          errors.push(`definitions.${key}: larger than 64 KB`);
          continue;
        }
        const svg = sanitizeSvg(value.svg);
        if (!svg) {
          errors.push(`definitions.${key}: not a safe SVG icon (root must be <svg>, no external references)`);
          continue;
        }
        if (value.mono !== undefined && typeof value.mono !== "boolean") errors.push(`definitions.${key}.mono: expected true or false`);
        definitions.set(key, value.mono === true ? { svg, mono: true } : { svg });
      }
    }
  }

  const mapping = (raw: unknown, path: string): IconMapping => {
    const out: IconMapping = {};
    if (raw === undefined) return out;
    if (!isObject(raw)) {
      errors.push(`${path || "mapping"}: expected an object`);
      return out;
    }
    const at = (key: string) => (path ? `${path}.${key}` : key);
    const icon = (value: unknown, where: string): string | undefined => {
      if (typeof value !== "string" || !definitions.has(value)) {
        errors.push(`${where}: "${String(value)}" is not an icon in definitions`);
        return undefined;
      }
      return value;
    };
    for (const key of DEFAULTS) {
      if (raw[key] !== undefined) {
        const value = icon(raw[key], at(key));
        if (value) out[key] = value;
      }
    }
    for (const key of MAPS) {
      const map = raw[key];
      if (map === undefined) continue;
      if (!isObject(map)) {
        errors.push(`${at(key)}: expected an object`);
        continue;
      }
      // Entries, not assignment: a key may be `__proto__`.
      const record: [string, string][] = [];
      for (const [name, value] of Object.entries(map)) {
        if (!name || name.length > ICON_SET_LIMITS.keyLength) {
          errors.push(`${at(key)}: keys must be 1 to ${ICON_SET_LIMITS.keyLength} characters`);
          continue;
        }
        const ok = icon(value, `${at(key)}.${name}`);
        if (ok) record.push([name, ok]);
      }
      if (record.length) out[key] = Object.fromEntries(record);
    }
    return out;
  };

  const own = mapping(
    Object.fromEntries([...DEFAULTS, ...MAPS].filter((key) => key in data).map((key) => [key, data[key]])),
    "",
  );
  const light = data.light === undefined ? undefined : mapping(data.light, "light");

  if (errors.length) return { ok: false, errors };
  const set: IconSet = { id: id as string, name: name as string, definitions: Object.fromEntries(definitions), ...own };
  if (light && Object.keys(light).length) set.light = light;
  if (extendsId) set.extends = extendsId;
  for (const key of ["author", "license", "source"] as const) {
    const value = text(key, false);
    if (value) set[key] = value;
  }
  return { ok: true, set };
}

/** `validateIconSet` that throws one error listing every problem. */
export function parseIconSet(data: unknown, extendsIds: readonly string[]): IconSet {
  const result = validateIconSet(data, extendsIds);
  if (!result.ok) throw new Error(`Invalid icon set:\n- ${result.errors.slice(0, 20).join("\n- ")}`);
  return result.set;
}

/** The set as a Midterm icon set file (pretty-printed JSON, trailing newline). */
export function exportIconSet(set: IconSet): string {
  return `${JSON.stringify({ midtermIconSet: MIDTERM_ICON_SET_FORMAT, ...set }, null, 2)}\n`;
}
