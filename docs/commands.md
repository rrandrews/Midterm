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
- Registered elsewhere: `editor.revert` (`src/editor/commands.ts`).
- The functions commands run stay in `src/actions.ts` (and `closing.ts`).
  Add the function there, then register a command for it. Pane kinds
  register their own commands from their own modules.
- `enabled()`: a disabled command does not take its keys, so they reach
  the focused element (e.g. ⌃G reaches a terminal when no editor is
  active) and it is left out of the palette.
- **Pane actions**: commands like Find, Save and Go to line act on the
  active pane. Pane content registers what it supports with
  `registerPaneActions(paneId, { find, save, … })` while mounted; the
  command forwards to the active pane's action and is enabled only when
  there is one.
- A chord bound to two commands goes to the first enabled one.
- Shortcuts are suspended while a rename field or confirmation is open, or
  while any element with `data-owns-keyboard` is mounted (palette,
  settings dialog).

## Settings (`src/settings/`)

`schema.ts` defines `Settings`, the defaults and `validateSettings`
(untrusted input; every field falls back to its default on its own).
`settings.ts` is the zustand store (`useSettings`, `getSettings`),
loaded from `settings.json` in the app data directory before the first
render and saved 200 ms after each change. Dev runs with `?mockup` or
`?selftest` use defaults and save nothing.

`keybindings` maps a command id to the bindings that replace its defaults
(an empty list unbinds it).

## Settings dialog

`src/settings/SettingsDialog.tsx` (⌘, or the app menu): General (accent,
font family and size), Terminal (default mode, cursor, scrollback,
copy-on-select, bell, background, shell and arguments) and Keyboard
(click a shortcut and press the new keys; ✕ unbinds, ↺ restores the
default; conflicts are flagged). Changes apply and save at once; text
fields commit on Enter or blur. `src/settings/apply.ts` applies the
accent by overriding `--color-accent` (and the derived `--color-accent-fg`)
on `<html>`.

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
