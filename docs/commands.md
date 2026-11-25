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
- AI commands (`src/ai/commands.ts`, category AI, no default keys):
  `ai.toggleSuggestions`, `ai.suggestNow`, `ai.explainLastCommand` (AI:
  Explain the last command), `ai.fixLastCommand` (AI: Fix the last
  command), `ai.askAgent` (AI: Ask the agent…: prompts for a task in the
  palette, then runs it against the active pane in its agent card),
  `ai.openAgent` (AI: Open the agent: focuses the tab's Agent pane or
  opens one), `ai.agentNewConversation` and `ai.openSettings`. The
  explain/fix pair acts on the active block terminal's last finished
  block; see [ai.md](ai.md#explain-and-fix) and [ai.md](ai.md#agent).
  `/agent <task>` in the blocks editor is the slash command form of
  `ai.askAgent` for that terminal. The pane menu has an Agent submenu (Ask
  the agent about this pane…, Open the agent pane) and the tab menu "Open
  the agent".
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
- `hidden` commands (⌘1–⌘9 tabs, ⌥1–⌥0 panes) keep their keys but stay out
  of the native menu. ⌥ digits also drive the pane number overlay; see
  [layout.md](layout.md#pane-numbers-and--digits).
- A chord bound to two commands goes to the first enabled one.
- Shortcuts are suspended while a rename field or confirmation is open, or
  while any element with `data-owns-keyboard` is mounted (palette,
  settings dialog).

## Settings (`src/settings/`)

`schema.ts` defines `Settings`, the defaults, `migrateSettings` and
`validateSettings` (untrusted input; every field falls back to its default
on its own). The file has a `version` (`SETTINGS_VERSION`, now 4):
version 1 kept the terminal's settings at the top level, and the migration
moves them into `plugins.terminal.settings`; version 3 made the accent an
override; version 4 turned the terminal's `terminalMode` into
`defaultTerminal`. Global fields: fonts, accent, theme, key bindings,
`defaultPaneKind`, `defaultTerminal`, `ai`. Everything a plugin owns is in
`plugins[id] = { enabled, settings, skills }`, validated against the
plugin's declared fields when read. Also `env`, `secrets`, `python` and
`workspaces` (per-workspace overrides and environment; the store's fields
are the active workspace's effective settings, see
[workspaces.md](workspaces.md#settings-model)) (`src/plugins/settings.ts`; the
terminal's are in `src/terminal/settings.ts`, the editor's and viewer's in
`src/editor/settings.ts`). See [plugins.md](plugins.md#settings).
`settings.ts` is the zustand store (`useSettings`, `getSettings`),
loaded from `settings.json` in the app data directory before the first
render and saved 200 ms after each change. Dev runs with `?mockup` or
`?selftest` use defaults and save nothing.

`keybindings` maps a command id to the bindings that replace its defaults
(an empty list unbinds it).

## Settings dialog

`src/settings/SettingsDialog.tsx` (⌘, or the app menu). The picker above
the section list chooses what is edited: the defaults or one workspace
(see [workspaces.md](workspaces.md#settings-dialog)). Sections come from
a registry (`src/settings/sections.ts`; each has an icon, search
keywords and a `scope`): Workspace (only for a workspace), General (`GeneralSection.tsx`: what new terminals and new
tabs/splits open, restore all defaults), Appearance (a live preview, the
theme gallery, font family and size, the accent, file icons; see
[themes.md](themes.md#settings-and-gallery)), Environment (variables,
secrets, Python), AI (see
[ai.md](ai.md#settings--ai)), Plugins (`PluginSettings.tsx`: installed
plugins, enable/disable, import, remove) and Keyboard
(`KeyboardSection.tsx`: commands grouped by category, shortcuts as key caps;
click one and press the new keys, hover for remove and restore; conflicts
are flagged). Below them, one section per pane plugin with its settings and
skills. The search box at the top of the list narrows sections by name,
keywords, plugin descriptions and field labels; Enter opens the first.

Controls (`src/settings/controls.tsx`), also used to render plugins'
declarative fields:

- A section is a stack of `Group`s (a titled, outlined list; optional
  `help` and `actions`) holding `Row`s (label left, control right) and
  `Block`s (full-width content).
- Explanations go behind a (?) (`help`, a tooltip from
  `src/components/ui/Tooltip.tsx`). A row's `hint` line is only for live
  status (an error, a version, "Checking…"), never fixed prose.
- No native form controls: `Select` (the custom dropdown in
  `src/components/ui/Select.tsx`, a Radix Select), `Segmented` (a select
  field with up to three short options renders as one), `NumberField`
  (− / + stepper, arrow keys, clamped), `Toggle`, `CommitField`, and
  `ColorPopover` (`src/components/ui/ColorPicker.tsx`, react-colorful in a
  popover).
- `ProgramList` (`src/settings/ProgramList.tsx`, the `programs` field):
  each program a chip with a remove button and a field at the end that
  adds one (⏎ adds exactly what was typed, or the row picked with ↑/↓ or
  the mouse; ⇥ completes to the best match; comma or space also add;
  pasting several works), suggesting programs
  from the command history and well-known inline TUIs
  (`programSuggestions.ts`; nothing typed: the TUIs first, builtins like
  `cd`/`ls` hidden). ⌫ in the empty field marks the last chip, a second ⌫
  removes it (a held key never removes more than that); adding a name already there flashes its chip. It renders in
  a `StackedRow` (label line with a reset-to-default button, control full
  width below).
- Buttons: `BUTTON`, `BUTTON_PRIMARY` (one per group of buttons),
  `ICON_BUTTON`. Override a constant's utility with Tailwind's `!` suffix
  (`size-5!`): the order of two utilities for the same property is not
  defined by the class string.

Changes apply and save at once; text fields commit on Enter or blur.
`src/settings/apply.ts` applies the fonts as CSS variables; colors (the
accent included) come from the theme (`src/theme/apply.ts`).

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
