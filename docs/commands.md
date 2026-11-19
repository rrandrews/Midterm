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
