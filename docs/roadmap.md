# Roadmap

Milestones are ordered; each builds on the ones before it. Check items off as
they land, and delete a milestone's section once all of it is done.

Done so far:

- M1: app shell matching the mockup, workspaces and tabs, nested split
  layout with resize and drag-to-dock, pane menu and shortcuts, PTY-backed
  classic terminals. See [architecture.md](architecture.md).
- M2: saved and restored workspaces, tabs, layouts and window state; shell
  integration (OSC 7) for zsh, bash and fish; terminals reopen in their
  directory; automatic tab titles; tab reordering, pane-to-tab drops, tab
  overflow; maximize pane; confirmation before closing running programs.
  See [terminal.md](terminal.md) and [layout.md](layout.md).
- M3: file explorer pane: live tree with watching, .gitignore, hidden-file
  toggle, keyboard navigation and type-ahead, root following the focused
  terminal (pinnable), git badges, context menu, opening files into
  editor/viewer panes. Right-click menus across the app. See
  [explorer.md](explorer.md).
- M4: editor panes (CodeMirror 6, language detection, token theme,
  breadcrumbs, dirty state, save with conflict check, external change
  detection, find and go to line) and viewer panes (sanitized Markdown,
  images, read-only text); unsaved changes prompt on close; clickable
  `path:line` in terminal output. See [editor.md](editor.md).
- M5: command palette (⌘K, ⌘P files, ⇧⌘P commands): commands from a
  registry with rebindable shortcuts, tabs and workspaces by name, fuzzy
  file open in the project root, run a shell command in a new pane,
  recent items first. See [palette.md](palette.md) and
  [commands.md](commands.md).
