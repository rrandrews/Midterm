import { useEffect } from "react";
import { create } from "zustand";
import { type JsonFile, openJsonFile } from "../ipc/jsonFile";
import { getSettings, useSettings } from "../settings/settings";
import { currentTheme, useThemeRevision } from "../theme/state";
import { buildIndex, defaultIcon, specificIcon } from "./resolve";
import { svgDataUrl, sanitizeSvg } from "./sanitize";
import { BUNDLED_ICON_SETS, DEFAULT_ICON_SET_ID, bundledIconSet } from "./sets";
import { minimalSet } from "./sets/minimal";
import type { IconImage, IconQuery, IconSet, IconSetInfo, LoadedIconSet } from "./types";
import { ICON_SET_ID, validateIconSet } from "./validate";

/*
 * Which icon set is showing, and the custom sets. The theme picks one
 * (`Theme.icons.set`), else the settings (`iconSet`), else Material. An id
 * that is not a known set falls through to the next. Custom sets live in
 * `iconsets.json`: `index` lists them, `set:<id>` holds one, read when it is
 * first used (a set can be megabytes; themes only name it).
 */

export const BUNDLED_IDS = BUNDLED_ICON_SETS.map((set) => set.id);

const NONE: LoadedIconSet = { id: "none", icon: () => null };

type IconState = {
  /** Custom sets, without their icons. */
  custom: IconSetInfo[];
  /** Sets ready to draw, by id. A Map: a custom set may be called `constructor`. */
  loaded: ReadonlyMap<string, LoadedIconSet>;
};

export const useIconState = create<IconState>()(() => ({
  custom: [],
  // The synchronous sets, so they draw on the first frame.
  loaded: new Map([
    ["none", NONE],
    ["minimal", minimalSet],
  ]),
}));

export function allIconSets(): IconSetInfo[] {
  return [...BUNDLED_ICON_SETS.map(({ load: _load, ...info }) => info), ...useIconState.getState().custom];
}

export function knownIconSet(id: string | undefined): id is string {
  return !!id && (!!bundledIconSet(id) || useIconState.getState().custom.some((set) => set.id === id));
}

/** The id of the set showing: the theme's, else the settings', else the default. */
export function activeIconSetId(): string {
  const themed = currentTheme().icons?.set;
  if (knownIconSet(themed)) return themed;
  const chosen = getSettings().iconSet;
  return knownIconSet(chosen) ? chosen : DEFAULT_ICON_SET_ID;
}

/*
 * Custom sets.
 */

const FILE = "iconsets.json";
let file: JsonFile | null = null;
/** Sets read or saved this session (the only store without Tauri). */
const sets = new Map<string, IconSet>();

export async function loadIconSets({ persist }: { persist: boolean }): Promise<void> {
  if (!persist) return;
  try {
    file = await openJsonFile(FILE);
    const index = await file.get<unknown[]>("index");
    if (!Array.isArray(index)) return;
    const custom: IconSetInfo[] = [];
    for (const raw of index) {
      if (typeof raw !== "object" || raw === null) continue;
      const { id, name, author, license, source } = raw as Record<string, unknown>;
      if (typeof id !== "string" || !ICON_SET_ID.test(id) || bundledIconSet(id) || typeof name !== "string") continue;
      if (custom.some((set) => set.id === id)) continue;
      const info: IconSetInfo = { id, name, bundled: false };
      if (typeof author === "string") info.author = author;
      if (typeof license === "string") info.license = license;
      if (typeof source === "string") info.source = source;
      custom.push(info);
    }
    useIconState.setState({ custom });
  } catch (error) {
    console.error("Could not load the icon sets:", error);
  }
}

/** A custom set with its icons, re-validated (the file can be edited by hand). */
export async function getCustomIconSet(id: string): Promise<IconSet | undefined> {
  const held = sets.get(id);
  if (held) return held;
  const raw = await file?.get<unknown>(`set:${id}`);
  if (raw === undefined || raw === null) return undefined;
  const result = validateIconSet(raw, BUNDLED_IDS);
  if (!result.ok) {
    console.error(`Icon set "${id}" is invalid:`, result.errors);
    return undefined;
  }
  const set = { ...result.set, id };
  sets.set(id, set);
  return set;
}

function infoOf(set: IconSet): IconSetInfo {
  const info: IconSetInfo = { id: set.id, name: set.name, bundled: false };
  if (set.author) info.author = set.author;
  if (set.license) info.license = set.license;
  if (set.source) info.source = set.source;
  return info;
}

