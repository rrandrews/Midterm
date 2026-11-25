# Workspaces

A workspace is a named group of tabs ([architecture.md](architecture.md#concepts))
with a badge icon and **settings of its own**: any setting a workspace may
override, plus environment variables, secrets and a Python environment for
its terminals. Everything it does not override follows the defaults.

## Title bar

`src/components/titlebar/WorkspaceSwitcher.tsx`:

- **+** creates a workspace and puts its name in an inline field, selected,
  so typing names it (Enter or a click away accepts, Escape keeps the
  generated name).
- **The switcher** (badge, name, chevron) opens the list of workspaces, each
  with its badge, and **Delete workspace** at the bottom in the theme's
  error color (`MenuItem`'s `danger`). The only workspace can't be deleted.
- **Right-click** on the switcher: Rename workspace (inline) and
  Settings…, which opens the settings dialog on this workspace's Workspace
  section. The palette command `workspace.settings` does the same for the
  active workspace.

Badges (`src/workspaces/WorkspaceBadge.tsx`) show the workspace's icon
(`Workspace.icon`, a name from `WORKSPACE_ICONS` in `src/workspaces/icons.ts`;
names are saved, so never rename one) or its name's first letter, on its
accent: the active workspace uses `--color-accent`; another uses the accent
its own settings resolve to (theme and accent override), so each workspace
keeps its color in lists.

## Settings model

`src/settings/settings.ts` (pure parts in `schema.ts`):

- `base` (the store's `base` field) is what `settings.json` holds: the
  defaults, plus `workspaces: { [workspaceId]: { overrides, env, secrets } }`.
- The store's settings fields are the **effective** settings: `base` with
  the active workspace's `overrides` laid over it (`effectiveSettings`).
  Everything that reads settings (`useSettings(selector)`, `getSettings()`,
  `useSettings.subscribe`) therefore follows the active workspace with no
  change: switching workspaces switches the theme, fonts, shell, default
  terminal and so on. `installWorkspaceSettings` (`src/workspaces/settings.ts`,
  called in `main.tsx` after the state is restored) keeps the store's
  `activeWorkspace` on the app store's.
- `settingsFor(scope)` gives any scope's effective settings, memoized per
  `base` object, so selectors may return it; `activeSettings()` is the same
  object for the active workspace (compare with it to tell whether a scope's
  settings are what is on screen).

### What a workspace can override

`OVERRIDABLE` (each key as a whole): fonts, accent, theme and the light/dark
picks, the file icon set, default pane kind and terminal, and `python`.
Also single plugin settings (`plugins.<id>.settings.<key>`, which includes
the terminal's shell, cursor, bell…) and the AI fields in `AI_OVERRIDABLE`
(suggestions, context size, default model, per-feature models).

Shared by every workspace: keyboard shortcuts, which plugins are enabled,
skill switches and the model profiles (and their keys). Their sections are
registered with `scope: "shared"`; a `Group` passed `shared` shows an
"All workspaces" tag while a workspace is edited.

Overrides are validated against `base` (`validateOverrides`): only
overridable keys, each normalized the way the setting is, and an AI
override naming a profile that does not exist is dropped. When profiles
change, every workspace's overrides are checked again.

### Writing

Store actions (`updateSettings`, `updatePluginSettings`, `updateAi`) take an
optional scope: `"default"` (`DEFAULT_SCOPE`) or a workspace id. Without one
(code outside the settings dialog, e.g. "toggle theme"), each field goes to
where its value comes from now: the active workspace if it overrides that
field, otherwise the defaults. Shared fields always go to the defaults.
`clearOverride(workspaceId, path)` drops one override; `resetSettings(scope)`
restores all defaults (keeping plugins' enabled flags, skill switches,
environment and workspaces) or, for a workspace, drops its overrides except
`python`.

Setting paths (`isOverridden`, `withoutOverride`, `Row`'s `setting`):
`fontSize`, `ai.suggestions`, `plugins.terminal.settings.shell`.

## Settings dialog

The picker at the top of the dialog's list (`ScopePicker` in
`SettingsDialog.tsx`) chooses the scope: **Default** (all workspaces) or a
workspace, with its override count. `openSettings(section, scope)`
(`src/settings/dialogState.ts`) opens it anywhere. Section, scope and
open changes go through `changeSettingsDialog`, which first asks the
shown section's leave guard, if it registered one (`guardSettingsLeave`;
the theme editor does, to ask about unsaved edits).

Sections read and write through `src/settings/scope.tsx`:
`useScopedSettings(selector)`, `useScopedActions()` and `useOverride(path)`,
under the dialog's `SettingsScopeProvider`. Outside a provider they behave
like the plain store (effective settings, writes without a scope), so the
same components work anywhere. `usePluginSettings` reads the edited scope,
so plugin field rows and plugin sections need no change; a custom plugin
section that writes with `api.settings.set` writes without a scope.

While a workspace is edited:

- A `Row` (or `StackedRow`) given `setting` shows an accent bar on its left
  and a reset button when the workspace overrides it. `FieldRows` passes
  `plugins.<pluginId>.settings.<key>` when given `pluginId`. The theme
  gallery is marked as one setting (`theme`, `themeLight`, `themeDark`).
- Sections the workspace overrides something in get an accent dot in the
  list; shared ones a globe and a note at the top.
- The title reads `<workspace> › <section>`.
- The theme editor is shared (custom themes are global), so it stays
  reachable with the note.
- Appearance's preview renders the edited scope's theme (its CSS variables
  set on the preview itself), not necessarily the one on screen.
- **Workspace** section (`src/workspaces/WorkspaceSection.tsx`, only for a
  workspace): name, icon picker, the list of overrides (each opens its
  section or goes back to the default) and a danger zone to delete it.
  General's reset becomes "Clear overrides".

Deleting a workspace (`removeWorkspaceNow` → `forgetWorkspace`) also drops
its settings and deletes its secrets from the keystore. The dialog falls
back to Default if the workspace it edits disappears.

## Environment

Settings → Environment (`src/workspaces/EnvironmentSection.tsx`), in both
scopes:

- **Variables** (`env: { name, value }[]`): literal values, no `$VAR`
  expansion. Names are `[A-Za-z_][A-Za-z0-9_]*`, not `MIDTERM_…`. A
  workspace's list adds to the defaults'; a name in both takes the
  workspace's value. The defaults' variables are listed read-only under a
  workspace's, marked when overridden, with an Override button that copies
  one into the workspace.
- **Secrets** (`secrets: string[]`, names only): values go to the OS keystore
  under `secret/<scope>/<NAME>` (`src/ipc/secrets.ts`) and never come back;
  the list shows whether each has a value (Stored / No value) and offers
  Replace and Delete. Merged like variables; a secret wins over a variable
  of the same name.
- **Python** (`python: { kind: "none" | "venv" | "conda", target }`), an
  ordinary overridable setting: none, a virtualenv folder (checked for
  `bin/activate`; `~` is expanded) or a conda environment name.

`terminalEnvironment(workspaceId)` computes what a new terminal gets;
`TerminalSession.start` (`src/terminal/session.ts`) looks it up for the
pane's workspace, warms the secrets, then calls `spawnPty`. Changes apply
to terminals started afterwards. The backend side (validation, keystore
reads, activation at the first prompt by the shell integration) is in
[terminal.md](terminal.md#workspace-environment).
