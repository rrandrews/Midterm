# Architecture

Midterm is a Tauri 2 app: a Rust backend (`src-tauri/`) that owns PTYs, and a
React 19 frontend (`src/`) that owns everything on screen.

Other docs: [layout.md](layout.md) · [terminal.md](terminal.md) ·
[explorer.md](explorer.md) · [editor.md](editor.md) · [commands.md](commands.md) · [palette.md](palette.md) ·
[ai.md](ai.md) · [design-tokens.md](design-tokens.md) · [plugins.md](plugins.md) · [themes.md](themes.md) · [planning.md](planning.md)

## Concepts

```
workspace ─┬─ tab ─┬─ pane (terminal | explorer | editor | viewer | an imported plugin's kind)
           │       └─ pane …      arranged in a nested split layout
           └─ tab …
```

- A **workspace** is a named group of tabs. One is active at a time.
- A **tab** holds any number of **panes** in a nested split layout.
- A **pane** has a kind: `terminal`, `explorer`, `editor` (CodeMirror)
  or `viewer` (rendered Markdown, images, read-only text). See
  [editor.md](editor.md) for the last two.

## Source map

| Path | What lives there |
|---|---|
| `src/state/` | Types, pure layout helpers, the zustand store, saving/restoring it. Unit-tested. |
| `src/actions.ts` | User-level actions (split, close, new tab…). Commands, menus and shortcuts call these. |
| `src/commands/` | Command registry: ids, titles, key bindings; see [commands.md](commands.md). |
| `src/shortcuts.ts` | Window-level shortcut handler, driven by the registry. |
| `src/palette/` | Command palette; see [palette.md](palette.md). |
| `src/settings/` | User settings: schema, validation, persisted store. |
| `src/layout/dock.ts` | Bridge to the mounted pane layout: imperative handles by tab id, pane focus. |
| `src/components/titlebar/` | Title bar = tab bar: workspace switcher, tabs, app menu. |
| `src/components/layout/` | `PaneLayout` (the split layout) and `PaneToolbar` (hover controls + menu). |
| `src/plugins/` | The pane plugin contract, registry, API, pane host, skills and the imported-plugin loader; built-in plugins in `builtin/`. See [plugins.md](plugins.md). |
| `src/ai/` | AI next-command suggestions: context builder and redaction, the suggestion engine, Settings → AI, commands. Requests go through the backend (`src/ipc/ai.ts`); the webview's CSP still allows nothing remote. See [ai.md](ai.md). |
| `src/theme/` | Themes: model, resolution, bundled themes, importers, applying the theme, the Appearance section and the theme editor pane. See [themes.md](themes.md). |
| `src/components/panes/` | The built-in panes' components. |
| `src/components/ui/` | Menus (dropdown and right-click), inline edit, confirm dialog, icons. |
| `src/terminal/` | xterm.js sessions and their registry; blocks mode model, rendering and history ([terminal.md](terminal.md)); file links in output. |
| `src/explorer/` | File explorer models, their registry, pure tree helpers. |
| `src/editor/` | Editor models (CodeMirror), the registry of editor and viewer models, language detection, highlighting, pure text helpers. |
| `src/viewer/` | Viewer model (Markdown, images), Markdown rendering, link resolution. |
| `src/files/` | Shared by editors and viewers: file watching, repository root lookup, file kinds. |
| `src/ipc/` | Typed wrappers over Tauri commands. The only place that calls `invoke`. |
| `src/styles/` | Tailwind entry + design tokens, and CSS for the layout and terminal. |
| `src/dev/` | Development aids (not in production builds). |
| `src-tauri/src/pty/` | PTY sessions and the commands that drive them. |
| `src-tauri/src/fs/` | File listing, operations, watching and git status for the explorer; whole-file reads and atomic writes for editors and viewers. |
| `src-tauri/src/plugins/` | Installed plugins: manifest validation, import (folder or .zip), remove, the `plugin://` scheme. |
| `src-tauri/src/ai/` | AI providers: HTTP adapters (OpenAI-compatible, Anthropic), CLI providers, keys in the OS keychain, the `ai_*` commands; see [ai.md](ai.md). The only code that makes outbound network requests. |
| `src-tauri/src/menu.rs` | Native menu. Has no "Close Window", so ⌘W reaches the app. |
| `src-tauri/src/traffic_lights.rs` | Centres the macOS traffic lights in the web title bar; re-applied on resize and focus. |

## State

`src/state/store.ts` is the single source of truth for workspaces, tabs and
each tab's layout. Rules that the store enforces:

