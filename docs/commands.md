# Commands, shortcuts and settings

## Command registry (`src/commands/`)

Every user-level command is registered in `src/commands/registry.ts` with
an id, title, category and default key bindings. Keyboard shortcuts
(`src/shortcuts.ts`), menu key hints (`shortcutLabel(id)`), the command
palette and the native menu bar are generated from it.

| File | Role |
|---|---|
| `keys.ts` | Key chords: parse `"Cmd+Shift+D"`, match events (on `event.code`), format `⇧⌘D`, Tauri accelerators. Unit-tested. |
| `registry.ts` | `registerCommands`, `runCommand`, `commandForEvent`, effective bindings, recent commands, pane actions. |
| `core.ts` | The app's own commands (tabs, panes, workspaces, find/save forwarding). |

- Ids are stable (`pane.splitRight`); settings refer to them.
- Registered elsewhere: each pane plugin's `commands` while it is enabled
  (`terminal.toggleBlocks`, `editor.revert`, an imported plugin's), the
  generated `pane.new.<kind>` / `pane.newTab.<kind>` / `pane.changeTo.<kind>`
  for every enabled plugin (`src/plugins/paneCommands.ts`), the palette's
  (`src/palette/state.ts`) and the settings dialog's. See
  [plugins.md](plugins.md#commands-and-menus).
- `category` is any string; `menu` names the native menu bar submenu a
  command is listed in after the app's own items (`src/commands/nativeMenu.ts`).
- The functions commands run stay in `src/actions.ts` (and `closing.ts`).
  Add the function there, then register a command for it.
- `enabled()`: a disabled command does not take its keys, so they reach
  the focused element (e.g. ⌃G reaches a terminal when no editor is
  active) and it is left out of the palette.
- **Pane actions**: commands like Find, Save and Go to line act on the
  active pane. Pane content registers what it supports with
  `registerPaneActions(paneId, { find, save, … })` while mounted; the
  command forwards to the active pane's action and is enabled only when
  there is one. `paneActionCommand` builds such a command for any action
  name (`PaneActions` is open to plugins).
- A chord bound to two commands goes to the first enabled one.
- Shortcuts are suspended while a rename field or confirmation is open, or
  while any element with `data-owns-keyboard` is mounted (palette,
  settings dialog).

## Settings (`src/settings/`)

`schema.ts` defines `Settings`, the defaults, `migrateSettings` and
`validateSettings` (untrusted input; every field falls back to its default
on its own). The file has a `version` (`SETTINGS_VERSION`, now 2):
version 1 kept the terminal's settings at the top level, and the migration
moves them into `plugins.terminal.settings`. Global fields: fonts, accent,
key bindings, `defaultPaneKind`. Everything a plugin owns is in
`plugins[id] = { enabled, settings, skills }`, validated against the
plugin's declared fields when read (`src/plugins/settings.ts`; the
terminal's are in `src/terminal/settings.ts`, the editor's and viewer's in
`src/editor/settings.ts`). See [plugins.md](plugins.md#settings).
`settings.ts` is the zustand store (`useSettings`, `getSettings`),
loaded from `settings.json` in the app data directory before the first
render and saved 200 ms after each change. Dev runs with `?mockup` or
`?selftest` use defaults and save nothing.

`keybindings` maps a command id to the bindings that replace its defaults
(an empty list unbinds it).

## Settings dialog

`src/settings/SettingsDialog.tsx` (⌘, or the app menu). Sections come from
a registry (`src/settings/sections.ts`): General (font family and size, what
new tabs and splits open), Appearance (themes and the accent; see
[themes.md](themes.md#settings-and-gallery)), Plugins (`PluginSettings.tsx`:
installed plugins, enable/disable, import, remove) and Keyboard (click a
shortcut and press the new keys; ✕ unbinds, ↺ restores the default;
conflicts are flagged). Below them, one section per pane plugin: Terminal
(default mode, cursor, scrollback, copy-on-select, bell, background, shell
and arguments), Explorer (follow the terminal, hidden files), Editor (word
wrap, tab size, line numbers), Viewer (Markdown rendered or as source),
each with its skills. Controls are shared from `src/settings/controls.tsx`,
which also renders plugins' declarative fields. Changes apply and save at once; text
fields commit on Enter or blur. `src/settings/apply.ts` applies the fonts
as CSS variables; colors (the accent included) come from the theme
(`src/theme/apply.ts`).

A custom shell (`shell`, `shellArgs`) is run as given by `pty_spawn`
(`shell_command` in `src-tauri/src/pty/shell.rs`), with the terminal
environment but **without shell integration**: no cwd reports and no
blocks. Arguments are split like a shell would for simple cases
(whitespace, `"…"` / `'…'`).

## Native menu bar

`src/commands/nativeMenu.ts` lists which commands go in which submenu
(`LAYOUT`) and sends the result to `menu_set` (`src-tauri/src/menu.rs`)
at startup and whenever commands or bindings change. Titles come from the
commands, accelerators from their first ⌘ binding (⌃ chords are left off:
a menu key equivalent takes its keys even when the command does not apply,
and ⌃G must still reach a terminal). Choosing an item emits
`menu-command`; the webview runs the command unless shortcuts are
suspended or the keyboard handler ran the same command in the last
300 ms (a key can reach both). Until the page loads, the static menu from
`menu::build` is shown. Edit (undo, copy…), minimize, fullscreen and the
app menu's About/Services/Hide/Quit are native items.