- M6: blocks terminal mode: OSC 133 marks from zsh, bash and fish; output
  cut into blocks with cwd, branch, exit status and duration; input editor
  with history and autosuggestions; classic fallback for full-screen
  programs and shells without integration; per-pane toggle with the
  default in settings; copy command/output and re-run. See
  [terminal.md](terminal.md#blocks-mode).
- M7: settings dialog (fonts, cursor, scrollback, shell, terminal mode,
  copy on select, bell, background) applied live; accent presets and
  custom color; rebindable shortcuts; native menu bar generated from the
  command registry; find in terminal scrollback; a Content Security
  Policy. Transparent terminal backgrounds stay the default, with a solid
  option. See [commands.md](commands.md) and
  [architecture.md](architecture.md#content-security-policy).

## Decisions for M8–M10

Settled before planning; do not reopen without a reason.

- **Order: plugins, then themes, then AI.** Themes and AI build on what the
  plugin milestone adds: a settings dialog driven by a section registry,
  namespaced settings with a migration path, and panes as plugins (the theme
  editor is one).
- **Imported plugins run in-process and are trusted**: a folder with a
  manifest and an ES module, loaded into the main window with the app's full
  access, behind a trust warning on import. Sandboxed plugins are a later item.
- **AI suggestions are blocks mode only** at first. Classic mode is a later item.
- **AI requests are made by the Rust backend**, with keys in the OS keychain.
  Keys never reach the webview, and the webview's CSP stays "nothing remote".
- **Themes import** iTerm2 `.itermcolors`, VS Code theme JSON and
  Base16/Base24 YAML, besides Midterm's own JSON.
- One branch per milestone, reviewed with the codex plugin before merging.
  Check a new dependency's recent releases and adoption before adding it
  (versions seen in November 2026 are noted per milestone).

## M8 — Pane plugins

Every pane kind becomes a plugin registered through one contract; imported
plugins use the same contract. To be documented in `docs/plugins.md`.

**Where the coupling is today.** Pane kinds are a closed union (`PANE_KINDS`
in `src/state/types.ts`) switched on in about 30 places:

- `PaneContent.tsx`: kind → component, and kind → right-click items (`KindMenuItems`)
- `actions.ts`: `newTab`, `splitPane` and `openTerminalAt` always create a terminal; `cwdFrom`; `openFile` / `kindsFor`; `addPaneBeside`'s explorer exception; `setPaneKind` keeps all old data fields (editor ↔ viewer relies on `path` surviving)
- `closing.ts`: running-program and unsaved-file checks
- `state/persist.ts`: unknown kinds are dropped, and one kind-blind function validates every field
- `state/layout.ts` and `state/store.ts`: `PANE_LABELS`; a new or fallback tab is a terminal titled "shell"
- `palette/sources.ts` (`directoryOfPane`), `palette/state.ts` (`runInNewTerminal`)
- three near-identical per-pane registries (a Map by pane id plus a `setTimeout(0)` reconcile against the store): `terminal/sessions.ts`, `explorer/explorers.ts`, `editor/registry.ts`. `sessions.ts` also owns automatic tab titles and background activity; `explorers.ts` reads terminals through `peekSession`
- closed unions: `PaneActions` and `CommandCategory` (`commands/registry.ts`), `Section` (`SettingsDialog.tsx`), the native menu `LAYOUT` (`commands/nativeMenu.ts`)
- commands registered by side-effect imports (`editor/commands.ts` via `FilePane.tsx`, `terminal/blockMode.ts`)
- per-kind CSS: `.pane-<kind>` in `styles/dock.css`, `--pane-<kind>` in `styles/index.css`
- `ExplorerPane.tsx` renders its own nested context menu that repeats `PaneMenuItems`; `FilePane.tsx` serves both editor and viewer and picks its view by model class

**Design.** A plugin is an object registered with `src/plugins/registry.ts`;
its `id` is the pane kind saved in layouts. Built-in panes are plugins that
ship in the bundle; imported ones are a folder (`manifest.json` plus an ES
module) in `<app data>/plugins/<id>/`.

```ts
type PanePlugin = {
  id: string; name: string; version?: string; icon?: IconSpec; required?: boolean;
  pane: {
    component?: React.ComponentType<PaneProps>;            // built-ins / plugins using the host's React
    mount?(el: HTMLElement, ctx: PaneContext): () => void;  // stable public contract, any framework
    validateData?(raw: unknown): PaneData | null;           // restore
    createData?(from?: PaneNode): PaneData;                 // new pane beside `from` (e.g. inherit cwd)
    convertData?(previous: PaneNode["data"]): PaneData;     // "change pane type" (editor ↔ viewer keep path)
    closeBlockers?(paneId: string): Promise<string[]>;      // running program, unsaved file
    directory?(pane: PaneNode): string | undefined;         // palette root, explorer following
    tabTitle?(pane: PaneNode): string | undefined;
    menu?(ctx: PaneContext): MenuItemSpec[];                 // right-click items, declarative
    fileHandler?(path: string): "default" | "option" | false;
  };
  commands?: Command[];
  settings?: { fields: SettingField[]; section?: React.ComponentType };  // declarative, or custom
  skills?: Skill[];                                          // for a future AI agent; see "Skills"
  activate?(api: MidtermApi): () => void;                    // subscriptions; replaces side-effect imports
};

/** Something an AI agent can learn to do with this plugin: guidance, callable tools, or both. */
type Skill = {
  id: string; title: string;
  description: string;                 // when to use it; what the model reads to pick a skill
  instructions?: string;               // Markdown guidance, loaded only once the skill is picked
  tools?: SkillTool[];
};
type SkillTool = {
  name: string; description: string;
  inputSchema: JsonSchema;                                   // validated by the host before `run`
  effect: "read" | "write";                                  // "write" will need the user's confirmation
  run(input: unknown, ctx: SkillContext): Promise<unknown>;  // JSON-serializable result
};
```

Core:

- [ ] `src/plugins/`: `PanePlugin` contract, registry (register, enable, disable, subscribe), versioned `MidtermApi`
- [ ] `PaneKind` becomes `string`; pane data is validated by the owning plugin. Restore **keeps** panes whose plugin is missing or disabled (today they are dropped) and shows a placeholder: enable plugin / change type / close
- [ ] `PaneContent` becomes a host: registry lookup, an error boundary per pane, the placeholder
- [ ] One shared pane-state helper (state keyed by pane id, disposed when the pane is gone) replacing the three registries' Map + reconcile loops; offered to plugins through the API
- [ ] Port terminal, explorer, editor and viewer to plugins (`src/plugins/builtin/`); split `FilePane` into its editor and viewer halves
- [ ] Move kind-specific logic behind the contract: right-click items, close checks, directory lookup, tab titles and activity, explorer-follows-terminal (via `directory`, not `peekSession`), file opening (`fileHandler`), pane backgrounds (a plugin-declared token with a default)
- [ ] Open the closed unions: `PaneActions`, `CommandCategory`, the settings `Section`, the native menu `LAYOUT` (commands declare their menu placement)
- [ ] Terminal stops being hard-coded as the default: a `defaultPaneKind` setting drives split and new tab. The terminal plugin is `required` (cannot be disabled)

Commands:

- [ ] Palette commands for every enabled pane plugin, generated from the registry: "New Terminal / Explorer / Editor / Viewer Pane" (beside the active pane), "… in New Tab" and "Change Pane to …". Rebindable; they appear and disappear as plugins are enabled, imported or removed

Settings:

- [ ] Settings get a `version` and a migration (there is none today; `settings.ts` relies on per-field validation). Plugin settings are namespaced: `plugins[id] = { enabled, settings, skills }`. The terminal's fields move out of the top level; fonts stay global
- [ ] Settings dialog driven by a section registry; `Row` / `Select` / `Toggle` / `CommitField` extracted to `src/settings/controls.tsx`; declarative fields (toggle, select, number, text, list, color) rendered and validated by the host
- [ ] Plugins section: installed plugins with version and source, enable/disable, Import…, Remove (imported ones), reveal folder, load errors
- [ ] One tab per plugin: enable/disable (and remove) at the top, then its settings. New settings so no tab is empty: explorer (hidden files and follow-terminal defaults), editor (word wrap, tab size, line numbers), viewer (open Markdown rendered or as source)

Skills (defined now, used by an agent later). Nothing calls a skill in this
milestone; plugins declare them against a stable shape so an agent added
later can use every installed plugin without plugin changes:

- [ ] `Skill` / `SkillTool` types in the plugin contract; a skill registry (`src/plugins/skills.ts`) collecting the skills of enabled plugins, with namespaced ids (`<plugin>.<skill>`), subscribe and lookup
- [ ] Host-side validation: ids and names; the JSON Schema of each tool's input (checked at registration, inputs checked before `run`); results must be JSON-serializable; a failing tool returns an error instead of throwing into the host
- [ ] Imported plugins can also ship skills as files: `skills/<id>/SKILL.md` (front matter `title`, `description`; body = instructions) listed in the manifest, so guidance-only skills need no code and can be shown before the module loads
- [ ] Built-in plugins define a first set, which also proves the shape: terminal (read recent blocks; run a command, `write`), explorer (list a directory; reveal a path), editor (open a file at a line; read the open file; save, `write`), viewer (open a file)
- [ ] Each plugin's settings tab lists its skills (title, description, tools with their `read` / `write` effect) with an on/off switch per skill
- [ ] `invokeSkillTool(id, tool, input)` as the single entry point a future agent will use (validation, the per-skill switch, a confirmation hook for `write` tools); exposed on `window.__midterm` in dev builds

Imported plugins:

- [ ] Spike first: `import()` of a module served by a custom `plugin://` URI scheme in WKWebView under the CSP (needs a JavaScript MIME type and CORS headers; the URL is `http://plugin.localhost/…` on Windows). Fallback if it fails: read the file through IPC and import a `blob:` URL (single-file bundles only, and `blob:` in `script-src`)
- [ ] Backend `src-tauri/src/plugins/`: `plugins_list`, `plugins_import` (folder or `.zip`; validates manifest, id and `apiVersion`; no path traversal), `plugins_remove`; the `plugin://` handler serves installed plugin files only
- [ ] Manifest: `id`, `name`, `version`, `apiVersion`, `main`, `style?`, `skills?`, `description`, `author`
- [ ] Loader: enabled plugins load after startup; a failing plugin is isolated and reported; enable/disable without restart; importing shows a trust warning
- [ ] `MidtermApi` v1: panes, commands, plugin-scoped settings and storage, files, terminals (cwd, run a command), theme tokens, menus and confirm, the host's React for plugins that want it (nothing is exposed on `window` in production today)
- [ ] CSP: the plugin scheme added to `script-src`, `style-src`, `img-src` and `font-src`; nothing else loosened
- [ ] Example plugin in `examples/plugins/` (also the self-test fixture)

Tests and docs:

- [ ] Unit tests: registry, skills (validation, switches, error containment), restore with unknown and disabled kinds, settings migration, manifest validation (Rust)
- [ ] Self-test: import the example plugin, open its pane from the palette, disable it, see the placeholder
- [ ] `docs/plugins.md` (architecture and authoring guide, including writing a skill); update `architecture.md`, `commands.md` (it says only `editor.revert` is registered outside `core.ts`, which is already out of date) and `layout.md`

New dependencies: `tauri-plugin-dialog` 2.8 (file pickers, also used by
themes), `zip` 9.

## M9 — Themes and theme editor

To be documented in `docs/themes.md`.

**Where colors live today.** Three sources kept in step by comments: the CSS
tokens (`@theme` in `src/styles/index.css`), the xterm palette
(`src/terminal/theme.ts`, hard-coded hex) and the window background
(`tauri.conf.json`). Only the accent is user-changeable
(`src/settings/apply.ts` sets `--color-accent` and `--color-accent-fg`). The
app is dark only. Tailwind 4's plain `@theme` block means utilities resolve
to `var(--color-*)`, so overriding variables at runtime works.

**Design.** A theme is a small base palette (background, foreground, accent,
16 ANSI colors, light or dark) plus optional overrides; `resolveTheme()`
derives every token. That one resolved theme feeds the CSS variables, xterm,
blocks rendering, CodeMirror and the window. The gallery lives in
Settings → Appearance; the editor opens as a **pane** (a built-in plugin) so
changes preview on real terminals and files instead of under a modal.

- [ ] `src/theme/`: theme type, validation, `resolveTheme` (color math with `culori`), unit tests
- [ ] Token audit so light themes work: replace hard-coded colors with tokens (white and black alpha overlays in `editor.css`, `explorer.css`, `Menu.tsx`, `ConfirmDialog.tsx`, `Palette.tsx`, `SettingsDialog.tsx`, `WorkspaceSwitcher.tsx`, `FilePane.tsx`; the hex inside `--shadow-menu`; `--terminal-solid` and `SOLID_BACKGROUND`; the palette in `terminal/theme.ts`; the fallbacks in `blockRender.ts`; the find decorations in `session.ts`); add hover, selected and scrim tokens
- [ ] `applyTheme`: CSS variables on `<html>`, `color-scheme`, xterm themes of live sessions, blocks re-render (finished blocks keep stale colors today: `FinishedBlock`'s memo in `BlocksView.tsx` does not depend on the theme), CodeMirror's light/dark flag (`EditorView.theme({}, { dark })` in `editor/model.ts`), native window theme and background (window permissions in `capabilities/default.json`), no flash at startup
- [ ] Settings: `theme`; optional follow-system with a light and a dark pick; the accent becomes an optional override of the theme's accent (a custom accent set today is kept). Custom themes saved in `themes.json`
- [ ] Bundled themes (about 16) with attribution: Midterm Dark (today's look), Midterm Light, Dracula, Nord, Solarized Dark and Light, Gruvbox Dark and Light, Tokyo Night, Catppuccin Mocha and Latte, One Dark, GitHub Dark and Light, Rosé Pine, Monokai
- [ ] Appearance section: gallery with preview swatches, apply on click, follow system, duplicate / rename / delete / export, Import…
- [ ] Theme editor pane: tokens grouped (base, surfaces, text, lines, status, syntax, terminal ANSI, pane backgrounds per plugin); color picker with hex and alpha (`react-colorful`); derived versus overridden with reset; search; undo and redo; edits apply live with save / discard; a sample strip (ANSI table, code, UI states); WCAG contrast warnings
- [ ] Import and export: Midterm JSON both ways. Importers, each pure and fixture-tested: iTerm2 `.itermcolors` (XML plist, `DOMParser`), VS Code theme JSON (`jsonc-parser`), Base16/Base24 YAML (`yaml`)
- [ ] Palette: "Theme: Select…" with live preview while moving through the list, "Theme: Edit Current", "Theme: Toggle Light/Dark"
- [ ] Plugin API: theme tokens documented as stable CSS variables, a pane background token per plugin, `onThemeChange`
- [ ] Self-test: switching theme updates a CSS variable and a live terminal's palette
- [ ] `docs/themes.md`; update `design-tokens.md` (`--color-line-strong` is missing from it)

New dependencies: `culori` 4, `react-colorful` 5.8, `yaml` 2.9,
`jsonc-parser` 3.3.

## M10 — AI providers and next-command suggestions

To be documented in `docs/ai.md`.

**What exists today.** No network code, no secret storage and no child
processes besides the PTY (no `std::process::Command` in production code;
tokio's `process` and `net` features are not compiled in). The app process
never resolves the login shell's PATH. Blocks mode has ghost-text history
suggestions in `BlockInput.tsx` (`suggested`, `ghost`, `accept`; ⇥ or →
accepts), which today suggest nothing at an empty prompt. `BlockInput`
remounts at every prompt. OSC 133 tracking runs in classic mode too.
`blockOutput(session, block)` in `src/terminal/blockMode.ts` returns a
block's plain text; `session.blocks.subscribe` reports a finished command
and the return to the prompt.

**Design.** The suggestion setting is **on by default but inert until a
provider and model are chosen**; nothing is sent before that. A suggestion is
only ever placed in the input editor, never run.

Backend (`src-tauri/src/ai/`; done, see [ai.md](ai.md)):

- [x] HTTP with `reqwest` (rustls). Two adapters: OpenAI-compatible chat completions (OpenAI, DeepSeek, OpenRouter, Gemini's OpenAI-compatible endpoint, a custom base URL) and Anthropic Messages (raw HTTP, as there is no official Rust SDK; do not route Anthropic through an OpenAI-compatible shim). Check request shapes against each provider's current docs when implementing: send no sampling parameters (current Claude models reject `temperature`), keep effort low, leave room in `max_tokens` for thinking, handle refusals and empty replies
- [x] Commands: `ai_suggest`, `ai_cancel`, `ai_models` (the provider's live model list, free text as a fallback; no model ids hard-coded), `ai_test`, `ai_key_set` / `ai_key_delete` / `ai_key_status`
- [x] Keys in the OS keychain (`keyring`): never in `settings.json`, write-only in the UI
- [x] CLI providers: Claude Code (`claude -p`), Codex (`codex exec`), Antigravity (`agy -p`). Found through the login shell's PATH (an app started from Finder has none; a login shell's output can carry OSC sequences from shell integration, so bracket the value with markers), with a path override; run headless with tools off or read-only, a neutral working directory, a timeout, and kill on cancel. `agy -p` printed nothing without a TTY in some versions (upstream issue 76), so run it under a PTY if that still holds. Verify flags against the installed versions

Frontend (`src/ai/`):

- [ ] Settings: `ai.suggestions.enabled` (default on), provider, model, context size; provider list; IPC wrapper with a browser mock (every `src/ipc` wrapper branches on `isTauri()`)
- [ ] Context builder (pure, unit-tested): OS, shell, cwd, git branch, the last N blocks (command, exit code, output head and tail, capped), recent commands; redaction of likely secrets (tokens, keys, `*_SECRET=` assignments)
- [ ] Suggestion engine keyed by pane, outside React: asks when a command finishes and the prompt is empty, focused pane only, debounced; cancelled by typing, running or closing; one request in flight per pane; backs off on errors
- [ ] Blocks input: AI ghost text at an empty prompt; ⇥ or → accepts into the editor; once the user types, history suggestions win unless the AI suggestion continues what was typed; Esc dismisses; the footer shows the source and a quiet loading or error state
- [ ] Commands: toggle suggestions, suggest now, open AI settings; a per-pane off switch in the terminal menu
- [ ] Settings → AI: on/off, provider (APIs and CLIs, each with its status: key set, or CLI found and its version), key field, model picker, base URL for custom, context size, Test, and "Preview what is sent" for the current terminal; a first-use note on what leaves the machine
- [ ] Tests: adapters against a local stub server (Rust); self-test end to end through the custom endpoint pointed at a stub
- [ ] `docs/ai.md`; update `architecture.md` (the backend makes outbound requests; the webview's CSP is unchanged)

New dependencies: `reqwest` 0.13, `keyring` 4.

## M11 — Cross-platform and packaging

- [ ] Linux and Windows window chrome (no traffic lights; custom controls on the right)
- [ ] Ctrl-based shortcut set that does not collide with terminal input
- [ ] Windows shells (PowerShell, cmd, WSL) and ConPTY verification
- [ ] Keychain backends, the `plugin://` scheme and AI CLI discovery verified on Linux and Windows
- [ ] App icon and name in bundles
- [ ] Code signing and notarization (macOS)
- [ ] Auto-update
- [ ] CI: typecheck, vitest, cargo test, clippy, build on all three platforms

## Later / unscheduled

Terminals and shells:

- [ ] Shell integration follow-ups: run the fish script and test on a machine with fish; bash 5.1+ and Linux paths are untested; Debian reads `/etc/bash.bashrc` twice (once itself, once via `/etc/profile`); an `/etc/zshenv` that sets `ZDOTDIR` skips integration; a `.zshrc` that assigns `precmd_functions=(…)` drops our hook
- [ ] Shells inherit the launching terminal's environment in dev (e.g. another terminal's `ZDOTDIR`, which swaps in its history file and integration)
- [ ] Busy check misses programs started with `exec` (same pid as the shell)
- [ ] Blocks mode: no tab completion or ⌃R search in the input editor (switch to classic); a line already typed into the shell's own prompt in classic mode is not cleared before the editor sends one; RPROMPT text can end up in a command read back from the prompt (typed in classic mode); output printed before the first prompt (and between a command's end and the next prompt) is only visible in classic mode; a full buffer that is erased (`ESC [ 2 J`) re-anchors the running block at the top of the scrollback; the cursor is drawn even when a program hides it; block cursor in the editor is the browser caret, not a block
- [ ] Blocks mode: per-block virtualisation (blocks use `content-visibility` and cap their DOM at 300 lines plus "Show earlier lines"), `git status` per prompt is computed in full just to get the branch, no "ahead" count in the status line
- [ ] OSC 133 follow-ups: bash marks a command line that is only a subshell (`(exit 3)`) with no C/D (DEBUG trap; PS0 on bash 4.4+ untested); a DEBUG trap installed after startup (bash-preexec) replaces ours; fish 4 may print its own 133 marks (the frontend tolerates duplicates, but `fish_emits_prompt_marks` expects exactly ours and is untested on fish 4: use fish's native marks where available); a `fish_prompt` defined after the first prompt loses B

Explorer:

- [ ] Multi-select, drag and drop (move files, drop a path into a terminal), remember scroll position across remounts
- [ ] Git status goes stale in linked worktrees (`.git` is a file, so nothing is watched)
- [ ] A watched symlinked directory keeps watching its old target if retargeted
- [ ] Move to Trash acts on the path, so a file swapped in while the dialog is open is the one trashed

Editor and viewer:

- [ ] A "Save" button in the close prompt (it only offers discard or cancel), and save-all
- [ ] Text in other encodings (Latin-1, UTF-16) opens as "binary"; files over 16 MiB do not open
- [ ] Save's conflict check and write are two steps; a change by another program landing in between is overwritten
- [ ] A file opened through a symlink is watched via the link's directory only, so changes to a target elsewhere go unnoticed until the pane is remounted
- [ ] Atomic saves replace the file, which breaks hard links and drops extended attributes/ACLs
- [ ] Syntax highlighting of code blocks in rendered Markdown; find in rendered Markdown
- [ ] Clickable breadcrumb segments (reveal in the explorer); show the file in the tab title or dirty marker on the tab
- [ ] Terminal links: `a/`/`b/` prefixes in `git diff` output, directories (open in the explorer), paths with spaces

Layout:

- [ ] Stack several panes in one frame as tabs (currently rejected; see [layout.md](layout.md))
- [ ] Floating panes and pop-out windows (supported by the layout library)

Plugins:

- [ ] Sandboxed (iframe) plugins with per-plugin permissions, for code that should not be trusted with the whole app
- [ ] Plugin updates and a plugin index
- [ ] Contributions other than panes: status items, palette sources, themes

Themes:

- [ ] Per-workspace or per-pane themes
- [ ] Import of Ghostty, kitty and Alacritty color schemes

AI:

- [ ] An agent that uses plugin skills (tool calls through `invokeSkillTool`, confirmation for `write` tools)
- [ ] Suggestions in classic mode (an overlay at the xterm cursor, and an accept key that does not collide with the shell)
- [ ] Streaming replies; "explain this error" and "fix the last command" on a block
- [ ] AI exposed to plugins through the plugin API
