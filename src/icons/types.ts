import type { LucideIcon } from "lucide-react";

/*
 * File icon sets (docs/icons.md). A set maps file and folder names to
 * icons with VS Code's icon-theme keys, so mappings can be copied between
 * the two. Lookups are case-insensitive.
 */

/** The name → icon id mapping of a set (VS Code icon theme keys). */
export interface IconMapping {
  /** Fallback for files. */
  file?: string;
  /** Fallback for closed folders. */
  folder?: string;
  /** Fallback for open folders. */
  folderExpanded?: string;
  /** Exact file names (`package.json`), or path tails (`.github/dependabot.yml`). */
  fileNames?: Record<string, string>;
  /** Extensions without the dot; compound ones (`test.ts`) win over shorter ones. */
  fileExtensions?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  /** VS Code language ids (`typescript`), from the file's extension. */
  languageIds?: Record<string, string>;
}

/** One icon of a custom set: sanitized SVG markup. `mono` draws it in the text color. */
export interface IconDefinition {
  svg: string;
  mono?: boolean;
}

/** A custom icon set as stored and as a Midterm icon set file (`midtermIconSet: 1`). */
export interface IconSet extends IconMapping {
  id: string;
  name: string;
  author?: string;
  license?: string;
  source?: string;
  /** A bundled set underneath: this set's mappings win, the base fills the gaps. Omitted: replaces the default. */
  extends?: string;
  definitions: Record<string, IconDefinition>;
  /** Mappings used instead under light themes. */
  light?: IconMapping;
}

/** What the settings and the theme editor list. */
export interface IconSetInfo {
  id: string;
  name: string;
  author?: string;
  license?: string;
  source?: string;
  bundled: boolean;
}

export type IconKind = "file" | "dir";

export interface IconQuery {
  name: string;
  /** Full path, for path-tail file names. */
  path?: string;
  kind: IconKind;
  expanded: boolean;
  /** The theme is light. */
  light: boolean;
}

/** An icon to draw: an image URL (`mono`: as a mask in the text color), or a lucide component. */
export type IconImage = { url: string; mono: boolean } | { lucide: LucideIcon };

/** A set ready to answer lookups. */
export interface LoadedIconSet {
  id: string;
  /** The icon for an entry. `specificOnly`: only one matched by name, extension or language, not a fallback. */
  icon(query: IconQuery, specificOnly?: boolean): IconImage | null;
}
