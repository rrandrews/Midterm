import { normalizeHex } from "./color";
import { ANSI_NAMES, type AnsiPalette, type PaneBackground, type Theme, type ThemeKind, isTokenName } from "./types";

/*
 * Validation of untrusted JSON (a saved custom theme, an imported Midterm
 * theme file) into a `Theme`. Colors are hex (`#rgb`, `#rrggbb`,
 * `#rrggbbaa`) and come out lowercase `#rrggbb` / `#rrggbbaa`. Unknown
 * top-level keys are ignored (room for a format marker or later fields);
 * unknown override tokens are errors, since they are almost always typos.
 */

export type ValidationResult = { ok: true; theme: Theme } | { ok: false; errors: string[] };

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A plugin id (`PLUGIN_ID_PATTERN` in src/plugins/types.ts); built-in keys like `terminal-active` fit it too. */
const PANE_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A theme id from a display name: `Rosé Pine Dawn` → `rose-pine-dawn`. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "theme";
}

export function validateTheme(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return { ok: false, errors: ["A theme must be a JSON object"] };

  const color = (value: unknown, path: string): string | undefined => {
    if (typeof value !== "string") {
      errors.push(`${path}: expected a hex color string`);
      return undefined;
    }
    const hex = normalizeHex(value);
    if (!hex) errors.push(`${path}: "${value}" is not a hex color (#rgb, #rrggbb or #rrggbbaa)`);
    return hex ?? undefined;
  };
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
  if (id !== undefined && !ID.test(id)) {
    errors.push(`id: "${id}" must be lowercase letters, digits and dashes`);
  }
  if (id === undefined && name) id = slugify(name);

  const kind = data.kind;
  if (kind !== "dark" && kind !== "light") errors.push(`kind: expected "dark" or "light"`);

  const background = color(data.background, "background");
  const foreground = color(data.foreground, "foreground");
  const accent = color(data.accent, "accent");
  const cursor = data.cursor === undefined ? undefined : color(data.cursor, "cursor");
  const selection = data.selection === undefined ? undefined : color(data.selection, "selection");

  const ansi = {} as AnsiPalette;
  if (!isObject(data.ansi)) errors.push("ansi: expected an object with the 16 ANSI colors");
  else {
    for (const n of ANSI_NAMES) {
      if (data.ansi[n] === undefined) errors.push(`ansi.${n}: missing`);
      else ansi[n] = color(data.ansi[n], `ansi.${n}`) ?? "";
    }
  }

  let overrides: Theme["overrides"];
  if (data.overrides !== undefined) {
    if (!isObject(data.overrides)) errors.push("overrides: expected an object");
    else {
      overrides = {};
      for (const [key, value] of Object.entries(data.overrides)) {
        if (!isTokenName(key)) errors.push(`overrides.${key}: unknown token`);
        else {
          const hex = color(value, `overrides.${key}`);
          if (hex) overrides[key] = hex;
        }
      }
    }
  }

  let panes: Theme["panes"];
  if (data.panes !== undefined) {
    if (!isObject(data.panes)) errors.push("panes: expected an object");
    else {
      panes = {};
      for (const [key, value] of Object.entries(data.panes)) {
        if (!PANE_KEY.test(key)) {
          errors.push(`panes.${key}: not a valid pane id`);
          continue;
        }
        if (!isObject(value)) {
          errors.push(`panes.${key}: expected an object with from, to and angle`);
          continue;
        }
        const pane: Partial<PaneBackground> = {};
        for (const [field, v] of Object.entries(value)) {
          if (field === "from" || field === "to") {
            const hex = color(v, `panes.${key}.${field}`);
            if (hex) pane[field] = hex;
          } else if (field === "angle") {
            if (typeof v === "number" && Number.isFinite(v)) pane.angle = v;
            else errors.push(`panes.${key}.angle: expected a number of degrees`);
          } else errors.push(`panes.${key}.${field}: unknown field`);
        }
        panes[key] = pane;
      }
    }
  }

  let icons: Theme["icons"];
  if (data.icons !== undefined) {
    if (!isObject(data.icons)) errors.push('icons: expected an object like { "set": "material" }');
    else {
      for (const field of Object.keys(data.icons)) if (field !== "set") errors.push(`icons.${field}: unknown field`);
      const set = data.icons.set;
      if (typeof set !== "string" || !ID.test(set)) errors.push("icons.set: expected an icon set id (lowercase letters, digits and dashes)");
      else icons = { set };
    }
  }

  const author = text("author", false);
  const source = text("source", false);
  const license = text("license", false);

  if (errors.length) return { ok: false, errors };

  const theme: Theme = {
    id: id as string,
    name: name as string,
    kind: kind as ThemeKind,
    background: background as string,
    foreground: foreground as string,
    accent: accent as string,
    ansi,
  };
  if (cursor) theme.cursor = cursor;
  if (selection) theme.selection = selection;
  if (overrides && Object.keys(overrides).length) theme.overrides = overrides;
  if (panes && Object.keys(panes).length) theme.panes = panes;
  if (icons) theme.icons = icons;
  if (author) theme.author = author;
  if (source) theme.source = source;
  if (license) theme.license = license;
  return { ok: true, theme };
}

/** `validateTheme` that throws one error listing every problem. */
export function parseTheme(data: unknown): Theme {
  const result = validateTheme(data);
  if (!result.ok) throw new Error(`Invalid theme:\n- ${result.errors.join("\n- ")}`);
  return result.theme;
}
