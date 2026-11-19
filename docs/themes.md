# Themes

Code: `src/theme/` (pure, no UI; import from `src/theme/index.ts`). Roadmap: M9
in `docs/roadmap.md`.

A theme is a small base palette plus optional overrides. `resolveTheme()`
derives every color the app uses from it, and that one resolved theme feeds
the CSS variables, xterm, blocks rendering, CodeMirror and the window.

## Files

| File | What |
|---|---|
| `types.ts` | `Theme`, `ResolvedTheme`, `TokenName`, `TOKEN_GROUPS`, `TOKEN_NAMES`, `ANSI_NAMES`, `BUILTIN_PANES`, `PaneBackground` |
| `color.ts` | Hex parsing and formatting, OKLab mixing, OKLCH lightness steps, WCAG contrast (on `culori/fn`, only the rgb, lrgb, oklab, oklch and p3 modes are bundled) |
| `validate.ts` | `validateTheme(unknown)` → `{ ok, theme }` or `{ ok: false, errors }`; `parseTheme` throws; `slugify` |
| `resolve.ts` | `resolveTheme`, `cssVariables`, `cssVariableName`, `paneBackground`, `paneGradient`, `contrastRatio` |
| `bundled/` | One file per bundled theme, `BUNDLED_THEMES`, `bundledTheme(id)`, `DEFAULT_THEME_ID`, `DEFAULT_LIGHT_THEME_ID` |
| `importers/` | `importItermColors`, `importVSCodeTheme`, `importBase16`, `importMidtermTheme` / `exportTheme`, `detectThemeFormat`, `importThemeFile`; fixtures in `importers/fixtures/` |

## The model

```ts
interface Theme {
  id: string;            // "midterm-dark": lowercase letters, digits, dashes
  name: string;
  kind: "dark" | "light";
  background: string;    // window background → token `app`
  foreground: string;    // default text → token `fg`
  accent: string;
  cursor?: string;       // terminal cursor, default: accent
  selection?: string;    // terminal selection, default: accent at 25%
  ansi: { black, red, green, yellow, blue, magenta, cyan, white,
          brightBlack, …, brightWhite };
  overrides?: Partial<Record<TokenName, string>>;
  panes?: Record<string, Partial<{ from: string; to: string; angle: number }>>;
  author?: string; source?: string; license?: string;
}
```

Colors are hex everywhere: `#rgb`, `#rrggbb` or `#rrggbbaa` in input,
normalized to lowercase `#rrggbb` (or `#rrggbbaa` when translucent; an `ff`
alpha is dropped). Validation ignores unknown top-level keys but rejects
unknown override tokens and pane fields (they are almost always typos).

`ResolvedTheme` is `{ id, name, kind, dark, tokens, panes, xterm }`:
`tokens` is a `Record<TokenName, string>` with every token, `panes` has every
`BUILTIN_PANES` key plus the theme's own, `xterm` is an `ITheme` and `dark`
is the flag for CodeMirror (`EditorView.theme({}, { dark })`) and
`color-scheme`.

## Tokens

