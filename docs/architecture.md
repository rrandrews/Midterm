# Architecture

Midterm is a Tauri 2 app: a Rust backend (`src-tauri/`) that owns PTYs, and a
React 19 frontend (`src/`) that owns everything on screen.

Other docs: [layout.md](layout.md) · [terminal.md](terminal.md) ·
[explorer.md](explorer.md) · [commands.md](commands.md) ·
[design-tokens.md](design-tokens.md) · [roadmap.md](roadmap.md)

## Concepts

```
workspace ─┬─ tab ─┬─ pane (terminal | explorer | editor | viewer)
           │       └─ pane …      arranged in a nested split layout
           └─ tab …
```

- A **workspace** is a named group of tabs. One is active at a time.
- A **tab** holds any number of **panes** in a nested split layout.
- A **pane** has a kind. `terminal` and `explorer` are implemented;
  `editor` and `viewer` render a placeholder naming their file (see the
  roadmap).

## Source map

| Path | What lives there |
|---|---|
| `src/state/` | Types, pure layout helpers, the zustand store, saving/restoring it. Unit-tested. |
| `src/actions.ts` | User-level actions (split, close, new tab…). Commands, menus and shortcuts call these. |
| `src/commands/` | Command registry: ids, titles, key bindings; see [commands.md](commands.md). |
| `src/shortcuts.ts` | Window-level shortcut handler, driven by the registry. |
| `src/settings/` | User settings: schema, validation, persisted store. |
| `src/layout/dock.ts` | Bridge to the mounted pane layout: imperative handles by tab id, pane focus. |
| `src/components/titlebar/` | Title bar = tab bar: workspace switcher, tabs, app menu. |
| `src/components/layout/` | `PaneLayout` (the split layout) and `PaneToolbar` (hover controls + menu). |
| `src/components/panes/` | Pane content by kind. |
| `src/components/ui/` | Menus (dropdown and right-click), inline edit, confirm dialog, icons. |
| `src/terminal/` | xterm.js sessions and their registry; blocks mode model, rendering and history ([terminal.md](terminal.md)). |
| `src/explorer/` | File explorer models, their registry, pure tree helpers. |
| `src/ipc/` | Typed wrappers over Tauri commands. The only place that calls `invoke`. |
| `src/styles/` | Tailwind entry + design tokens, and CSS for the layout and terminal. |
| `src/dev/` | Development aids (not in production builds). |
| `src-tauri/src/pty/` | PTY sessions and the commands that drive them. |
| `src-tauri/src/fs/` | File listing, operations, watching and git status for the explorer. |
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

- **Terminal instances.** They live in `src/terminal/sessions.ts`, keyed by
  pane id, and are reconciled against the store (see [terminal.md](terminal.md)).
- **The mounted layout's transient state** (drag in progress, hover). The
  layout component reports finished changes back to the store.

## Persistence

The store's workspaces, tabs and layouts (including each pane's `data`, such
as a terminal's `cwd`) are saved to `state.json` in the app data directory
through tauri-plugin-store, and restored before the first render.

- `src/state/persist.ts`: pure `snapshotState` / `restoreState`. The saved
  shape has a `version` (`SCHEMA_VERSION`); bump it and migrate in
  `restoreState` when the shape changes. Restoring validates everything:
  layouts go through `normalizeWorkspaceModel`, panes of unknown kinds are
  dropped, a tab with no valid panes becomes a fresh tab, duplicate ids are
  replaced, and an unusable file means a fresh start.
- `src/state/persistence.ts`: restores at startup and saves 300 ms after the
  last change (skipped if nothing saved changed). The plugin writes the file
  shortly after and again on exit.
- Transient fields (`activity`, `layoutRev`) are not saved.
- Dev runs with `?mockup` or `?selftest` neither restore nor save.

Window size and position are saved separately by tauri-plugin-window-state.

## Rule for new pane kinds

Pane content components are mounted and unmounted freely: only the active
tab's layout is mounted, and a layout is remounted when its tab's layout is
changed from outside. So **state that must survive belongs outside React,
keyed by pane id**, the way terminal sessions are. A component should only
attach to that state on mount and detach on unmount.

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
| Any pane | kind-specific items, then split, change type, maximize, move to tab, close | `PaneContent.tsx`, `PaneMenuItems.tsx` (shared with the pane toolbar's ⋯ menu) |
| Terminal (on top of the above) | copy/re-run a block (blocks mode), copy, paste, select all, clear, blocks mode | `TerminalMenuItems.tsx` |
| Tab | rename, new tab, close, close others, close to the right | `TabStrip.tsx` |
| Workspace switcher | new, rename, delete | `WorkspaceSwitcher.tsx` |
| Empty title bar | new tab, new workspace | `TitleBar.tsx` |

- A terminal whose program reads the mouse (vim, htop) gets right clicks
  instead; ⌥-right-click opens the menu anyway.
- The webview's own menu (Reload, Inspect Element) is suppressed everywhere
  except text fields (`suppressNativeContextMenu` in `App.tsx`). In dev
  builds ⌥-right-click still shows it.
- Clipboard access goes through `src/ipc/clipboard.ts`
  (tauri-plugin-clipboard-manager; WebKit's own `readText` shows a system
  "Paste" prompt).
- New pane kinds add their own items the way terminals do, in
  `PaneContent.tsx`.

## Running

| Command | What it does |
|---|---|
| `bun run tauri dev` | The real app. |
| `bun run dev` | Frontend only, in a browser at `localhost:1420`, with a mock PTY that echoes input. Good for layout work. |
| `bun run dev` + `?mockup` | Same, seeded with the arrangement from the design mockup. |
| `bun run test` | Frontend unit tests (vitest). |
| `bun run typecheck` | `tsc --noEmit`. |
| `cargo test` (in `src-tauri/`) | Backend tests. |
| `?selftest=PORT` | Self-test of the real app; see [terminal.md](terminal.md). |

In dev builds `window.__midterm` exposes `actions`, `dock`, `store` and
`sessions` for poking at the app from the console or a test driver.
