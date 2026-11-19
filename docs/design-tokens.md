# Design tokens

Values come from the reference mockup (`mockup/`, not tracked in git). They
are defined once in `src/styles/index.css`: colors, fonts and the type scale
as Tailwind v4 `@theme` tokens (so they generate utilities such as
`bg-popover`, `text-fg-dim`, `text-meta`), and pane gradients as plain custom
properties on `:root`.

The color values in `index.css` are only defaults (Midterm Dark's resolved
values, so the first paint matches). The active theme sets every color token,
`--terminal-solid`, the `--pane-*` gradients, `--tab-active` and
`--shadow-menu` at runtime on `<html>`; see `docs/themes.md` for how a theme
derives them. The values below are Midterm Dark's.

Use the tokens. Do not write raw hex values, white/black alpha overlays
(`bg-white/[0.06]`, `rgb(255 255 255 / …)`) or pixel font sizes in components:
they break light themes. For a one-off tint with no token of its own, mix a
token, e.g. `color-mix(in srgb, var(--color-fg-bright) 8%, transparent)` or
the Tailwind modifier `bg-fg-bright/8`; scale a state token the same way
(`bg-hover/68`) when a state needs to be fainter than the standard one.

## Colors

| Token | Value | Used for |
|---|---|---|
| `app` | `#0C0D10` | Window background, text on accent |
| `field` | `#15161B` | Inputs, the command button |
| `popover` | `#1A1C22` | Menus, drag preview |
| `raised` | `#2A2D35` | Pressed/open icon buttons |
| `line` | `#1F2128` | Hairlines: title bar border, pane separators, tab edges |
| `line-menu` | `#262931` | Menu separators |
| `line-strong` | `#2A2D35` | Blockquote rule, the menu outline in `--shadow-menu` |
| `line-block` | `#FFFFFF0F` | Between blocks (blocks mode) |
| `line-input` | `#FFFFFF12` | Above the blocks input editor |
| `fg-bright` | `#F2F3F5` | Active tab, emphasized text |
| `fg` | `#E4E5E9` | Default text |
| `fg-soft` | `#D5D7DC` | Menu items, terminal text |
| `fg-mid` | `#B9BCC4` | Secondary icons and labels |
| `fg-muted` | `#9096A1` | Inactive tabs |
| `fg-dim` | `#858A96` | Hints, counts, shortcut labels |
| `fg-faint` | `#5A5F6A` | Ghost text, line numbers |
| `accent` | `#8B9CFF` | Active-pane bar, cursor, drop indicator, workspace badge |
| `accent-soft` | accent at 10% | Drop indicator fill |
| `accent-fg` | `#DDE2FF` | Text on `accent-soft` |
| `hover` | `#FFFFFF0F` | Hover / highlighted rows and buttons (`bg-hover`); explorer rows use it at 42.5% |
| `selected` | `#FFFFFF0F` | Selected / current item (`bg-selected`): palette item, settings section, explorer row (scaled) |
| `scrim` | `#00000059` | Modal backdrops (`bg-scrim`; the palette's is `bg-scrim/72`) |
| `shadow` | `#00000080` | Shadow color in `--shadow-menu`; at 50% the markdown code-block well |
| `ok` / `warn` / `err` / `info` | `#A5D6A7` / `#F2C27B` / `#E8868A` / `#82B4FF` | Status; `warn` is the tab activity dot |
| `keyword` / `comment` | `#C3A6FF` / `#7F8592` | Syntax: keywords, comments |
| `string` / `function` / `type` / `punctuation` | `#A5D6A7` / `#82B4FF` / `#F2C27B` / `#9096A1` | Syntax: strings, function names, types and tags (and numbers), angle brackets. Mapped from lezer tags in `src/editor/highlight.ts` |

`accent-soft` is derived from `accent` with `color-mix`, so changing the
accent changes both.

Further tokens, published for completeness (the terminal and blocks code reads
them from the resolved theme): `terminal-bg`, `terminal-fg`,
`terminal-cursor`, `terminal-cursor-accent`, `terminal-selection`,
`terminal-selection-inactive`, `terminal-match`, `terminal-match-active`, the
16 `ansi-*` colors (`ansi-black` … `ansi-bright-white`), and
`tab-active-from` / `tab-active-to` (the stops of `--tab-active`).
`terminal-solid` is published as `--terminal-solid`, not `--color-…`.

## Type

Fonts are bundled (`@fontsource-variable/*`), never fetched:
`font-sans` = Inter, `font-mono` = JetBrains Mono.

| Token | Size | Used for |
|---|---|---|
| `text-badge` | 9px | Workspace badge letter |
| `text-micro` | 10.5px | Shortcut hints, pane count |
| `text-meta` | 11px | Paths, status lines, secondary labels |
| `text-crumb` | 11.5px | Breadcrumbs, drop indicator label |
| `text-menu` | 12px | Menu items |
| `text-ui` | 12.5px | Default UI text (set on `body`) |
| `text-input` | 13px | Command input |
| `text-title` | 18px | Document headings in viewers |

Terminal text is 12.5px JetBrains Mono on 19px rows (`src/terminal/theme.ts`).
Editor text is the same font at the settings' size on 1.6× lines (20px at
12.5px), with a 40px right-aligned line-number gutter in `fg-faint`
(`src/styles/editor.css`). Ligatures are off in code.

## Pane backgrounds

Neutral graphite gradients whose angle varies slightly by pane kind:
`--pane-explorer`, `--pane-editor`, `--pane-terminal`,
`--pane-terminal-active`, `--pane-viewer`, and `--tab-active` for the active
tab. A terminal's background is transparent so its pane gradient shows.
`--pane-default` is for plugin panes without a background of their own; a
theme can add `--pane-<plugin id>`.

## Metrics

| Thing | Value |
|---|---|
| Title bar height | 38px (`--titlebar-height`) plus a 1px bottom border |
| Traffic-light gutter | 82px (6px in fullscreen, where macOS hides the buttons). The buttons start 14px from the left, vertically centred in the bar; `src-tauri/src/traffic_lights.rs` lays them out (not `trafficLightPosition`, which leaves their vertical position to AppKit) |
| Menu | 228px min width, 5px padding, 8px radius; items 28px tall, 5px radius |
| Pane hover controls | 6px from the pane's top-right; 12px icons, 3px padding |
| Active-pane bar | 2px, left edge |
| Drop indicator | inset 6px in its region, 6px radius, 1px accent border |
| Terminal padding | 10px top/bottom, 18px left |

## Terminal palette

ANSI colors in `src/terminal/theme.ts` reuse the status and syntax colors
above; bright variants are lighter tints of the same hues.
