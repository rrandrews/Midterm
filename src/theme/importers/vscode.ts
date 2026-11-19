import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { contrastRatio, normalizeHex } from "../color";
import { ANSI_NAMES, type AnsiPalette, type Theme, type ThemeKind, type TokenName } from "../types";
import { type ImportOptions, buildTheme } from "./common";

/*
 * VS Code color theme JSON (comments and trailing commas allowed). Read:
 * `name`, `type`, `colors` (workbench colors) and `tokenColors` (TextMate
 * scopes, for the syntax tokens). `include` (a parent theme file) cannot be
 * followed and is ignored. See docs/themes.md for the full mapping.
 */

/** Workbench color keys for each part of the base palette, first match wins. */
const BASE_KEYS = {
  background: ["editor.background", "terminal.background", "sideBar.background"],
  foreground: ["editor.foreground", "terminal.foreground", "foreground"],
  accent: ["focusBorder", "button.background", "activityBarBadge.background", "textLink.foreground"],
  cursor: ["terminalCursor.foreground", "editorCursor.foreground"],
  selection: ["terminal.selectionBackground", "editor.selectionBackground"],
} as const;

/** Workbench color keys that map straight onto tokens. */
const TOKEN_KEYS: Partial<Record<TokenName, string[]>> = {
  field: ["input.background"],
  popover: ["editorWidget.background", "menu.background", "quickInput.background"],
  line: ["editorGroup.border", "panel.border", "sideBar.border"],
  "fg-faint": ["editorLineNumber.foreground"],
  err: ["editorError.foreground", "errorForeground"],
  warn: ["editorWarning.foreground"],
  info: ["editorInfo.foreground"],
  "terminal-fg": ["terminal.foreground"],
};

/** TextMate scopes for the syntax tokens, most specific first. */
const SCOPES: [TokenName, string[]][] = [
  ["comment", ["comment"]],
  ["string", ["string"]],
  ["keyword", ["keyword", "storage.type", "storage"]],
  ["function", ["entity.name.function", "support.function"]],
  ["type", ["entity.name.type", "support.type", "entity.name.class", "constant.numeric"]],
  ["punctuation", ["punctuation"]],
];

const ANSI_KEYS: Record<keyof AnsiPalette, string> = Object.fromEntries(
  ANSI_NAMES.map((n) => [n, `terminal.ansi${n[0].toUpperCase()}${n.slice(1)}`]),
) as Record<keyof AnsiPalette, string>;

interface TokenColor {
  scope?: string | string[];
  settings?: { foreground?: string };
}

/** Parses a VS Code color theme. `options.name` is used when the file has no `name`. */
export function importVSCodeTheme(text: string, options: ImportOptions = {}): Theme {
  const errors: ParseError[] = [];
  const data: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const e = errors[0];
    throw new Error(`Not a VS Code theme: ${printParseErrorCode(e.error)} at offset ${e.offset}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Not a VS Code theme: expected an object");
  const theme = data as { name?: unknown; type?: unknown; colors?: unknown; tokenColors?: unknown };
  const colors = theme.colors && typeof theme.colors === "object" ? (theme.colors as Record<string, unknown>) : {};
  if (!Object.keys(colors).length) throw new Error("Not a VS Code theme: it has no colors");

  const pick = (keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const value = colors[key];
      // VS Code also accepts #rgba; expand it to #rrggbbaa.
      const hex = typeof value === "string" ? normalizeHex(expandRgba(value)) : null;
      if (hex) return hex;
    }
    return undefined;
  };

  const ansi: Partial<AnsiPalette> = {};
  for (const name of ANSI_NAMES) ansi[name] = pick([ANSI_KEYS[name]]);

  const overrides: Partial<Record<TokenName, string>> = {};
  for (const [token, keys] of Object.entries(TOKEN_KEYS) as [TokenName, string[]][]) {
    // Translucent workbench colors are drawn over other surfaces in VS Code; skip them rather than guess.
    const hex = keys.map((k) => pick([k])).find((h) => h && h.length === 7);
    if (hex) overrides[token] = hex;
  }
  Object.assign(overrides, syntaxColors(theme.tokenColors));

  const background = pick(BASE_KEYS.background);
  const foreground = pick(BASE_KEYS.foreground);
  if (!background || !foreground) throw new Error("Not a VS Code theme: no editor.background or editor.foreground");
  // The first opaque candidate that stands out from the background (focus borders are often near it).
  const accent = BASE_KEYS.accent
    .map((k) => pick([k]))
    .find((hex) => hex && hex.length === 7 && contrastRatio(hex, background) >= 3);

  return buildTheme({
    name: typeof theme.name === "string" && theme.name.trim() ? theme.name.trim() : (options.name ?? "Imported VS Code Theme"),
    kind: kindFromType(theme.type),
    background,
    foreground,
    accent,
    cursor: pick(BASE_KEYS.cursor),
    selection: pick(BASE_KEYS.selection),
    ansi,
    overrides,
  });
}

function expandRgba(value: string): string {
  return /^#[0-9a-f]{4}$/i.test(value) ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : value;
}

function kindFromType(type: unknown): ThemeKind | undefined {
  if (type === "dark" || type === "hc" || type === "hc-black") return "dark";
  if (type === "light" || type === "hcLight" || type === "hc-light") return "light";
  return undefined;
}

/** The syntax tokens from `tokenColors`: per token, the rule whose scope matches best. */
function syntaxColors(tokenColors: unknown): Partial<Record<TokenName, string>> {
  if (!Array.isArray(tokenColors)) return {};
  const rules = (tokenColors as TokenColor[]).flatMap((rule) => {
    const fg = typeof rule?.settings?.foreground === "string" ? normalizeHex(rule.settings.foreground) : null;
    if (!fg || fg.length !== 7) return [];
    const scopes = typeof rule.scope === "string" ? rule.scope.split(",") : Array.isArray(rule.scope) ? rule.scope : [];
    return scopes.filter((s): s is string => typeof s === "string").map((s) => ({ scope: s.trim(), fg }));
  });
  const out: Partial<Record<TokenName, string>> = {};
  for (const [token, wanted] of SCOPES) {
    // Prefer an exact scope, in the order listed, over one a single segment more specific
    // (`string.quoted`); deeper ones (`punctuation.definition.comment`) usually belong to something else.
    for (const scope of wanted) {
      const child = (r: { scope: string }) =>
        r.scope.startsWith(`${scope}.`) && !r.scope.slice(scope.length + 1).includes(".") && !r.scope.includes(" ");
      const rule = rules.find((r) => r.scope === scope) ?? rules.find(child);
      if (rule) {
        out[token] = rule.fg;
        break;
      }
    }
  }
  return out;
}
