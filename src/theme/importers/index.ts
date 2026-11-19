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
  if (/"midtermTheme"\s*:/.test(text)) return "midterm";
  if (/"(?:colors|tokenColors)"\s*:/.test(text)) return "vscode";
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