Grouped as in `TOKEN_GROUPS` (the theme editor's groups). Every token is
published as `--color-<token>` except `terminal-solid`, which keeps its name
`--terminal-solid`. "Mix" is an OKLab mix of `fg` toward `app` (negative =
beyond `fg`). "Up n" is an OKLCH lightness step from the background: lighter
by n in dark themes, darker by 0.7n in light ones, with chroma scaled by
1 + 9n so tinted backgrounds stay tinted.

| Token | CSS variable | Derived from |
|---|---|---|
| **surfaces** | | |
| `app` | `--color-app` | `background` |
| `field` | `--color-field` | up 0.042 |
| `popover` | `--color-popover` | dark: up 0.068; light: `background` 70% toward white |
| `raised` | `--color-raised` | up 0.138 |
| `terminal-solid` | `--terminal-solid` | the `terminal` pane's `to` color |
| **lines** | | |
| `line` | `--color-line` | up 0.089 |
| `line-menu` | `--color-line-menu` | up 0.122 |
| `line-strong` | `--color-line-strong` | `raised` |
| `line-block` | `--color-line-block` | `fg` at alpha 0x0f |
| `line-input` | `--color-line-input` | `fg` at alpha 0x12 |
| **text** | | |
| `fg-bright` | `--color-fg-bright` | mix −0.055 |
| `fg` | `--color-fg` | `foreground` |
| `fg-soft` | `--color-fg-soft` | mix 0.057 |
| `fg-mid` | `--color-fg-mid` | mix 0.167 |
| `fg-muted` | `--color-fg-muted` | mix 0.33 |
| `fg-dim` | `--color-fg-dim` | mix 0.38 |
| `fg-faint` | `--color-fg-faint` | mix 0.573 |
| **accent** | | |
| `accent` | `--color-accent` | `accent` |
| `accent-soft` | `--color-accent-soft` | `accent` at alpha 0x1a (10%) |
| `accent-fg` | `--color-accent-fg` | `accent` 70% toward white (dark) or 45% toward black (light), pushed further until 7:1 against `app` |
| **states** (new; for the token audit) | | |
| `hover` | `--color-hover` | `fg` at alpha 0x0f (replaces `bg-white/[0.06]`) |
| `selected` | `--color-selected` | `fg` at alpha 0x1a (selected / current item) |
| `scrim` | `--color-scrim` | `#00000059` dark, `#00000033` light (modal backdrops) |
| `shadow` | `--color-shadow` | `#00000080` dark, `#00000029` light (menu shadow color) |
| **status** | | |
| `ok` / `warn` / `err` / `info` | `--color-ok` … | ANSI green / yellow / red / blue, each pushed toward `fg` until 3:1 against `app` |
| **syntax** | | |
| `keyword` | `--color-keyword` | ANSI magenta (3:1 as above) |
| `string` | `--color-string` | ANSI green |
| `function` | `--color-function` | ANSI blue |
| `type` | `--color-type` | ANSI yellow |
| `comment` | `--color-comment` | mix 0.4 |
| `punctuation` | `--color-punctuation` | `fg-muted` |
| **terminal** | | |
| `terminal-bg` | `--color-terminal-bg` | `#00000000` (transparent, the pane background shows) |
| `terminal-fg` | `--color-terminal-fg` | `fg` |
| `terminal-cursor` | `--color-terminal-cursor` | `cursor`, else `accent` |
| `terminal-cursor-accent` | `--color-terminal-cursor-accent` | `app` |
| `terminal-selection` | `--color-terminal-selection` | `selection`, else `accent` at 0x40 |
| `terminal-selection-inactive` | `--color-terminal-selection-inactive` | the selection at 60% of its alpha |
| `terminal-match` | `--color-terminal-match` | `accent` at 0x40 (find decorations) |
| `terminal-match-active` | `--color-terminal-match-active` | `accent` at 0x99 |
| **ansi** | | |
| `ansi-black` … `ansi-bright-white` | `--color-ansi-black` … | the theme's `ansi` (`brightBlack` → `ansi-bright-black`) |
| **tab** | | |
| `tab-active-from` | `--color-tab-active-from` | dark: `field`; light: lifted 0.042 (see panes) |
| `tab-active-to` | `--color-tab-active-to` | lifted 0.028 |

Composite variables written by `cssVariables()`:

- `--tab-active`: `linear-gradient(180deg, <tab-active-from> 0%, <tab-active-to> 100%)`
- `--shadow-menu`: `0 0 0 1px <line-strong>, 0 12px 32px <shadow>`
- `--pane-<key>` for every pane background (below)

The xterm `ITheme` (`resolved.xterm`) is the `terminal-*` and `ansi-*`
tokens: `background`, `foreground`, `cursor`, `cursorAccent`,
`selectionBackground`, `selectionInactiveBackground` and the 16 colors. The
solid-background setting uses `terminal-solid` instead of `terminal-bg`.

### Pane backgrounds

Pane kinds are becoming plugins, so pane backgrounds are an open map keyed by
plugin id rather than tokens. Each is a two-stop gradient
`{ from, to, angle }` (a solid color when `from === to`), published as
`--pane-<key>`. Every resolved theme has the `BUILTIN_PANES` keys, because the
app's CSS uses them: `default`, `terminal`, `terminal-active` (focused
terminal), `explorer`, `editor`, `viewer`. A theme may add keys for other
plugins (`panes: { "acme.notes": { from: "#…" } }`); missing fields come from
`default`. `paneBackground(resolved, pluginId)` falls back to `default` for a
plugin the theme does not mention.

Derived pane colors are "lifted": lighter than the background in both kinds
(content sits above the chrome; in a light theme that means toward white).
Lift steps (from, to, angle): default 0.026 / 0.008 / 180°, terminal
0.024 / 0.005 / 185°, terminal-active 0.042 / 0.024 / 180°, explorer
0.028 / 0.009 / 180°, editor 0.033 / 0.014 / 175°, viewer 0.033 / 0.009 / 170°.

