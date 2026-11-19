# Roadmap

Milestones are ordered; each builds on the ones before it. Check items off as
they land, and delete a milestone's section once all of it is done.

Done so far (Milestone 1): app shell matching the mockup, workspaces and
tabs, nested split layout with resize and drag-to-dock, pane menu and
shortcuts, PTY-backed classic terminals. See [architecture.md](architecture.md).

## M2 — Persistence and tab polish

Goal: quitting and reopening the app brings back the same workspaces, tabs
and layouts, with terminals in the directories they were in.

- [ ] Persist `workspaces` / `activeWorkspaceId` (tauri-plugin-store), debounced, with a schema version
- [ ] Validate saved layouts on load with `normalizeWorkspaceModel`; fall back to a fresh tab if invalid
- [ ] Track each terminal's cwd from OSC 7 and store it in `PaneData`
- [ ] Shell integration snippets that emit OSC 7 (zsh, bash, fish), injected without touching user rc files
- [ ] Spawn restored terminals in their saved cwd (`pty_spawn` already takes `cwd`)
- [ ] New splits and tabs start in the focused terminal's cwd
- [ ] Restore window size and position (tauri-plugin-window-state)
- [ ] Tab titles follow the foreground process / cwd unless renamed by the user
- [ ] Drag tabs to reorder
- [ ] Drag a pane onto a tab (or the `+`) to move it to that tab
- [ ] Tab strip overflow: scroll or a "more tabs" menu when tabs don't fit
- [ ] Collapse the traffic-light gutter in fullscreen
- [ ] Maximize / restore a pane (the layout library supports it: `maximizeTabset`)
- [ ] Confirm before closing a pane, tab or window with a running foreground process

## M3 — File explorer pane

Goal: the `explorer` pane kind shows a live file tree.

- [ ] Rust commands: list directory, stat, create, rename, delete (to trash)
- [ ] File watching with `notify`, debounced, scoped to expanded directories
- [ ] Respect `.gitignore` (`ignore` crate), with a toggle for hidden files
- [ ] Virtualized tree with keyboard navigation and type-ahead
- [ ] Root follows the focused terminal's cwd, with a pin to stop following
- [ ] Git status badges (M / U / …) per file and rolled up to directories
- [ ] Context menu: open, open in new pane, reveal in Finder, copy path, rename, delete
- [ ] Opening a file targets an existing editor/viewer pane or splits to create one

## M4 — Editor and viewer panes

Goal: the `editor` and `viewer` pane kinds open files.

- [ ] CodeMirror 6 editor: language detection, theme from the design tokens
- [ ] Editor state lives outside React, keyed by pane id (same rule as terminals)
- [ ] Read/write files through Rust commands; detect external changes
- [ ] Dirty state, save (⌘S), prompt on close with unsaved changes
- [ ] Breadcrumb header (path segments), as in the mockup
- [ ] Viewer: rendered Markdown, images, and a read-only fallback for other text
- [ ] Find in file (⌘F), go to line
- [ ] Clickable `path:line` in terminal output opens the editor there

## M5 — Command palette

Goal: the title bar's command button and ⌘K open a palette.

- [ ] Palette UI (cmdk or equivalent), styled to the mockup's command button
- [ ] Command registry generated from `src/actions.ts`, with shortcut hints
- [ ] Fuzzy file open within the workspace root
- [ ] Switch tab / workspace by name
- [ ] Run a shell command in a new pane
- [ ] Recent commands and files first

## M6 — Blocks terminal mode

Goal: a per-pane alternative to the classic terminal, as drawn in the mockup:
each command is a block with its cwd, branch, exit code and duration, and
input is a separate editor at the bottom.

- [ ] OSC 133 shell integration (prompt start / command start / command end with exit code) for zsh, bash, fish
- [ ] Segment xterm output into blocks from those marks
- [ ] Block header: cwd, git branch, exit status (red when non-zero), duration
- [ ] Separate input editor with history
- [ ] Autosuggestions from history (⇥ accept, ⏎ run), as in the mockup
- [ ] Fall back to classic rendering while a full-screen program (alternate screen) is running
- [ ] Per-pane toggle between blocks and classic; default in settings
- [ ] Block actions: copy command, copy output, re-run

## M7 — Settings and theming

- [ ] Settings file and UI: font family and size, cursor style, scrollback, default shell and args
- [ ] Accent color picker (the mockup offers `#8B9CFF`, `#5EEAD4`, `#F5A524`, `#F472B6`)
- [ ] Rebindable keyboard shortcuts
- [ ] Native menu bar generated from the command registry
- [ ] Content Security Policy (currently `null` in `tauri.conf.json`)
- [ ] Terminal: search in scrollback, copy-on-select option, bell handling
- [ ] Decide whether the transparent terminal background is worth its rendering cost; offer a solid option

## M8 — Cross-platform and packaging

- [ ] Linux and Windows window chrome (no traffic lights; custom controls on the right)
- [ ] Ctrl-based shortcut set that does not collide with terminal input
- [ ] Windows shells (PowerShell, cmd, WSL) and ConPTY verification
- [ ] App icon and name in bundles
- [ ] Code signing and notarization (macOS)
- [ ] Auto-update
- [ ] CI: typecheck, vitest, cargo test, clippy, build on all three platforms

## Later / unscheduled

- [ ] Stack several panes in one frame as tabs (currently rejected; see [layout.md](layout.md))
- [ ] Floating panes and pop-out windows (supported by the layout library)
