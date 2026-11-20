import manifest from "material-icon-theme/dist/material-icons.json";
import { buildIndex, iconIdFor } from "../resolve";
import type { IconMapping, LoadedIconSet } from "../types";

/*
 * Material Icon Theme (MIT, https://github.com/material-extensions/vscode-material-icon-theme),
 * the default set. Only its data is used: the generated VS Code icon theme
 * manifest and the SVG files, emitted as separate assets (`?no-inline`) so
 * each is fetched only when a row needs it. This module is reached only
 * through `import()`, so none of it is in the startup bundle. Its MIT
 * notice ships as public/licenses/material-icon-theme.txt (dist/licenses/);
 * a test keeps that copy equal to the package's LICENSE.
 */

// `exhaustive`: Vite skips node_modules in globs otherwise.
const SVG_URLS = import.meta.glob<string>("/node_modules/material-icon-theme/icons/*.svg", {
  query: "?no-inline",
  import: "default",
  eager: true,
  exhaustive: true,
});

const ICON_DIR = "/node_modules/material-icon-theme/icons/";

type Manifest = IconMapping & {
  iconDefinitions: Record<string, { iconPath: string }>;
  light?: IconMapping;
};

/** Icon id → asset URL. */
export function materialUrls(data: Manifest = manifest as Manifest): Map<string, string> {
  const urls = new Map<string, string>();
  for (const [id, { iconPath }] of Object.entries(data.iconDefinitions)) {
    const url = SVG_URLS[ICON_DIR + iconPath.slice(iconPath.lastIndexOf("/") + 1)];
    if (url) urls.set(id, url);
  }
  return urls;
}

export function createMaterialSet(): LoadedIconSet {
  const data = manifest as Manifest;
  const index = buildIndex(data);
  const urls = materialUrls(data);
  return {
    id: "material",
    icon(query, specificOnly) {
      const id = iconIdFor(index, query, specificOnly);
      const url = id ? urls.get(id) : undefined;
      return url ? { url, mono: false } : null;
    },
  };
}
