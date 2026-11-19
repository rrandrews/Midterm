import type { PaneData } from "../../state/types";

/*
 * Validation of the built-in plugins' saved pane data. Pure (no UI
 * imports), so restoring can be unit-tested with the real rules.
 */

type Fields = Omit<PaneData, "kind">;

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function validateTerminalData(raw: Record<string, unknown>): Fields {
  const data: Fields = {};
  if (nonEmpty(raw.cwd)) data.cwd = raw.cwd;
  if (raw.terminalMode === "classic" || raw.terminalMode === "blocks") data.terminalMode = raw.terminalMode;
  return data;
}

export function validateExplorerData(raw: Record<string, unknown>): Fields {
  const data: Fields = {};
  if (nonEmpty(raw.root)) data.root = raw.root;
  if (typeof raw.pinned === "boolean") data.pinned = raw.pinned;
  if (typeof raw.showHidden === "boolean") data.showHidden = raw.showHidden;
  if (Array.isArray(raw.expanded)) {
    const expanded = raw.expanded.filter(nonEmpty);
    if (expanded.length) data.expanded = expanded;
  }
  return data;
}

/** Editors and viewers: the file. */
export function validateFileData(raw: Record<string, unknown>): Fields {
  return nonEmpty(raw.path) ? { path: raw.path } : {};
}

export const BUILTIN_VALIDATORS: Record<string, (raw: Record<string, unknown>) => Fields> = {
  terminal: validateTerminalData,
  explorer: validateExplorerData,
  editor: validateFileData,
  viewer: validateFileData,
};
