import type { IconSetInfo, LoadedIconSet } from "../types";
import { minimalSet } from "./minimal";

/* The icon sets that ship with Midterm. */

export const DEFAULT_ICON_SET_ID = "material";

export type BundledIconSet = IconSetInfo & { load: () => Promise<LoadedIconSet> };

export const BUNDLED_ICON_SETS: readonly BundledIconSet[] = [
  {
    id: "material",
    name: "Material",
    author: "Material Extensions",
    license: "MIT",
    source: "https://github.com/material-extensions/vscode-material-icon-theme",
    bundled: true,
    load: () => import("./material").then((module) => module.createMaterialSet()),
  },
  {
    id: "minimal",
    name: "Minimal",
    author: "Lucide",
    license: "ISC",
    source: "https://lucide.dev",
    bundled: true,
    load: async () => minimalSet,
  },
  { id: "none", name: "None", bundled: true, load: async () => ({ id: "none", icon: () => null }) },
];

export function bundledIconSet(id: string): BundledIconSet | undefined {
  return BUNDLED_ICON_SETS.find((set) => set.id === id);
}
