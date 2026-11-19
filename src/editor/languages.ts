import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { baseName } from "../explorer/tree";

/*
 * Language detection by file name, from @codemirror/language-data (which
 * loads each language's package on demand, so they are split out of the
 * main bundle).
 */

/** The language for a file, by its name or extension, if one is known. */
export function languageFor(path: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, baseName(path));
}

/** Loads a file's language support; `null` if none is known or it failed to load. */
export async function loadLanguage(path: string): Promise<{ name: string; support: LanguageSupport } | null> {
  const description = languageFor(path);
  if (!description) return null;
  try {
    return { name: description.name, support: await description.load() };
  } catch (error) {
    console.warn(`Loading ${description.name} support failed:`, error);
    return null;
  }
}