## Resolution rules

1. Tokens are set in dependency order (surfaces, text, lines, accent, states,
   ANSI, status, syntax, panes, terminal). Each token takes the theme's
   override if it has one, otherwise the derivation, so a token derived from
   an overridden one follows the override (override `fg` and `terminal-fg`,
   the text tiers and `comment` all move with it).
2. Pane backgrounds: derived, then the theme's `panes[key]` fields on top.
3. All outputs are lowercase hex; derived colors are gamut-mapped into sRGB
   (OKLCH chroma reduction).
4. `contrastRatio(a, b)` is WCAG 2's ratio; a translucent `a` is composited
   over `b` first.

**Midterm Dark is pinned.** Resolving it reproduces every value that was
hard-coded in `src/styles/index.css` and `src/terminal/theme.ts` before
themes existed; its `overrides` and `panes` hold the values the color math
lands near but not on. `resolve.test.ts` asserts the equality — keep it
passing when changing the derivation (add an override rather than change
the look). Two values are equal in effect but written differently:
`accent-soft` is `#8b9cff1a` where index.css had a `color-mix(… 10%,
transparent)`, and `--shadow-menu` uses `#00000080` for `rgb(0 0 0 / 0.5)`.

## Importers

Each is a pure `string → Theme` (validated), throwing an `Error` with a clear
message on bad input. Formats without a name take `options.name`
(`importThemeFile` passes the file name without extension). Missing ANSI
colors come from VS Code's default terminal palette for the theme's kind
(`DEFAULT_ANSI`); a missing accent falls back to ANSI blue; a missing kind is
inferred from the background's luminance (`kindOf`, dark below 0.18).

`detectThemeFormat(fileName, text)` goes by extension (`.itermcolors`,
`.yaml`/`.yml`), then content: an XML plist is iTerm2; JSON (comments
allowed) is Midterm when it has a top-level `midtermTheme` or `ansi`, VS Code
when it has a top-level `colors` or `tokenColors`; `scheme:`/`system:`/
`base00:` lines are Base16; anything else is tried as Midterm JSON.

### iTerm2 `.itermcolors` (`importItermColors`)

An XML plist parsed with `DOMParser` (tests run in `happy-dom` via a
per-file `// @vitest-environment happy-dom` comment; the rest of the suite
stays in node).

| iTerm2 key | Theme |
|---|---|
| `Ansi 0 Color` … `Ansi 15 Color` | `ansi.black` … `ansi.brightWhite` |
| `Background Color` / `Foreground Color` | `background` / `foreground` (required) |
| `Cursor Color` | `cursor`, and `accent` when it is colorful (OKLCH chroma > 0.05), else ANSI blue |
| `Selection Color` | `selection` (alpha kept) |
| `Cursor Text Color` | override `terminal-cursor-accent` |

Components are floats. `Color Space` `P3` is converted from Display P3 and
gamut-mapped; `sRGB`, `Calibrated` (generic RGB, close enough for a palette)
and a missing color space (older files) are read as sRGB.

### VS Code theme JSON (`importVSCodeTheme`)

Parsed with `jsonc-parser` (comments, trailing commas). `include` (a parent
theme) cannot be followed and is ignored. `#rgba` is expanded. `type`:
`dark`/`hc`/`hc-black` → dark, `light`/`hcLight`/`hc-light` → light, else
inferred. First match wins in each list:

| Theme | VS Code `colors` |
|---|---|
| `background` | `editor.background`, `terminal.background`, `sideBar.background` |
| `foreground` | `editor.foreground`, `terminal.foreground`, `foreground` |
| `accent` | first opaque one with 3:1 contrast against the background: `focusBorder`, `button.background`, `activityBarBadge.background`, `textLink.foreground`; else ANSI blue |
| `cursor` | `terminalCursor.foreground`, `editorCursor.foreground` |
| `selection` | `terminal.selectionBackground`, `editor.selectionBackground` |
| `ansi.*` | `terminal.ansiBlack` … `terminal.ansiBrightWhite` |
| override `field` | `input.background` |
| override `popover` | `editorWidget.background`, `menu.background`, `quickInput.background` |
| override `line` | `editorGroup.border`, `panel.border`, `sideBar.border` |
| override `fg-faint` | `editorLineNumber.foreground` |
| override `err` / `warn` / `info` | `editorError.foreground` (`errorForeground`) / `editorWarning.foreground` / `editorInfo.foreground` |
| override `terminal-fg` | `terminal.foreground` |
| panes `terminal`, `terminal-active` (solid) and override `terminal-solid` | `terminal.background`, when opaque and different from the editor's, so `terminal.foreground` stays readable |