- There is always at least one workspace, and a workspace always has at least
  one tab. Closing the last tab replaces it with a fresh one.
- Removing a tab's last pane closes the tab.
- Each tab remembers its `activePaneId` (the pane that last had focus).

State that is **not** in the store, on purpose:

- **Pane state**: terminal sessions (`src/terminal/sessions.ts`), explorer
  models (`src/explorer/explorers.ts`) and editor/viewer models
  (`src/editor/registry.ts`, including unsaved changes). Each is a shared
  pane state (`createPaneState` in `src/plugins/paneState.ts`), keyed by
  pane id and disposed once no pane wants it and nothing shows it.
- **The mounted layout's transient state** (drag in progress, hover). The
  layout component reports finished changes back to the store.

## Persistence

The store's workspaces, tabs and layouts (including each pane's `data`, such
as a terminal's `cwd`) are saved to `state.json` in the app data directory
through tauri-plugin-store, and restored before the first render.

- `src/state/persist.ts`: pure `snapshotState` / `restoreState`. The saved
  shape has a `version` (`SCHEMA_VERSION`, now 2); bump it and migrate in
  `restoreState` when the shape changes. Version 1 files are still read:
  their terminal panes become `terminal` or `block-terminal` by their saved
  mode. The settings are loaded before the state is restored, since that
  migration reads them (`src/main.tsx`). Restoring validates everything:
  layouts go through `normalizeWorkspaceModel`, panes whose kind is not a
  plugin id are dropped, a tab with no valid panes becomes a fresh tab, duplicate ids are
  replaced, and an unusable file means a fresh start.
- `src/state/persistence.ts`: restores at startup and saves 300 ms after the
  last change (skipped if nothing saved changed). The plugin writes the file
  shortly after and again on exit.
