import { create } from "zustand";
import { confirm } from "../../components/ui/ConfirmDialog";
import { type SettingsScope, getSettings, settingsFor, useSettings } from "../../settings/settings";
import { DEFAULT_LIGHT_THEME_ID, DEFAULT_THEME_ID } from "../bundled";
import { findTheme, freeThemeId, freeThemeName, isBundled, saveTheme, selectTheme, selectedThemeId, useThemeState } from "../state";
import type { AnsiName, PaneBackground, Theme, TokenName } from "../types";

/*
 * The theme editor's draft (Settings → Theme editor): a copy of the theme
 * being edited (`sourceId`), with undo and redo. While it differs from the
 * saved theme it is shown everywhere (`useThemeState.draft`), so edits
 * preview on the real terminals and files behind the settings dialog.
 * Saving writes a custom theme (a bundled theme is saved as a new one);
 * discarding goes back to the saved theme.
 */

type DraftState = {
  /** Id of the theme being edited; null when nothing is. */
  sourceId: string | null;
  draft: Theme | null;
  past: Theme[];
  future: Theme[];
};

const HISTORY_LIMIT = 200;

export const useThemeDraft = create<DraftState>()(() => ({ sourceId: null, draft: null, past: [], future: [] }));

const sameTheme = (a: Theme | null | undefined, b: Theme | null | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** Whether the draft has edits that are not saved. */
export function isDraftDirty(state: DraftState = useThemeDraft.getState()): boolean {
  if (!state.sourceId || !state.draft) return false;
  return !sameTheme(state.draft, findTheme(state.sourceId));
}

/** Shows the draft while it differs from the saved theme. */
function publish(): void {
  const state = useThemeDraft.getState();
  useThemeState.setState({ draft: isDraftDirty(state) ? state.draft : null });
}

/**
 * Asks before replacing a dirty draft with another theme. Resolves true when
 * it is fine to switch (nothing unsaved, the same theme, or confirmed).
 */
export async function mayEditAnother(themeId: string): Promise<boolean> {
  const state = useThemeDraft.getState();
  if (state.sourceId === themeId || !isDraftDirty(state)) return true;
  return confirm({
    title: "Discard theme changes?",
    message: `“${state.draft?.name ?? "The theme"}” has unsaved changes. Editing another theme discards them.`,
    action: "Discard",
  });
}

/**
 * Asks before leaving the editor with unsaved edits. True at once when
 * there are none; otherwise resolves to whether the user chose to discard
 * them (the draft is dropped then).
 */
export function mayLeaveEditor(): true | Promise<boolean> {
  const state = useThemeDraft.getState();
  if (!isDraftDirty(state)) return true;
  return confirm({
    title: "Discard theme changes?",
    message: `“${state.draft?.name ?? "The theme"}” has unsaved changes. Leaving the theme editor discards them.`,
    action: "Discard",
  }).then((ok) => {
    if (ok) stopEditing();
    return ok;
  });
}

/** Starts editing a theme (keeping a draft already open for it). */
export function startEditing(themeId: string): void {
  const state = useThemeDraft.getState();
  if (state.sourceId === themeId && state.draft) return;
  const theme = findTheme(themeId);
  if (!theme) return;
  useThemeDraft.setState({ sourceId: themeId, draft: structuredClone(theme), past: [], future: [] });
  publish();
}

/** Stops editing, dropping unsaved edits. */
export function stopEditing(): void {
  useThemeDraft.setState({ sourceId: null, draft: null, past: [], future: [] });
  publish();
}

/** Applies `change` to a copy of the draft, as one undo step. Consecutive changes with the same `coalesce` key merge. */
let lastCoalesce: string | null = null;
let lastCoalesceAt = 0;

export function editDraft(change: (theme: Theme) => void, coalesce?: string): void {
  const { draft, past } = useThemeDraft.getState();
  if (!draft) return;
  const next = structuredClone(draft);
  change(next);
  if (sameTheme(next, draft)) return;
  // A drag in a color picker is many changes; keep it as one step.
  const merge = coalesce !== undefined && coalesce === lastCoalesce && performance.now() - lastCoalesceAt < 800;
  lastCoalesce = coalesce ?? null;
  lastCoalesceAt = performance.now();
  useThemeDraft.setState({
    draft: next,
    past: merge ? past : [...past, draft].slice(-HISTORY_LIMIT),
    future: [],
  });
  publish();
}

export function undo(): void {
  const { draft, past, future } = useThemeDraft.getState();
  const previous = past[past.length - 1];
  if (!draft || !previous) return;
  lastCoalesce = null;
  useThemeDraft.setState({ draft: previous, past: past.slice(0, -1), future: [draft, ...future] });
  publish();
}

export function redo(): void {
  const { draft, past, future } = useThemeDraft.getState();
  const [next, ...rest] = future;
  if (!draft || !next) return;
  lastCoalesce = null;
  useThemeDraft.setState({ draft: next, past: [...past, draft], future: rest });
  publish();
}

/** Sets a token override, or removes it (back to derived) with `undefined`. */
export function setToken(token: TokenName, value: string | undefined): void {
  editDraft((theme) => {
    const overrides = { ...theme.overrides };
    if (value === undefined) delete overrides[token];
    else overrides[token] = value;
    theme.overrides = overrides;
  }, `token:${token}`);
}

export type BaseField = "background" | "foreground" | "accent" | "cursor" | "selection";

export function setBase(field: BaseField, value: string | undefined): void {
  editDraft((theme) => {
    if (value === undefined) {
      if (field === "cursor" || field === "selection") delete theme[field];
    } else theme[field] = value;
  }, `base:${field}`);
}

export function setAnsi(name: AnsiName, value: string): void {
  editDraft((theme) => {
    theme.ansi = { ...theme.ansi, [name]: value };
  }, `ansi:${name}`);
}

export function setKind(kind: Theme["kind"]): void {
  editDraft((theme) => {
    theme.kind = kind;
  });
}

export function setPane(key: string, part: keyof PaneBackground, value: string | number | undefined): void {
  editDraft((theme) => {
    const panes = { ...theme.panes };
    const pane: Partial<PaneBackground> = { ...panes[key] };
    if (value === undefined) delete pane[part];
    else (pane as Record<string, unknown>)[part] = value;
    if (Object.keys(pane).length) panes[key] = pane;
    else delete panes[key];
    theme.panes = panes;
  }, `pane:${key}:${part}`);
}

/** Sets the theme's icon set, or removes it (the settings' choice) with `undefined`. */
export function setIconSet(id: string | undefined): void {
  editDraft((theme) => {
    if (id === undefined) delete theme.icons;
    else theme.icons = { set: id };
  });
}

export function renameDraft(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  editDraft((theme) => {
    theme.name = trimmed;
  });
}

/**
 * Saves the draft: over the custom theme it came from, or, for a bundled
 * theme, as a new custom theme. The saved theme is shown if the edited one
 * was. Returns the saved theme.
 */
export function saveDraft(scope?: SettingsScope): Theme | null {
  const { draft, sourceId } = useThemeDraft.getState();
  if (!draft || !sourceId) return null;
  // The theme itself is shared; which theme shows is the settings scope's (the one Settings is editing).
  const settings = scope ? settingsFor(scope) : getSettings();
  const wasShowing = selectedThemeId(settings) === sourceId;
  const saved = isBundled(sourceId)
    ? saveTheme({ ...draft, id: freeThemeId(`${draft.id}-custom`), name: freeThemeName(`${draft.name} (custom)`), author: undefined, source: undefined, license: undefined })
    : saveTheme(draft);
  useThemeDraft.setState({ sourceId: saved.id, draft: structuredClone(saved), past: [], future: [] });
  if (wasShowing || isBundled(sourceId)) selectTheme(saved.id, scope);
  repairSystemPicks(saved, scope);
  publish();
  return saved;
}

/** A theme whose kind changed may no longer be the light (or dark) pick for following the system. */
function repairSystemPicks(theme: Theme, scope?: SettingsScope): void {
  const { themeLight, themeDark } = scope ? settingsFor(scope) : getSettings();
  const patch: { themeLight?: string; themeDark?: string } = {};
  if (themeDark === theme.id && theme.kind !== "dark") patch.themeDark = DEFAULT_THEME_ID;
  if (themeLight === theme.id && theme.kind !== "light") patch.themeLight = DEFAULT_LIGHT_THEME_ID;
  if (Object.keys(patch).length) useSettings.getState().updateSettings(patch, scope);
}

/** Back to the saved theme (undoable). */
export function discardDraft(): void {
  const { sourceId, draft, past } = useThemeDraft.getState();
  const saved = sourceId ? findTheme(sourceId) : undefined;
  if (!saved || !draft || sameTheme(saved, draft)) return;
  lastCoalesce = null;
  useThemeDraft.setState({ draft: structuredClone(saved), past: [...past, draft].slice(-HISTORY_LIMIT), future: [] });
  publish();
}