function saveIndex(custom: IconSetInfo[]): void {
  useIconState.setState({ custom });
  void file
    ?.set(
      "index",
      custom.map(({ bundled: _bundled, ...info }) => info),
    )
    .catch((error) => console.error("Could not save the icon sets:", error));
}

function forgetLoaded(id: string): void {
  const loaded = new Map(useIconState.getState().loaded);
  loaded.delete(id);
  useIconState.setState({ loaded });
}

/** An id not used by any icon set, from `base`. */
export function freeIconSetId(base: string): string {
  const taken = new Set(allIconSets().map((set) => set.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Adds or replaces a custom set (an already validated one). Returns it as saved. */
export function saveIconSet(set: IconSet): IconSet {
  const saved = bundledIconSet(set.id) ? { ...set, id: freeIconSetId(set.id) } : set;
  sets.set(saved.id, saved);
  void file?.set(`set:${saved.id}`, saved).catch((error) => console.error("Could not save the icon set:", error));
  const custom = useIconState.getState().custom;
  const index = custom.findIndex((info) => info.id === saved.id);
  const info = infoOf(saved);
  // Drop a stale loaded copy.
  forgetLoaded(saved.id);
  loading.delete(saved.id);
  saveIndex(index === -1 ? [...custom, info] : custom.map((candidate, i) => (i === index ? info : candidate)));
  return saved;
}

export function deleteIconSet(id: string): void {
  sets.delete(id);
  loading.delete(id);
  void file?.set(`set:${id}`, null).catch((error) => console.error("Could not delete the icon set:", error));
  forgetLoaded(id);
  saveIndex(useIconState.getState().custom.filter((info) => info.id !== id));
  // Themes naming it fall through to the settings; the settings fall back to the default.
  if (getSettings().iconSet === id) useSettings.getState().updateSettings({ iconSet: DEFAULT_ICON_SET_ID });
}

/** A custom set ready to draw, over its `extends` base if any. Icons are sanitized again on first use. */
export function createCustomSet(set: IconSet, base: LoadedIconSet | null): LoadedIconSet {
  const index = buildIndex(set);
  const definitions = new Map(Object.entries(set.definitions));
  const images = new Map<string, IconImage | null>();
  const image = (id: string): IconImage | null => {
    let found = images.get(id);
    if (found === undefined) {
      const definition = definitions.get(id);
      const svg = definition ? sanitizeSvg(definition.svg) : null;
      found = svg ? { url: svgDataUrl(svg), mono: definition?.mono === true } : null;
      images.set(id, found);
    }
    return found;
  };
  const own = (id: string | undefined) => (id ? image(id) : null);
  return {
    id: set.id,
    icon(query: IconQuery, specificOnly?: boolean) {
      const specific = own(specificIcon(index, query)) ?? base?.icon(query, true) ?? null;
      if (specific || specificOnly) return specific;
      return own(defaultIcon(index, query)) ?? base?.icon(query) ?? null;
    },
  };
}

/*
 * Loading.
 */

const loading = new Map<string, Promise<LoadedIconSet | null>>();

async function load(id: string): Promise<LoadedIconSet | null> {
  const bundled = bundledIconSet(id);
  if (bundled) return bundled.load();
  const set = await getCustomIconSet(id);
  if (!set) return null;
  const base = set.extends ? await loadIconSet(set.extends) : null;
  return createCustomSet(set, base);
}

/** The set, loading it if needed (once). Null if it does not exist or failed to load. */
export function loadIconSet(id: string): Promise<LoadedIconSet | null> {
  const ready = useIconState.getState().loaded.get(id);
  if (ready) return Promise.resolve(ready);
  let pending = loading.get(id);
  if (!pending) {
    pending = load(id).then(
      (set) => {
        if (set && loading.get(id) === pending) {
          useIconState.setState((state) => ({ loaded: new Map(state.loaded).set(id, set) }));
        }
        return set;
      },
      (error: unknown) => {
        console.error(`Could not load icon set "${id}":`, error);
        return null;
      },
    );
    loading.set(id, pending);
  }
  return pending;
}

/**
 * The set showing and whether the theme is light, re-rendering when either
 * changes. `set` is null while it loads.
 */
export function useActiveIconSet(): { set: LoadedIconSet | null; light: boolean } {
  useThemeRevision();
  useSettings((state) => state.iconSet);
  useIconState((state) => state.custom);
  const loaded = useIconState((state) => state.loaded);
  const id = activeIconSetId();
  const set = loaded.get(id) ?? null;
  useEffect(() => {
    if (!set) void loadIconSet(id);
  }, [id, set]);
  return { set, light: currentTheme().kind === "light" };
}
