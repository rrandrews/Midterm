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
- M6: blocks terminal mode: OSC 133 marks from zsh, bash and fish; output
  cut into blocks with cwd, branch, exit status and duration; input editor
  with history and autosuggestions; classic fallback for full-screen
  programs and shells without integration; per-pane toggle with the
  default in settings; copy command/output and re-run. See
  [terminal.md](terminal.md#blocks-mode).

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

Terminals and shells:

- [ ] Shell integration follow-ups: run the fish script and test on a machine with fish; bash 5.1+ and Linux paths are untested; Debian reads `/etc/bash.bashrc` twice (once itself, once via `/etc/profile`); an `/etc/zshenv` that sets `ZDOTDIR` skips integration; a `.zshrc` that assigns `precmd_functions=(…)` drops our hook
- [ ] Shells inherit the launching terminal's environment in dev (e.g. another terminal's `ZDOTDIR`, which swaps in its history file and integration)
- [ ] Busy check misses programs started with `exec` (same pid as the shell)
- [ ] Blocks mode: no tab completion or ⌃R search in the input editor (switch to classic); a line already typed into the shell's own prompt in classic mode is not cleared before the editor sends one; RPROMPT text can end up in a command read back from the prompt (typed in classic mode); output printed before the first prompt (and between a command's end and the next prompt) is only visible in classic mode; a full buffer that is erased (`ESC [ 2 J`) re-anchors the running block at the top of the scrollback; the cursor is drawn even when a program hides it; block cursor in the editor is the browser caret, not a block
- [ ] Blocks mode: per-block virtualisation (blocks use `content-visibility` and cap their DOM at 300 lines plus "Show earlier lines"), `git status` per prompt is computed in full just to get the branch, no "ahead" count in the status line
- [ ] OSC 133 follow-ups: bash marks a command line that is only a subshell (`(exit 3)`) with no C/D (DEBUG trap; PS0 on bash 4.4+ untested); a DEBUG trap installed after startup (bash-preexec) replaces ours; fish 4 may print its own 133 marks (duplicates are tolerated); a `fish_prompt` defined after the first prompt loses B

Explorer:

- [ ] Multi-select, drag and drop (move files, drop a path into a terminal), remember scroll position across remounts
- [ ] Git status goes stale in linked worktrees (`.git` is a file, so nothing is watched)
- [ ] A watched symlinked directory keeps watching its old target if retargeted
- [ ] Move to Trash acts on the path, so a file swapped in while the dialog is open is the one trashed

Layout:

- [ ] Stack several panes in one frame as tabs (currently rejected; see [layout.md](layout.md))
- [ ] Floating panes and pop-out windows (supported by the layout library)