- Transient fields (`activity`, `layoutRev`) are not saved.
- Dev runs with `?mockup` or `?selftest` neither restore nor save.
- Pane data is validated by the plugin of each pane's kind. A pane whose
  plugin is missing or disabled is kept as saved (see
  [plugins.md](plugins.md#restore-and-missing-plugins)).

Window size and position are saved separately by tauri-plugin-window-state.

## Rule for new pane kinds

Pane content components are mounted and unmounted freely: only the active
tab's layout is mounted, and a layout is remounted when its tab's layout is
changed from outside. So **state that must survive belongs outside React,
keyed by pane id**, the way terminal sessions are. A component should only
attach to that state on mount and detach on unmount (`createPaneState`).

A new pane kind is a plugin: see [plugins.md](plugins.md).

## Commands and focus

- Anything a user can do is a function in `src/actions.ts`, registered as a
  command (`src/commands/`) so it gets a binding and a palette entry.
  Menus show its shortcut with `shortcutLabel(id)`.
- Keyboard focus should always be in a pane. `focusPane(id)` in
  `src/layout/dock.ts` sets the pane that *should* have focus; it takes focus
  now, or when its content mounts. Menus and rename fields call
  `refocusPane()` when they close, and a focus keeper returns focus after
  clicks on app chrome. While a rename field is open it owns the keyboard:
  pane focus requests wait and app shortcuts are ignored.

## Menus

`src/components/ui/Menu.tsx` wraps Radix's dropdown and context menus with
one set of items (`MenuItem`, `MenuSub`, `MenuSeparator`…) that work in
either. Menu content mounts only while open, so items can read the store
directly. Closing a menu returns focus to the wanted pane unless the
content is given its own `onCloseAutoFocus`.

Right-click menus:

| Area | Items | Where |
|---|---|---|
| Any pane | the plugin's items (`pane.menu`, declarative), then split, change type, maximize, move to tab, close | `src/plugins/PaneHost.tsx`, `PaneMenuItems.tsx` (shared with the pane toolbar's ⋯ menu) |
| Terminal (on top of the above) | copy/re-run a block (block terminal), copy, paste, select all, clear, switch to block/classic terminal | `src/terminal/menu.ts` |
| Editor / viewer | save, revert, find, go to line, reveal, copy path | `src/editor/menu.ts` |
| Tab | rename, new tab, close, close others, close to the right | `TabStrip.tsx` |
| Workspace switcher | new, rename, delete | `WorkspaceSwitcher.tsx` |
| Empty title bar | new tab, new workspace | `TitleBar.tsx` |

- A terminal whose program reads the mouse (vim, htop) gets right clicks
  instead (`ownsContextMenu`); ⌥-right-click opens the menu anyway.
- The webview's own menu (Reload, Inspect Element) is suppressed everywhere
  except text fields (`suppressNativeContextMenu` in `App.tsx`). In dev
  builds ⌥-right-click still shows it.
- Clipboard access goes through `src/ipc/clipboard.ts`
  (tauri-plugin-clipboard-manager; WebKit's own `readText` shows a system
  "Paste" prompt).
- Pane plugins declare their items (`menu(ctx)` returning `MenuItemSpec`s);
  see [plugins.md](plugins.md).

## Content Security Policy

Set in `src-tauri/tauri.conf.json` (`app.security`):

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'self'` | Nothing remote, ever. |
| `script-src` | `'self' plugin: http://plugin.localhost` | Bundled scripts, and imported plugins' modules from the `plugin://` scheme (the second form is how Windows maps it). Tauri adds hashes for its own. No `eval`. |
| `style-src` | `'self' 'unsafe-inline' plugin: http://plugin.localhost` | React `style` attributes, and `<style>` elements injected by xterm and CodeMirror. Tauri's nonce injection is turned off for this directive (`dangerousDisableAssetCspModification: ["style-src"]`), since a nonce would make browsers ignore `'unsafe-inline'`. |
| `img-src` | `'self' blob: data: plugin: http://plugin.localhost` | Plugins' images. The viewer shows images (and local Markdown images) as `blob:` URLs read through the backend. |
| `media-src` | `'self' blob:` | |
| `font-src` | `'self' data: plugin: http://plugin.localhost` | Bundled fonts, and plugins'. |
| `connect-src` | `'self' ipc: http://ipc.localhost` | Tauri IPC (see [terminal.md](terminal.md#content-security-policy)). |
| `object-src`, `frame-src`, `form-action`, `base-uri` | `'none'` | Unused. |

`devCsp` is the same plus what Vite's dev server needs: inline scripts
(React Refresh's preamble), `ws://` / `http://localhost:1420`, and
`http://127.0.0.1:*` for the self-test's report.
Rendered Markdown is sanitized (DOMPurify) and never loads anything by
itself, so it does not rely on the CSP alone.

The Rust backend does make outbound requests: AI providers
(`src-tauri/src/ai/`, see [ai.md](ai.md)). The webview's policy is
unchanged by that: the webview asks through IPC, the backend calls the
provider with a key the webview never sees, and `connect-src` stays local.

To check a production build against the policy without Tauri, serve
`dist/` with the policy as a `Content-Security-Policy` header and watch the
console for violations (opening files and images from the palette
exercises the viewer).

## Running

| Command | What it does |
|---|---|
| `bun run tauri dev` | The real app. |
| `bun run dev:mcp` | The real app with the local Tauri MCP bridge enabled. Self-contained: vite on 1430 (`MIDTERM_DEV_PORT`; HMR on the same port, or port+1 with `TAURI_DEV_HOST`), app data in `com.ron.midterm.mcp`, in-memory AI keys, window titled "midterm (mcp)". Runs next to `tauri dev`. |
| `bun run dev` | Frontend only, in a browser at `localhost:1420`, with a mock PTY that echoes input. Good for layout work. |
| `bun run dev` + `?mockup` | Same, seeded with the arrangement from the design mockup (the editor and viewer show files from the mock file tree). |
| `bun run test` | Frontend unit tests (vitest). |
| `bun run typecheck` | `tsc --noEmit`. |
| `cargo test` (in `src-tauri/`) | Backend tests. |
| `?selftest=PORT` | Self-test of the real app; see [terminal.md](terminal.md). |

In dev builds `window.__midterm` exposes `actions`, `dock`, `store`,
`sessions`, `settings`, `commands`, `plugins` (the registry), `skills`,
`loader` and `invokeSkillTool` for poking at the app from the console or a test driver.

### Tauri MCP

Open this repo in Claude Code, Codex, or Antigravity. Each client reads its
project configuration (`.mcp.json`, `.codex/config.toml`, or
`.agents/mcp_config.json`) and launches the pinned `tauri` server through
`npx`. Use Node.js 20 or newer. Claude Code prompts for project server approval
on first use. Codex and Antigravity load MCP servers for trusted workspaces.
In Antigravity, open `/mcp` in a workspace session to check the server status.

Run `bun run dev:mcp` from the repo root and wait for the bridge to log its
address. Start `driver_session` with `action: "start"`, using host `127.0.0.1`
and the logged port (typically `9223`), then call `webview_dom_snapshot` or
`webview_screenshot`. The optional Cargo feature and Tauri config overlay
enable the bridge and its webview permissions for this debug run. While it is
running, local processes can connect and control the app through the bridge.
