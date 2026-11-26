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
  if (raw.aiSuggestions === false) data.aiSuggestions = false;
  return data;
}

export function validateExplorerData(raw: Record<string, unknown>): Fields {
  const data: Fields = {};
  if (nonEmpty(raw.root)) data.root = raw.root;
  if (typeof raw.pinned === "boolean") data.pinned = raw.pinned;
  if (typeof raw.link === "string") data.link = raw.link;
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

const SCM_DIFF_MODES = new Set(["unstaged", "staged", "untracked", "commit", "stash"]);

export function validateSourceControlData(raw: Record<string, unknown>): Fields {
  const data: Fields = {};
  if (nonEmpty(raw.root)) data.root = raw.root;
  if (typeof raw.pinned === "boolean") data.pinned = raw.pinned;
  if (typeof raw.link === "string") data.link = raw.link;
  if (raw.viewMode === "list" || raw.viewMode === "tree") data.viewMode = raw.viewMode;
  if (raw.diffTarget && typeof raw.diffTarget === "object" && !Array.isArray(raw.diffTarget)) {
    const t = raw.diffTarget as Record<string, unknown>;
    if (nonEmpty(t.root) && nonEmpty(t.filePath) && typeof t.mode === "string" && SCM_DIFF_MODES.has(t.mode)) {
      const target: Record<string, unknown> = {
        root: t.root,
        filePath: t.filePath,
        mode: t.mode,
      };
      if (nonEmpty(t.oldPath)) target.oldPath = t.oldPath;
      if (nonEmpty(t.commitHash)) target.commitHash = t.commitHash;
      if (nonEmpty(t.label)) target.label = t.label;
      data.diffTarget = target;
    }
  }
  return data;
}

export const BUILTIN_VALIDATORS: Record<string, (raw: Record<string, unknown>) => Fields> = {
  terminal: validateTerminalData,
  "block-terminal": validateTerminalData,
  explorer: validateExplorerData,
  "source-control": validateSourceControlData,
  editor: validateFileData,
  viewer: validateFileData,
};
