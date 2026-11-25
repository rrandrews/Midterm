# Pane plugins

Every pane kind is a **plugin**. A plugin's `id` is the pane kind stored in
layouts (`PaneData.kind`). The terminal, explorer, editor and viewer are
built in (`src/plugins/builtin/`), and so is the Agent pane (`agent`,
`src/ai/agent/plugin.tsx`, registered by `installAi`; see
[ai.md](ai.md#agent)). Imported plugins use the same contract
and run in the main window with the app's full access.

## Source map

| Path | What lives there |
|---|---|
| `src/plugins/types.ts` | The contract: `PanePlugin`, `PaneSpec`, `PaneProps`, `PaneContext`, `MenuItemSpec`, `CloseBlocker`, `Skill`, `SkillTool`. |
| `src/plugins/registry.ts` | Register, unregister, enable/disable (from settings), subscribe, activation (commands plus `activate(api)`). |
| `src/plugins/api.ts` | `MidtermApi` v1, one instance per plugin. |
| `src/plugins/PaneHost.tsx` | Renders a pane: plugin lookup, an error boundary per pane, the right-click menu, the placeholder, and the agent card of a one-off agent request (any kind of pane). |
| `src/plugins/PluginPlaceholder.tsx` | Shown for a pane whose plugin is disabled, missing or still loading. |
| `src/plugins/MenuItems.tsx` | Renders declarative `MenuItemSpec`s. |
| `src/plugins/paneMenu.ts` | `hiddenMenuItems`: which built-in pane menu items a plugin leaves out. |
| `src/plugins/paneState.ts` | `createPaneState`: per-pane state kept outside React (see below). |
| `src/plugins/panes.ts` | Default kind, data for new panes, conversions, `directoryOf`, `fileHandlers`. |
| `src/plugins/tabTitles.ts` | Automatic tab titles from the active pane's `tabTitle`. |
| `src/plugins/paneCommands.ts` | Generated commands: `pane.new.<kind>`, `pane.newTab.<kind>`, `pane.changeTo.<kind>`. |
| `src/plugins/fields.ts`, `settings.ts` | Declarative settings fields; reading a plugin's settings. |
| `src/plugins/skills.ts`, `skillFiles.ts` | Skill registry, validation, `invokeSkillTool`; `SKILL.md` parsing. |
| `src/plugins/loader.ts` | Imported plugins: listing, loading, import and remove flows. |
| `src/ipc/plugins.ts` | Backend commands for installed plugins, and `pluginFileUrl`. |
| `src-tauri/src/plugins/` | Manifest validation, import (folder or .zip), remove, the `plugin://` scheme. |
| `examples/plugins/scratchpad/` | An example plugin; also the self-test fixture. |

## The contract

```ts
type PanePlugin = {
  id: string;            // the pane kind: [a-z0-9][a-z0-9-]*
  name: string;
  version?: string; description?: string; icon?: string;
  required?: boolean;    // cannot be disabled (the classic terminal)
  terminal?: boolean;    // a terminal: offered as Settings → General → Default terminal
  pane: PaneSpec;
  commands?: Command[];  // registered while the plugin is enabled
  settings?: { fields?: SettingField[]; section?: ComponentType<{ pluginId }> };
  skills?: Skill[];
  activate?(api: MidtermApi): (() => void) | void;   // returns its cleanup
};
```

All `PaneSpec` members are optional:

| Member | Used for |
|---|---|
| `component` / `mount(el, ctx)` | Rendering. A React component gets `{ paneId, data, active, ctx }`. `mount` is framework-free: render into `el` and return a cleanup function. |
| `validateData(raw)` | Restoring saved pane data. Return the fields to keep, or `null` to start the pane afresh. |
| `createData(from?)` | Data for a new pane opened from `from`. The terminal inherits `directoryOf(from)`. |
| `convertData(previous)` | "Change pane type". Editor ↔ viewer keep `path`; classic ↔ block terminal keep `cwd` and `aiSuggestions`. Without it (or when it returns `undefined`), the pane gets `createData(pane)`. |
| `keepsStateOnChangeTo(kind)` | Whether changing a pane of this kind to `kind` keeps what it runs, so "Change pane type" does not ask like closing. The two built-in terminals say yes to each other. |
| `isDirty(paneId)` | Unsaved work right now, synchronously. `openFile` only reuses a pane for another file when this is false; a plugin with `closeBlockers` and no `isDirty` never has its panes reused. |
| `closeBlockers(paneId)` | What closing would lose: `{ type: "running" \| "unsaved" \| "other", name }`. Every close, quit and type change asks once for all of them. |
| `directory(pane)` | The directory a pane is in. Used for the palette's project root and for new terminals. |
| `explorerFollows` | Unpinned explorers follow this pane's `directory` (terminals). |
| `tabTitle(pane)` | Title of a tab whose active pane this is. Call `api.panes.refreshTitles()` when its inputs change. |
| `menu(ctx)` | Right-click items, declared as data, shown above the items every pane has. |
| `optionsMenu(ctx)` | The same for the pane's … (options) menu. |
| `hideMenuItems` | Built-in menu items to leave out of both menus: a list of `splitRight`, `splitDown`, `changeType`, `agent`, `maximize`, `moveToTab` (`HIDEABLE_PANE_MENU_ITEMS`), or `(ctx) => list`. Unknown names are ignored. **Settings…** and **Close pane** are always shown. |
| `fileHandler(path)` | `"default"`, `"option"` or `false`. `openFile` picks from the enabled plugins. |
| `reveal(paneId, path, line, column?)` | Opening a file at a line (only handlers with `reveal` are asked). |
| `splittable: false` | `openFile` avoids splitting this pane (explorers). |
| `size` | `{ minWidth?, minHeight?, maxWidth?, maxHeight? }` in pixels, for the pane's frame. Clamped by the host (`PANE_SIZE_BOUNDS` in `src/layout/paneSize.ts`): minimums to 96–800 wide and 56–600 high, maximums to at least 160 wide / 100 high and the minimum. See [layout.md](layout.md#pane-size-limits). |
| `background`, `activeBackground` | CSS background, set as `--pane-bg` / `--pane-bg-active`. The default is `--pane-default`. |
| `ownsContextMenu(paneId, event)` | Leave a right-click to the content (a terminal program reading the mouse). |

`PaneContext` gives a pane `data()`, `updateData(patch)`, `onFocusRequest(fn)`,
`registerActions(actions)` (Find, Save… forward to these), `focus()`,
`close()` and `api`.

### Pane data

`PaneData` is `{ kind: string; path?: string; [field]: unknown }`. The fields
belong to the plugin. `path` is a convention for file panes: renames on disk
update it and `openFile` matches on it. Built-ins type their own data
(`TerminalData` in `src/terminal/settings.ts`, `ExplorerData` in
`src/explorer/explorers.ts`). Their validators are in
`src/plugins/builtin/data.ts`, which has no UI imports and so can be
unit-tested.

### Restore and missing plugins

`restoreState` keeps any pane whose kind looks like a plugin id. When the
kind's plugin is registered, its `validateData` runs. Otherwise the data is
kept as saved, because imported plugins load after restore. A pane whose
plugin is missing or disabled shows the placeholder, which offers to
enable the plugin or close the pane; the pane menu can change its type.

### Per-pane state outside React

Pane components mount and unmount freely, so state that must survive is
kept by pane id:

```ts
const models = createPaneState<Model>({ kind: "my-kind", dispose: (m) => m.dispose() });
const model = models.acquire(paneId, () => new Model());  // on mount
models.release(paneId, model);                            // on unmount
```

An entry is disposed once no component holds it **and** no pane in any tab
still wants it. By default that means a pane with its id and `kind`;
`isLive(pane, value)` overrides it. The check is deferred to after the
current task. Terminal sessions, explorer models and editor/viewer models
all use this helper; plugins get it as `api.panes.createState`.

## Commands and menus

- Every pane's … menu and right-click menu end with the same built-in
  items (`src/components/layout/PaneMenuItems.tsx`): Split right, Split
  down, Change pane type, Agent, Maximize, Move to tab, then **Settings…**
  (opens the plugin's section in Settings) and **Close pane**. Above them
  come the plugin's `optionsMenu` items (… menu) or `menu` items
  (right-click). A plugin may hide any built-in item except the last two
  (`pane.hideMenuItems`); the Agent pane hides "Agent".
- `plugin.commands` are registered while the plugin is enabled.
  `CommandCategory` is any string. `command.menu` names a native menu bar
  submenu ("File", "Edit", "View", "Pane", "Window"); the command is listed
  after the app's own items there.
- `paneActionCommand({ id, title, … }, actionName, activePaneId)` makes a
  command that forwards to the active pane's registered action. A plugin
  can add its own action names (`PaneActions` is open).
- For every enabled plugin, the palette gets "New X pane",
  "New X in new tab" and "Change pane to X". Their ids are stable and their
  shortcuts can be rebound.
- The `defaultTerminal` setting (General → Default terminal) is the
  terminal new terminals open in: any enabled plugin with `terminal: true`
  (`terminalPlugins()`, `defaultTerminalKind()` in `src/plugins/panes.ts`),
  falling back to the classic terminal.
- The `defaultPaneKind` setting (General → New tabs and splits open) sets
  what ⌘T and splits open: a non-terminal plugin, or a terminal kind
  (stored as `terminal`) meaning "the default terminal". It falls back to
  the default terminal when that plugin is unavailable.
- "Open in new terminal" and other built-in ways to open a terminal use the
  default terminal. Commands sent to a new terminal (palette, `api.terminals.run`)
  use it only if it is one of the built-in terminals (`commandTerminalKind`),
  since only those have a session to type into.

## Settings

Plugin entries live in `settings.plugins[id]`:

```json
{ "enabled": false, "settings": { "wordWrap": true }, "skills": { "edit": false } }
```

- `enabled`: unset means on. A `required` plugin is always on.
- `settings`: saved raw and validated against the plugin's `fields` when
  read (`pluginSettings(id)`). An invalid value falls back to the field's
  default.
- Field types: `toggle`, `select`, `number` (min/max/integer), `text`,
  `list` (one line, shell-style quoting), `programs` (program names as
  chips with suggestions; trimmed, de-duplicated case-insensitively) and
  `color`. The host renders them
  (`FieldRows` in `src/settings/controls.tsx`). `settings.section` adds a
  custom component below them.
- The settings file has a `version` (`SETTINGS_VERSION`). `migrateSettings`
  upgrades older files; version 1's top-level terminal fields moved to
  `plugins.terminal.settings`, and version 4 turned the terminal's
  `terminalMode` setting into `defaultTerminal` (`"blocks"` →
  `block-terminal`), and version 5 turned the flat AI provider fields into
  model profiles (`ai.profiles`, `ai.defaultProfile`, `ai.features`; see
  [ai.md](ai.md#settings)). Version 6 added `env`, `secrets`, `python` and
  `workspaces` (no migration).
- A workspace can override single plugin settings
  (`workspaces[id].overrides.plugins[pluginId].settings`); `enabled` and
  `skills` are shared by every workspace. `pluginSettings` and
  `api.settings.get` read the active workspace's values; in the settings
  dialog, `usePluginSettings` reads the scope being edited. See
  [workspaces.md](workspaces.md).

The dialog's sections come from a registry (`registerSettingsSection` in
`src/settings/sections.ts`), plus one section per plugin: enable/disable,
remove (imported plugins), its fields, its custom section, a **Theme**
group for its panes ([themes.md](themes.md#pane-themes)) and its skills
with a switch each. A pane's … menu → Settings… opens it.
A section with unsaved state can register a leave guard
(`guardSettingsLeave`) that is asked before the dialog moves away from it.
Settings → Plugins lists every plugin and has Import folder…, Import .zip…,
Open plugins folder and Rescan.

## Skills

Skills describe what the AI agent ([ai.md](ai.md#agent)) can do with a
plugin. Every plugin can declare them against this stable shape:

```ts
type Skill = { id; title; description; instructions?: string; tools?: SkillTool[] };
type SkillTool = {
  name; description;
  inputSchema: JsonSchema;          // type: "object"; draft 2020-12
  effect: "read" | "write";         // write tools need the user's confirmation
  run(input, { api, paneId?, signal? }): Promise<unknown>;  // JSON-serializable result
};
```

- The registry (`src/plugins/skills.ts`) collects the skills of enabled
  plugins as `<plugin>.<skill>`.
- Declarations are checked at registration: ids, tool names, duplicates,
  and whether the schema compiles. A skill that fails is left out, and the
  reason is shown in the plugin's settings.
- `invokeSkillTool(skillId, toolName, input, { paneId?, signal?, confirm? })`
  is the single entry point. It never throws and returns
  `{ ok: true, result } | { ok: false, error }`. In order, it:
  1. checks the skill's switch;
  2. validates the input with `@cfworker/json-schema` (no `eval`, so it
     works under the CSP);
  3. before a `write` tool, asks the caller's `confirm` (same signature as
     the hook), else the hook set by `setWriteConfirmation`; with neither,
     write tools are refused. No hook is installed by default: the agent
     passes its own `confirm` per call (Allow / Allow for this
     conversation / Deny in its transcript). After a yes, the skill's
     switch is checked again (it may have been switched off meanwhile);
  4. requires the result to be plain JSON.
- The agent declares every enabled skill's tools up front, under wire names
  `<plugin>__<skill>__<tool>` (characters outside `[A-Za-z0-9_-]` become
  `_`, at most 64, a numeric suffix on collision), plus a `load_skill` tool
  that returns a skill's `instructions` (its description when it has none)
  and its tools' names. Guidance-only skills are loadable too. A skill
  switched off or a plugin disabled during a conversation is refused by
  `invokeSkillTool`; the declared tools only change with a new
  conversation.
- A Claude Code profile ([ai.md](ai.md#acp-sessions)) gets the same tools
  as **MCP tools**: the backend serves them to the CLI as the MCP server
  `midterm` over the ACP connection (the CLI shows them as
  `mcp__midterm__<wire name>`), with names capped at 64 characters. Each
  call runs through `invokeSkillTool` like any other, so the same
  validation and confirmations apply.
- `paneId` is the pane the agent works with (a card's pane, or the tab's
  last active non-agent pane for the Agent pane); tools should act on it
  when the model names no pane.
- In dev builds it is also available as `window.__midterm.invokeSkillTool`.
- Built-in skills:
  - `terminal.commands`: `recent_blocks`, `run_command` (write; only in
    the terminal named or the agent's own pane, never a fallback, and
    refuses commands with control characters other than line breaks and
    tabs)
  - `explorer.files`: `list_directory`, `reveal`
  - `editor.edit`: `open_file`, `read_open_file`, `save` (write)
  - `viewer.view`: `open_file`

### Writing a skill

Keep `description` short and about *when* to use the skill. A model reads
it to choose among skills. Put the how-to in `instructions` (Markdown),
which is only loaded once the skill is picked. Give each tool a tight
schema (`additionalProperties: false`, required fields, ranges), return
small results (clip long text), and mark anything that changes files,
runs commands or sends data as `write`.

An imported plugin can also ship guidance-only skills as files, listed in
the manifest's `skills`:

```markdown
<!-- skills/notes/SKILL.md -->
---
title: Scratchpad notes
description: When the user keeps notes in a Scratchpad pane, read them for context.
---
Instructions in Markdown…
```

The skill id is the folder name. These skills are known before the
module loads.

## Imported plugins

A plugin is a folder with a manifest and an ES module:

```json
{
  "id": "scratchpad", "name": "Scratchpad", "version": "1.0.0", "apiVersion": 1,
  "main": "main.js", "style": "style.css",
  "skills": ["skills/notes/SKILL.md"],
  "description": "…", "author": "…"
}
```

- Paths are plain relative paths (no `./`, `..` or absolute paths) and must
  exist.
- The id may not be a built-in one (`terminal`, `block-terminal`,
  `explorer`, `editor`, `viewer`, `theme-editor`, `agent`, `antigravity`,
  `claude-code`, `midterm`; `RESERVED_IDS` in `src-tauri/src/plugins/manifest.rs`).
- `apiVersion` must be `1`.
- The module's default export is the `PanePlugin`. Its `id` must match the
  manifest's.

**Install.** Settings → Plugins → Import shows a trust warning, then a
folder or .zip picker. The backend validates the manifest, stages the files
and renames them into `<app data>/plugins/<id>/` (an existing id asks to
replace). Zip imports reject unsafe paths and symlinks, and are capped at
10,000 entries and 64 MiB. For plugin development, a symlinked folder in
the plugins folder works too.

**Load.** After the first render, `loadImportedPlugins` lists the installed
plugins and loads each enabled one:

- The module is loaded with `import("plugin://localhost/<id>@N/<main>")`
  (on Windows `http://plugin.localhost/…`). `N` changes on every load and
  versions the whole folder, so a replaced plugin's new code runs, relative
  imports included. A load that a newer load or a removal overtakes is
  dropped.
- The stylesheet is added as a `<link>`.
- The stylesheet is attached only while the plugin is enabled.
- A disabled plugin is registered as a **stub** from its manifest, and its
  code is not run until it is enabled. Stubs (disabled, loading or failed)
  are listed in the settings but never offered for new panes; the default
  pane kind falls back to the terminal.
- Enabling a plugin, or Rescan, loads its code again.
- A plugin's commands may not reuse an existing command id (they are
  ignored with a warning).
- A module that fails to load, or exports something invalid, is reported
  in Settings → Plugins and on its panes' placeholders. Every call into a
  plugin (menus, titles, close checks…) is guarded, and each pane has an
  error boundary.

**The scheme.** `src-tauri/src/plugins/protocol.rs` serves only files
inside installed plugin folders (canonicalized, no traversal), with a
JavaScript MIME type, `Access-Control-Allow-Origin: *` (module scripts are
fetched in CORS mode) and `Cache-Control: no-store`. The CSP allows
`plugin:` and `http://plugin.localhost` in `script-src`, `style-src`,
`img-src` and `font-src` only (see
[architecture.md](architecture.md#content-security-policy)).

**What a plugin can use.** Everything goes through `MidtermApi` v1 (`ctx.api`
or `activate(api)`):

| Group | Members |
|---|---|
| `react` | The host's React, JSX runtime and `createRoot`, for plugins that render with the host's React. Bundle against them; don't ship a second React. |
| `panes` | `active`, `get`, `list`, `open`, `updateData`, `changeKind`, `close`, `focus`, `directory`, `markActivity`, `refreshTitles`, `subscribe`, `createState` |
| `commands` | `register`, `run` |
| `settings` | This plugin's `get`, `set`, `subscribe` |
| `storage` | A JSON file of the plugin's own (`plugin-<id>.json`) |
| `files` | `open`, `readText`, `writeText`, `list`, `stat`, `home` |
| `terminals` | `cwd`, `run` (a command in a new terminal) |
| `theme` | `token(name)` (a CSS variable's value), `onChange` |
| `ui` | `confirm`, `MenuItems` |

Theme tokens are CSS variables (`var(--color-fg)` and so on; see
[design-tokens.md](design-tokens.md)), so a plugin's CSS follows the theme.

### Writing one

1. Copy `examples/plugins/scratchpad/`, change the id and name, and edit
   `main.js`.
2. Import the folder from Settings → Plugins, or symlink it into the plugins
   folder and press Rescan.
3. After changing the code, press Rescan (or toggle the plugin off and on)
   to reload it.

The example uses `mount` and plain DOM. To use React, take
`api.react.React` and `api.react.jsxRuntime` and set `pane.component`. A
bundler should treat `react` as external and map it to those.

### Later

- Sandboxed (iframe) plugins with permissions.
- Plugin updates and an index.
- Contributions other than panes.

These are tracked in Linear (project "Plugin Platform v2"; see [planning.md](planning.md)).
