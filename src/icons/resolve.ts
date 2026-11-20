import { languageIdOf } from "./languages";
import type { IconMapping, IconQuery } from "./types";

/*
 * Which icon of a set a file or folder gets, in VS Code's order:
 *
 * - files: file name (the longest matching path tail first, so
 *   `.config/graphqlrc` beats `graphqlrc`), then extension (longest first:
 *   `a.test.ts` tries `test.ts`, then `ts`; `.gitignore` tries
 *   `gitignore`), then language id, then the set's `file`;
 * - folders: folder name (path tails too), then `folder` /
 *   `folderExpanded`.
 *
 * Under a light theme the set's `light` mappings (fallbacks included) are
 * tried first; any name match still beats any fallback. All
 * lookups are case-insensitive and go through `Map`s: files are really
 * called `constructor` and `__proto__`.
 */

export interface IconIndex {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileNames: Map<string, string>;
  fileExtensions: Map<string, string>;
  folderNames: Map<string, string>;
  folderNamesExpanded: Map<string, string>;
  languageIds: Map<string, string>;
  /** Longest path tail (in segments) among the name keys, so lookups stop early. */
  maxSegments: number;
  light?: IconIndex;
}

function lowerMap(record: Record<string, string> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (record) for (const [key, value] of Object.entries(record)) map.set(key.toLowerCase(), value);
  return map;
}

export function buildIndex(mapping: IconMapping & { light?: IconMapping }): IconIndex {
  const index: IconIndex = {
    file: mapping.file,
    folder: mapping.folder,
    folderExpanded: mapping.folderExpanded,
    fileNames: lowerMap(mapping.fileNames),
    fileExtensions: lowerMap(mapping.fileExtensions),
    folderNames: lowerMap(mapping.folderNames),
    folderNamesExpanded: lowerMap(mapping.folderNamesExpanded),
    languageIds: lowerMap(mapping.languageIds),
    maxSegments: 1,
  };
  for (const map of [index.fileNames, index.folderNames, index.folderNamesExpanded]) {
    for (const key of map.keys()) index.maxSegments = Math.max(index.maxSegments, key.split("/").length);
  }
  if (mapping.light) index.light = buildIndex(mapping.light);
  return index;
}

/** `name`, preceded by up to `max - 1` parent directory names from `path`, longest first. */
function tails(query: IconQuery, max: number): string[] {
  const name = query.name.toLowerCase();
  if (max <= 1 || !query.path) return [name];
  const parts = query.path.toLowerCase().split("/").filter(Boolean);
  if (parts[parts.length - 1] !== name) return [name];
  const out: string[] = [];
  for (let n = Math.min(max, parts.length); n >= 1; n -= 1) out.push(parts.slice(-n).join("/"));
  return out;
}

/** Extensions of a file name, longest first. */
export function extensionsOf(name: string): string[] {
  const lower = name.toLowerCase();
  const out: string[] = [];
  for (let i = lower.indexOf("."); i !== -1; i = lower.indexOf(".", i + 1)) {
    const ext = lower.slice(i + 1);
    if (ext) out.push(ext);
  }
  return out;
}

function specificIn(index: IconIndex, query: IconQuery): string | undefined {
  const names =
    query.kind === "dir" ? (query.expanded ? index.folderNamesExpanded : index.folderNames) : index.fileNames;
  for (const tail of tails(query, index.maxSegments)) {
    const found = names.get(tail);
    if (found) return found;
  }
  if (query.kind === "dir") return undefined;
  for (const ext of extensionsOf(query.name)) {
    const found = index.fileExtensions.get(ext);
    if (found) return found;
  }
  const language = languageIdOf(query.name);
  return language ? index.languageIds.get(language) : undefined;
}

/** The icon id matched by name, extension or language (not a fallback), if any. */
export function specificIcon(index: IconIndex, query: IconQuery): string | undefined {
  return (query.light && index.light ? specificIn(index.light, query) : undefined) ?? specificIn(index, query);
}

function defaultIn(index: IconIndex, query: IconQuery): string | undefined {
  if (query.kind === "file") return index.file;
  return query.expanded ? (index.folderExpanded ?? index.folder) : index.folder;
}

/** The set's fallback for the kind of entry; under a light theme, its `light` fallback first. */
export function defaultIcon(index: IconIndex, query: IconQuery): string | undefined {
  return (query.light && index.light ? defaultIn(index.light, query) : undefined) ?? defaultIn(index, query);
}

export function iconIdFor(index: IconIndex, query: IconQuery, specificOnly = false): string | undefined {
  return specificIcon(index, query) ?? (specificOnly ? undefined : defaultIcon(index, query));
}
