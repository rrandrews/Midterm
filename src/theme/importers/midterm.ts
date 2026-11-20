import type { Theme } from "../types";
import { parseTheme } from "../validate";

/*
 * Midterm's own theme JSON: the `Theme` object as is, plus a format marker
 * (`"midtermTheme": 1`) so the file says what it is. Import accepts files
 * with or without the marker. A theme that names a custom icon set carries
 * it as `"iconSet"` (a Midterm icon set, docs/icons.md), so the file stands
 * alone; older builds ignore the key.
 */

export const MIDTERM_THEME_FORMAT = 1;

/** The theme as a Midterm theme file (pretty-printed JSON, trailing newline), with its custom icon set if given. */
export function exportTheme(theme: Theme, iconSet?: object): string {
  const data = iconSet ? { midtermTheme: MIDTERM_THEME_FORMAT, ...theme, iconSet } : { midtermTheme: MIDTERM_THEME_FORMAT, ...theme };
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** The icon set embedded in a Midterm theme file (unvalidated), if any. */
export function embeddedIconSet(text: string): unknown {
  try {
    const data: unknown = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? (data as { iconSet?: unknown }).iconSet : undefined;
  } catch {
    return undefined;
  }
}

/** Parses a Midterm theme file. Throws listing every problem. */
export function importMidtermTheme(text: string): Theme {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not a Midterm theme: ${e instanceof Error ? e.message : String(e)}`);
  }
  const marker = (data as { midtermTheme?: unknown } | null)?.midtermTheme;
  if (typeof marker === "number" && marker > MIDTERM_THEME_FORMAT) {
    throw new Error(`This theme file needs a newer Midterm (format ${marker})`);
  }
  return parseTheme(data);
}
