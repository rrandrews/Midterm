# File icons

The explorer shows an icon for each file and folder, chosen by name. Icons
come from an **icon set**. Three sets ship with Midterm; users can import
their own, and a theme can name the set it wants.

## Source map (`src/icons/`)

| File | Role |
|---|---|
| `types.ts` | `IconMapping`, `IconSet` (a custom set), `IconSetInfo`, `IconQuery`, `IconImage`, `LoadedIconSet`. |
| `resolve.ts` | Pure lookup: `buildIndex(mapping)`, `specificIcon`, `defaultIcon`, `iconIdFor`, `extensionsOf`. Unit-tested. |
| `languages.ts` | Extension / file name → VS Code language id, for a set's `languageIds`. |
| `sets/index.ts` | `BUNDLED_ICON_SETS` (`material`, `minimal`, `none`) and `DEFAULT_ICON_SET_ID`. |
| `sets/material.ts` | The Material set. Loaded with `import()` only. |
| `sets/minimal.ts` | Lucide icons in the text color. |
| `sanitize.ts` | `sanitizeSvg`, `svgDataUrl`. |
| `validate.ts` | `validateIconSet` / `parseIconSet` (untrusted JSON → `IconSet`), `exportIconSet`, limits. |
| `state.ts` | Which set is showing, loading (`loadIconSet`, `useActiveIconSet`), custom sets in `iconsets.json`, `createCustomSet`. |
| `files.ts` | Import and export dialogs; `parseIconSetFile` inlines `path` definitions. |
| `FileIcon.tsx` | The 16px icon component. |

## Which set shows

`activeIconSetId()` picks the first known id among:

1. `currentTheme().icons.set` (the preview, the editor's draft or the
   selected theme);
2. the `iconSet` setting;
3. `material`.

An id that names no bundled or custom set falls through to the next.
Bundled themes name no set.

## Bundled sets

| Id | Set | Notes |
|---|---|---|
| `material` | [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) 5.40.0, MIT | The default. Full color. |
| `minimal` | Lucide (`File`, `FileCode`, `FileText`, `FileImage`, `Folder`, `FolderOpen`), ISC | Monochrome, in `--color-fg-dim`. |
| `none` | | No icons; rows look as they did before icons existed. |

Material is used as data only: its generated VS Code icon theme manifest
(`dist/material-icons.json`) and its `icons/*.svg`. Do not import the
package's JS, which pulls in other dependencies. `sets/material.ts` globs
the SVGs with `query: "?no-inline"` and `exhaustive: true`:

- `?no-inline`: Vite inlines files under 4 KB as data URLs otherwise;
- `exhaustive`: Vite skips `node_modules` in globs otherwise.

The build emits the SVGs as separate assets (identical files are deduped,
so there are slightly fewer files than icons). Each is fetched when a row
first needs it. The manifest and the URL map are a lazy chunk of about
85 KB gzipped; the startup bundle holds only `state.ts` and the resolver.

Bumping Material: change the exact version in `package.json`, run
`bunx vitest run src/icons` (`material.test.ts` fails if an icon id has no
SVG), and look at the explorer in a dark and a light theme.

## Resolution

VS Code's order (`resolve.ts`):

- **Files**: file name, longest path tail first (`.config/graphqlrc` beats
  `graphqlrc`); then extension, longest first (`a.test.ts` tries `test.ts`,
  then `ts`; `.gitignore` tries `gitignore`); then language id; then the
  set's `file`.
- **Folders**: folder name (`folderNamesExpanded` when open), path tails
  too (`.github/workflows`); then `folderExpanded` / `folder`.
- Under a light theme the set's `light` mappings are tried first.
- Matching is case-insensitive and uses `Map`s throughout, because files
  named `constructor` or `__proto__` exist.

A custom set with `extends` sits over a bundled one. Any name, extension or
language match wins over any fallback: first the custom set's own match,
then the base's, then the custom set's fallback, then the base's
(`LoadedIconSet.icon(query, specificOnly)`).

## Drawing

