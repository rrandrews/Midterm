# Design tokens

Values come from the reference mockup (`mockup/`, not tracked in git). They
are defined once in `src/styles/index.css`: colors, fonts and the type scale
as Tailwind v4 `@theme` tokens (so they generate utilities such as
`bg-popover`, `text-fg-dim`, `text-meta`), and pane gradients as plain custom
properties on `:root`.

Use the tokens. Do not write raw hex values or pixel font sizes in components.

## Colors

| Token | Value | Used for |
|---|---|---|
| `app` | `#0C0D10` | Window background, text on accent |
| `field` | `#15161B` | Inputs, the command button |
| `popover` | `#1A1C22` | Menus, drag preview |
| `raised` | `#2A2D35` | Pressed/open icon buttons |
| `line` | `#1F2128` | Hairlines: title bar border, pane separators, tab edges |
| `line-menu` | `#262931` | Menu separators |
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
| `ok` / `warn` / `err` / `info` | `#A5D6A7` / `#F2C27B` / `#E8868A` / `#82B4FF` | Status; `warn` is the tab activity dot |
| `keyword` / `comment` | `#C3A6FF` / `#7F8592` | Syntax (editor, later) |

`accent-soft` is derived from `accent` with `color-mix`, so changing the
accent changes both.

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

## Pane backgrounds

Neutral graphite gradients whose angle varies slightly by pane kind:
`--pane-explorer`, `--pane-editor`, `--pane-terminal`,
`--pane-terminal-active`, `--pane-viewer`, and `--tab-active` for the active
tab. A terminal's background is transparent so its pane gradient shows.

## Metrics

| Thing | Value |
|---|---|
| Title bar height | 38px (`--titlebar-height`) |
| Traffic-light gutter | 68px |
| Menu | 228px min width, 5px padding, 8px radius; items 28px tall, 5px radius |
| Pane hover controls | 6px from the pane's top-right; 12px icons, 3px padding |
| Active-pane bar | 2px, left edge |
| Drop indicator | inset 6px in its region, 6px radius, 1px accent border |
| Terminal padding | 10px top/bottom, 18px left |

## Terminal palette

ANSI colors in `src/terminal/theme.ts` reuse the status and syntax colors
above; bright variants are lighter tints of the same hues.
