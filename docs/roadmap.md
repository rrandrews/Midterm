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

- [ ] Shell integration follow-ups: run the fish script and test on a machine with fish; bash 5.1+ and Linux paths are untested; Debian reads `/etc/bash.bashrc` twice (once itself, once via `/etc/profile`); an `/etc/zshenv` that sets `ZDOTDIR` skips integration; a `.zshrc` that assigns `precmd_functions=(…)` drops our hook
- [ ] Busy check misses programs started with `exec` (same pid as the shell)
- [ ] Explorer: multi-select, drag and drop (move files, drop a path into a terminal), remember scroll position across remounts
- [ ] Shells inherit the launching terminal's environment in dev (e.g. another terminal's `ZDOTDIR`, which swaps in its history file and integration)

- [ ] Stack several panes in one frame as tabs (currently rejected; see [layout.md](layout.md))
- [ ] Floating panes and pop-out windows (supported by the layout library)