`FileIcon` draws an image icon as `<img src>`, and a `mono` icon as a
`<span>` with `mask-image` and `background: currentColor`. Lucide icons are
React components. It never draws inline SVG: SVG loaded as an image runs no
script and loads nothing, and ids inside different icons cannot collide.
The CSP already allows this (`img-src 'self' blob: data:`).

The explorer calls `useActiveIconSet()` once per view and passes the set to
each row. While a set loads, a blank 16px box holds the space. The `none`
set draws nothing and status rows lose the extra indent. Hidden and
ignored entries draw their icon at 55% opacity (`.explorer-row.is-dim`).

## Custom sets

### File format

A Midterm icon set file uses VS Code's mapping keys, so mappings can be
copied from a VS Code icon theme:

```jsonc
{
  "midtermIconSet": 1,
  "id": "my-icons", "name": "My Icons",          // id: from the name if omitted
  "author": "…", "license": "…", "source": "…",  // optional
  "extends": "material",                         // optional: a bundled set underneath
  "definitions": {
    "ts":     { "svg": "<svg …>…</svg>" },
    "folder": { "path": "icons/folder.svg", "mono": true }
  },
  "file": "…", "folder": "…", "folderExpanded": "…",
  "fileNames": {}, "fileExtensions": {}, "folderNames": {},
  "folderNamesExpanded": {}, "languageIds": {},
  "light": { /* the same mapping keys, for light themes */ }
}
```

- A `path` definition is relative to the JSON file, must end in `.svg`,
  and is read and inlined at import, so stored sets stand alone.
- `mono: true` draws the icon as a mask in the row's text color.
- Without `extends` the set replaces the default; entries it does not
  match get its own `file` / `folder`, or no icon.
- A mapping to an icon id missing from `definitions` is an error.

### Sanitizing and limits

Drawing as an image is the real guarantee. `sanitizeSvg` is a second layer,
run at import and again when an icon is first drawn (`iconsets.json` can be
edited by hand):

- a dedicated DOMPurify instance (the default one carries the Markdown
  viewer's hooks) with the SVG profiles, forbidding `<style>`,
  `<foreignObject>`, `<image>`, `<a>` and `<script>`. DOMPurify also drops
  `<use>`;
- then the icon is rejected unless its root is `<svg>`, every `href` is
  `#…` and every `url(…)` is `url(#…)`;
- `xmlns` is added when missing, or the data URL would not render.

Limits: 64 KB per icon, 4,000 icons, 4 MB per set, 128-character mapping
keys, icon ids `[\w.-]{1,64}`.

### Storage

`iconsets.json` (tauri-plugin-store): `index` lists the sets
(`IconSetInfo` without `bundled`), and `set:<id>` holds one set, read the
first time it is used. A deleted set's key is set to `null`. Custom sets are
not stored in the theme, because the theme editor clones the draft for undo
and serializes it on every edit.

### Themes

`Theme.icons = { set: "<id>" }` is the only theme field. Exporting a theme
that names a custom set embeds the set as a top-level `"iconSet"` in the
Midterm theme file; importing it adds the set under a free id and points the
theme at it. Older builds ignore the key, so the format number stays 1.

### UI

- Settings → Appearance → **File icons**: the set, Import… (Midterm icon set
  JSON), and Export… / Delete for a custom set. The hint says when the
  current theme overrides the choice.
- Theme editor → **File icons**: "From settings" or a set, with sample
  icons.

## Tests

- `resolve.test.ts`: lookup order, path tails, case, light mappings,
  prototype names.
- `sets/material.test.ts`: every manifest icon has an SVG; common names.
- `sanitize.test.ts` and `validate.test.ts` run under jsdom (happy-dom's
  DOMPurify drops the `<svg>` root). They cover hostile markup, limits,
  round trips, and custom sets over a base.
- The self-test (`iconChecks` in `src/dev/selftest.ts`) loads Material in
  the real WebView, decodes an icon, and draws a sanitized hostile SVG
  without it running anything.

## Later

- Import VS Code icon themes (`iconDefinitions` with SVG `iconPath`s).
- Icons in tab titles, file pane headers and palette file results.
