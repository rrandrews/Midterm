import type { Theme } from "../types";
import { parseTheme } from "../validate";

/*
 * Midterm's own theme JSON: the `Theme` object as is, plus a format marker
 * (`"midtermTheme": 1`) so the file says what it is. Import accepts files
 * with or without the marker.
 */

export const MIDTERM_THEME_FORMAT = 1;

/** The theme as a Midterm theme file (pretty-printed JSON, trailing newline). */
export function exportTheme(theme: Theme): string {
  return `${JSON.stringify({ midtermTheme: MIDTERM_THEME_FORMAT, ...theme }, null, 2)}\n`;
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
