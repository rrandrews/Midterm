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
- M8: pane plugins. Every pane kind is a plugin behind one contract (data
  validation and conversion, close blockers, menus, file handlers, tab
  titles, backgrounds, commands, declarative settings, skills). Plugins can
  be enabled and disabled. Imported plugins (a folder or .zip with a
  manifest and an ES module) are trusted, run in-process, and are served
  by a `plugin://` scheme. Skills give typed tools with JSON-schema input
  and confirmation for write tools. There is an example plugin. See
  [plugins.md](plugins.md).
- M9: themes. Sixteen bundled themes; `resolveTheme` derives every token;
  themes apply to the CSS, xterm, blocks, CodeMirror and the native window.
  Follow-system with a light and a dark pick; the accent becomes an
  override. Settings → Appearance has a gallery with import (iTerm2, VS
  Code, Base16/24) and export. The palette picker previews live. The theme
  editor pane has a live draft, undo, and contrast warnings. See
  [themes.md](themes.md) and [design-tokens.md](design-tokens.md).
- M10: AI next-command suggestions in blocks mode.
  - The Rust backend makes the requests: OpenAI-compatible and Anthropic
    adapters, and the Claude Code, Codex and Antigravity CLIs.
  - Keys are kept in the OS keychain; a custom endpoint's key is bound to
    its URL.
  - The context sent is redacted, and requests come from a per-pane
    engine with debounce, cancel and backoff.
  - Suggestions appear as ghost text with ⇥ to accept; Settings → AI has
    a test and a preview of what is sent.
  - See [ai.md](ai.md).

## M11 — Cross-platform and packaging

- [ ] Linux and Windows window chrome (no traffic lights; custom controls on the right)
- [ ] Ctrl-based shortcut set that does not collide with terminal input
- [ ] Windows shells (PowerShell, cmd, WSL) and ConPTY verification
- [ ] Keychain backends, the `plugin://` scheme and AI CLI discovery verified on Linux and Windows; on Windows, cancelling an AI CLI kills only the direct child (kill the process tree, e.g. with a job object)
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

Plugins (imported plugins are trusted and run in-process, behind a trust
warning on import; see [plugins.md](plugins.md)):

- [ ] Sandboxed (iframe) plugins with per-plugin permissions, for code that should not be trusted with the whole app
- [ ] Plugin updates and a plugin index
- [ ] Contributions other than panes: status items, palette sources, themes

Themes:

- [ ] Per-workspace or per-pane themes
- [ ] Import of Ghostty, kitty and Alacritty color schemes

AI (suggestions are blocks mode only; requests stay in the Rust backend and
the webview's CSP stays "nothing remote"):

- [ ] An agent that uses plugin skills (tool calls through `invokeSkillTool`, confirmation for `write` tools)
- [ ] Suggestions in classic mode (an overlay at the xterm cursor, and an accept key that does not collide with the shell)
- [ ] Streaming replies; "explain this error" and "fix the last command" on a block
- [ ] AI exposed to plugins through the plugin API
