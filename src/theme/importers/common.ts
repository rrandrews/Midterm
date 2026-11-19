import { luminance, normalizeHex, opaque } from "../color";
import { type AnsiName, type AnsiPalette, type Theme, type ThemeKind, type TokenName } from "../types";
import { parseTheme, slugify } from "../validate";

/*
 * Shared by the importers: turns whatever a foreign format provided into a
 * validated `Theme`, filling what it lacks.
 */

/** VS Code's default terminal colors (MIT), used for ANSI colors a format leaves out. */
export const DEFAULT_ANSI: Record<ThemeKind, AnsiPalette> = {
  dark: {
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  },
  light: {
    black: "#000000",
    red: "#cd3131",
    green: "#00bc00",
    yellow: "#949800",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#cd3131",
    brightGreen: "#14ce14",
    brightYellow: "#b5ba00",
    brightBlue: "#0451a5",
    brightMagenta: "#bc05bc",
    brightCyan: "#0598bc",
    brightWhite: "#a5a5a5",
  },
};

/** Options every importer takes: a name for formats that do not carry one (usually the file name). */
export interface ImportOptions {
  name?: string;
}

export interface ThemeParts {
  name: string;
  kind?: ThemeKind;
  background: string;
  foreground: string;
  accent?: string;
  cursor?: string;
  selection?: string;
  ansi: Partial<AnsiPalette>;
  overrides?: Partial<Record<TokenName, string | undefined>>;
  author?: string;
  source?: string;
  license?: string;
}

/** Dark when the background is darker than mid-gray (by WCAG luminance). */
export function kindOf(background: string): ThemeKind {
  return luminance(background) < 0.18 ? "dark" : "light";
}

/** A file name without directories and extension, for a theme name. */
export function baseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || fileName;
}

/** Builds and validates a theme; missing ANSI colors come from `DEFAULT_ANSI`, the accent from blue. */
export function buildTheme(parts: ThemeParts): Theme {
  const background = opaque(required(parts.background, "background"));
  const kind = parts.kind ?? kindOf(background);
  const ansi = { ...DEFAULT_ANSI[kind] };
  for (const [key, value] of Object.entries(parts.ansi) as [AnsiName, string | undefined][]) {
    const hex = value === undefined ? null : normalizeHex(value);
    if (hex) ansi[key] = opaque(hex);
  }
  const overrides: Partial<Record<TokenName, string>> = {};
  for (const [key, value] of Object.entries(parts.overrides ?? {}) as [TokenName, string | undefined][]) {
    const hex = value === undefined ? null : normalizeHex(value);
    if (hex) overrides[key] = hex;
  }
  const accent = parts.accent ? normalizeHex(parts.accent) : null;
  const data: Record<string, unknown> = {
    id: slugify(parts.name),
    name: parts.name,
    kind,
    background,
    foreground: opaque(required(parts.foreground, "foreground")),
    accent: accent ? opaque(accent) : ansi.blue,
    ansi,
    cursor: parts.cursor && normalizeHex(parts.cursor) ? opaque(parts.cursor) : undefined,
    selection: parts.selection && normalizeHex(parts.selection) ? normalizeHex(parts.selection) : undefined,
    overrides,
    author: parts.author || undefined,
    source: parts.source || undefined,
    license: parts.license || undefined,
  };
  return parseTheme(data);
}

function required(value: string | undefined, what: string): string {
  const hex = value === undefined ? null : normalizeHex(value);
  if (!hex) throw new Error(`The theme has no usable ${what} color`);
  return hex;
}