Overrides take opaque colors only (translucent workbench colors are drawn
over other surfaces in VS Code). Syntax overrides come from `tokenColors`:
for each token the first rule whose scope equals one of these (in order), or
failing that is one segment more specific (`string.quoted`):

| Token | Scopes |
|---|---|
| `comment` | `comment` |
| `string` | `string` |
| `keyword` | `keyword`, `storage.type`, `storage` |
| `function` | `entity.name.function`, `support.function` |
| `type` | `entity.name.type`, `support.type`, `entity.name.class`, `constant.numeric` |
| `punctuation` | `punctuation` |

### Base16 / Base24 YAML (`importBase16`)

Parsed with `yaml` using the failsafe schema (every scalar a string, so
`base00: 000000` is not read as a number). Both formats:

- original: top-level `scheme`, `author`, `base00` … `base0F` (Base24 adds
  `base10` … `base17`), values with or without `#`;
- tinted-theming: `system`, `name`, `author`, `variant` (`dark`/`light`) and
  the colors under `palette`.

Keys are matched case-insensitively (`base0A`/`base0a`). Base24 is used when
all of `base10` … `base17` are present.

| Theme | Base16 | Base24 difference |
|---|---|---|
| `background` / `foreground` | `base00` / `base05` | |
| `accent` / `cursor` / `selection` | `base0D` / `base05` / `base02` | |
| ANSI black, red, green, yellow, blue, magenta, cyan, white | `base00`, `08`, `0B`, `0A`, `0D`, `0E`, `0C`, `05` | |
| ANSI bright black, bright white | `base03`, `base07` | |
| ANSI bright red, green, yellow, blue, magenta, cyan | same as normal | `base12`, `14`, `13`, `16`, `17`, `15` |
| overrides `field`, `popover` / `raised`, `line-strong` | `base01` / `base02` | |
| overrides `fg-bright` / `fg-dim` / `fg-faint`, `comment` | `base06` / `base04` / `base03` | |
| overrides `keyword` / `string` / `function` / `type` | `base0E` / `base0B` / `base0D` / `base0A` | |

### Midterm JSON (`exportTheme` / `importMidtermTheme`)

The `Theme` object as is, with `"midtermTheme": 1` first so the file says
what it is. Import accepts files with or without the marker, rejects a newer
format number, and validates with `parseTheme`. Export → import round-trips
exactly.

## Bundled themes

`BUNDLED_THEMES` (gallery order): Midterm Dark (default), Midterm Light,
Dracula, Nord, Solarized Dark, Solarized Light, Gruvbox Dark, Gruvbox Light,
Tokyo Night, Catppuccin Mocha, Catppuccin Latte, One Dark, GitHub Dark
(Default), GitHub Light (Default), Rosé Pine, Monokai. Each file credits its
author, source URL and license in a comment and in the theme's fields.

Midterm Light is Midterm's own: the same cool graphite neutrals and
periwinkle accent as Midterm Dark, darkened for a light background.

### Adding a bundled theme

1. Create `src/theme/bundled/<camelName>.ts` exporting a `Theme`, with a
   comment giving author, source URL and license, and the same in `author`,
   `source`, `license`. Use the palette's official published hex values,
   lowercase.
2. Fill the base palette and all 16 ANSI colors from the official terminal
   port. Add `overrides` only where the palette defines a role the derivation
   would miss (syntax colors, comment color, surface steps the palette names).
3. Add it to `BUNDLED_THEMES` in `bundled/index.ts`.
4. `bun run test`: `bundled.test.ts` checks validity, normalization,
   attribution, that `kind` matches the background, and minimum contrast for
   text, status and syntax colors.

## Applying a theme

_Stub: to be written with `applyTheme` (CSS variables on `<html>`,
`color-scheme`, live xterm sessions, blocks re-render, CodeMirror's dark flag,
native window theme and background, no flash at startup)._

## Settings and gallery

_Stub: to be written with the `theme` setting, follow-system, the accent as an
override, custom themes in `themes.json`, and the Appearance gallery._

## Theme editor pane

_Stub: to be written with the theme editor pane plugin._
