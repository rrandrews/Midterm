import { parse as parseJsonc } from "jsonc-parser";
import type { Theme } from "../types";
import { importBase16 } from "./base16";
import { baseName } from "./common";
import { importItermColors } from "./iterm";
import { importMidtermTheme } from "./midterm";
import { importVSCodeTheme } from "./vscode";

export { importBase16 } from "./base16";
export { type ImportOptions, DEFAULT_ANSI, kindOf } from "./common";
export { importItermColors } from "./iterm";
export { MIDTERM_THEME_FORMAT, exportTheme, importMidtermTheme } from "./midterm";
export { importVSCodeTheme } from "./vscode";

export type ThemeFormat = "midterm" | "iterm" | "vscode" | "base16";

/** The format a theme file is in, from its name, then its content. */
export function detectThemeFormat(fileName: string, text: string): ThemeFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".itermcolors")) return "iterm";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "base16";
  const head = text.trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<plist") || head.startsWith("<!DOCTYPE plist")) return "iterm";
  if (head.startsWith("{") || head.startsWith("//") || head.startsWith("/*")) {
    // JSON (VS Code themes may have comments): decide by top-level keys, not nested ones.
    const data: unknown = parseJsonc(text, [], { allowTrailingComma: true });
    const keys = data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : [];
    if (keys.includes("midtermTheme") || keys.includes("ansi")) return "midterm";
    if (keys.includes("colors") || keys.includes("tokenColors")) return "vscode";
    return "midterm";
  }
  if (/^\s*(?:scheme|system|base00)\s*:/m.test(text)) return "base16";
  return "midterm";
}

/** Imports a theme file in any supported format; the file name names themes whose format has no name. */
export function importThemeFile(fileName: string, text: string): Theme {
  const name = baseName(fileName);
  switch (detectThemeFormat(fileName, text)) {
    case "iterm":
      return importItermColors(text, { name });
    case "vscode":
      return importVSCodeTheme(text, { name });
    case "base16":
      return importBase16(text, { name });
    case "midterm":
      return importMidtermTheme(text);
  }
}
