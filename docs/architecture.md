# Architecture

Midterm is a Tauri 2 app: a Rust backend (`src-tauri/`) that owns PTYs, and a
React 19 frontend (`src/`) that owns everything on screen.

Other docs: [layout.md](layout.md) · [terminal.md](terminal.md) ·
[design-tokens.md](design-tokens.md) · [roadmap.md](roadmap.md)

## Concepts

```
workspace ─┬─ tab ─┬─ pane (terminal | explorer | editor | viewer)
           │       └─ pane …      arranged in a nested split layout
           └─ tab …
```

- A **workspace** is a named group of tabs. One is active at a time.
- A **tab** holds any number of **panes** in a nested split layout.
- A **pane** has a kind. Only `terminal` is implemented; the other kinds
  render a placeholder (see the roadmap).

## Source map

| Path | What lives there |
|---|---|
| `src/state/` | Types, pure layout helpers, the zustand store. No React, no DOM. Unit-tested. |
| `src/actions.ts` | User-level commands (split, close, new tab…). Menus and shortcuts both call these. |
| `src/shortcuts.ts` | Keyboard shortcut table and window-level handler. |
| `src/layout/dock.ts` | Bridge to the mounted pane layout: imperative handles by tab id, pane focus. |
| `src/components/titlebar/` | Title bar = tab bar: workspace switcher, tabs, app menu. |
| `src/components/layout/` | `PaneLayout` (the split layout) and `PaneToolbar` (hover controls + menu). |
| `src/components/panes/` | Pane content by kind. |
| `src/components/ui/` | Menu, inline edit, icons. |
| `src/terminal/` | xterm.js sessions and their registry. |
| `src/ipc/` | Typed wrappers over Tauri commands. The only place that calls `invoke`. |
| `src/styles/` | Tailwind entry + design tokens, and CSS for the layout and terminal. |
| `src/dev/` | Development aids (not in production builds). |
| `src-tauri/src/pty/` | PTY sessions and the commands that drive them. |
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

## Rule for new pane kinds

Pane content components are mounted and unmounted freely: only the active
tab's layout is mounted, and a layout is remounted when its tab's layout is
changed from outside. So **state that must survive belongs outside React,
keyed by pane id**, the way terminal sessions are. A component should only
attach to that state on mount and detach on unmount.

## Commands and focus

- Anything a user can do is a function in `src/actions.ts`. Add new commands
  there, then reference them from menus and `src/shortcuts.ts`.
- Keyboard focus should always be in a pane. `focusPane(id)` in
  `src/layout/dock.ts` sets the pane that *should* have focus; it takes focus
  now, or when its content mounts. Menus and rename fields call
  `refocusPane()` when they close, and a focus keeper returns focus after
  clicks on app chrome. While a rename field is open it owns the keyboard:
  pane focus requests wait and app shortcuts are ignored.

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
