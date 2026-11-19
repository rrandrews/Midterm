import { parse } from "yaml";
import { normalizeHex } from "../color";
import type { AnsiPalette, Theme, ThemeKind } from "../types";
import { type ImportOptions, buildTheme } from "./common";

/*
 * Base16 and Base24 schemes (YAML), in both formats:
 *
 * - the original one: top-level `scheme`, `author` and `base00` … `base0F`
 *   (Base24 adds `base10` … `base17`), values with or without `#`;
 * - tinted-theming's current one: `system: "base16" | "base24"`, `name`,
 *   `author`, `variant: "dark" | "light"` and the colors under `palette`.
 *
 * ANSI follows tinted-theming's terminal templates; see docs/themes.md.
 */

const BASE16_KEYS = [
  "base00", "base01", "base02", "base03", "base04", "base05", "base06", "base07",
  "base08", "base09", "base0A", "base0B", "base0C", "base0D", "base0E", "base0F",
] as const;
const BASE24_KEYS = ["base10", "base11", "base12", "base13", "base14", "base15", "base16", "base17"] as const;

type Key = (typeof BASE16_KEYS)[number] | (typeof BASE24_KEYS)[number];

/** Parses a Base16 or Base24 YAML scheme. */
export function importBase16(text: string, options: ImportOptions = {}): Theme {
  let data: unknown;
  try {
    // The failsafe schema keeps every scalar a string, so `base00: 000000` stays "000000" rather than 0.
    data = parse(text, { schema: "failsafe" });
  } catch (e) {
    throw new Error(`Not a Base16 scheme: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Not a Base16 scheme: expected a YAML mapping");
  const doc = data as Record<string, unknown>;
  const source = doc.palette && typeof doc.palette === "object" ? (doc.palette as Record<string, unknown>) : doc;

  const colors: Partial<Record<Key, string>> = {};
  for (const key of [...BASE16_KEYS, ...BASE24_KEYS]) {
    // Keys are case-insensitive in practice (`base0a` and `base0A` both occur).
    const raw = source[key] ?? source[key.toLowerCase()];
    if (raw === undefined) continue;
    const value = String(raw).trim();
    const hex = normalizeHex(value.startsWith("#") ? value : `#${value}`);
    if (!hex) throw new Error(`Base16 scheme: ${key} is not a hex color ("${value}")`);
    colors[key] = hex;
  }
  const missing = BASE16_KEYS.filter((k) => !colors[k]);
  if (missing.length) throw new Error(`Not a Base16 scheme: missing ${missing.join(", ")}`);
  const c = colors as Record<(typeof BASE16_KEYS)[number], string> & Partial<Record<Key, string>>;
  const base24 = BASE24_KEYS.every((k) => colors[k]);

  const ansi: AnsiPalette = {
    black: c.base00,
    red: c.base08,
    green: c.base0B,
    yellow: c.base0A,
    blue: c.base0D,
    magenta: c.base0E,
    cyan: c.base0C,
    white: c.base05,
    brightBlack: c.base03,
    brightRed: base24 ? (c.base12 as string) : c.base08,
    brightGreen: base24 ? (c.base14 as string) : c.base0B,
    brightYellow: base24 ? (c.base13 as string) : c.base0A,
    brightBlue: base24 ? (c.base16 as string) : c.base0D,
    brightMagenta: base24 ? (c.base17 as string) : c.base0E,
    brightCyan: base24 ? (c.base15 as string) : c.base0C,
    brightWhite: c.base07,
  };

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const variant = str(doc.variant);
  return buildTheme({
    name: str(doc.name) ?? str(doc.scheme) ?? options.name ?? "Imported Base16 Theme",
    kind: variant === "dark" || variant === "light" ? (variant as ThemeKind) : undefined,
    author: str(doc.author),
    background: c.base00,
    foreground: c.base05,
    accent: c.base0D,
    cursor: c.base05,
    selection: c.base02,
    ansi,
    // Base16's styling guide gives these roles directly.
    overrides: {
      field: c.base01,
      popover: c.base01,
      raised: c.base02,
      "line-strong": c.base02,
      "fg-bright": c.base06,
      "fg-dim": c.base04,
      "fg-faint": c.base03,
      comment: c.base03,
      keyword: c.base0E,
      string: c.base0B,
      function: c.base0D,
      type: c.base0A,
    },
  });
}
