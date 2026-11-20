# Terminals

A terminal pane is an [xterm.js](https://xtermjs.org) instance in the webview
connected to a PTY owned by the Rust backend.

```
keys ──► xterm ──► pty_write ──► PTY master ──► shell
screen ◄── xterm ◄── data channel (raw bytes) ◄── reader thread ◄── shell
                └──► pty_ack (bytes parsed) ──► flow control
```

## Frontend (`src/terminal/`, `src/ipc/pty.ts`)

### Sessions outlive components

`TerminalSession` (`session.ts`) owns the xterm instance, its PTY handle and a
host `<div>` that is never owned by React. `TerminalPane` only calls
`attach(container)` on mount and `detach()` on unmount, which moves the host on
and off screen. The shell and scrollback are untouched, so they survive tab
switches, layout remounts and dragging a pane somewhere else.

The shell is spawned on the first `attach`, once the terminal has a size.

### Lifetime: reconciliation, not manual cleanup

`sessions.ts` keeps sessions in a shared pane state keyed by pane id
(`createPaneState` in `src/plugins/paneState.ts`). Nothing disposes a
session directly. Instead, whenever the store changes (and whenever a
terminal is released) every session that is **both** held by no mounted
component **and** has no terminal pane (classic or block) with its id
anywhere in the store is disposed.

That one rule covers closing a pane, a tab or a workspace, and changing a
pane's kind. When adding features that move panes around, keep the pane in
the store for the whole move (see `movePaneToNewTab`) and its session will
follow.

### Exit

When the shell exits the pane closes (`closePane`). Exception: a shell that
ran for less than 1.5s (the backend reports the runtime) stays open and prints
the error, so a broken shell configuration is visible instead of making panes
vanish. After an exit, input is dropped.

### Acknowledging output

Every byte received is acknowledged to the backend exactly once (see "Flow
control" below): when xterm has parsed it, or, for a session that is disposed
with output still queued or in flight, when it is discarded. Bytes settled
before the PTY handle is known are acknowledged as soon as it is.

### Rendering

- WebGL renderer, enabled on attach and released on detach, because browsers
  cap the number of live WebGL contexts. If the context is lost xterm falls
  back to its DOM renderer.
- Options and colors are in `theme.ts`. `terminalOptions(settings)` gives
  the ones that follow the settings (font family and size, cursor style and
  blink, scrollback, the accent as cursor and selection color, the
  background), read from `terminalConfig()` (the terminal plugin's settings
  plus the global font and accent); `sessions.ts` applies changes to every live terminal
  (`TerminalSession.applySettings`), refitting after font changes and
  recreating the WebGL renderer when transparency changes.
- Background: transparent by default, so the pane gradient shows through
  (`allowTransparency`). Decision (M7): kept as the default, because it is
  what the design calls for and with the WebGL renderer the cost is small
  (the glyph atlas cannot use subpixel antialiasing over a transparent
  background, and blending costs a little per frame). The `solid` setting
  paints `SOLID_BACKGROUND` (`--terminal-solid`) in both xterm and the pane,
  for the crispest text and the cheapest frames.
- Fonts are preloaded in `main.tsx` before any terminal opens, because xterm
  measures its cell size from the font when it opens.
- `fitTerminal` (`src/terminal/fit.ts`) refits on a `ResizeObserver`, at
  most once per frame, and only while the host has a size. It replaces
  `@xterm/addon-fit`, which keeps a strip free for xterm's 14px scroll bar;
  ours is a slim overlay over the last column (`terminal.css`), like the
  app's native scroll bars.

### Find, bell, copy on select

- ⌘F opens a find bar over the terminal (`TerminalFindBar.tsx`, the
  terminal's `find` pane action) that searches the scrollback with
  `@xterm/addon-search`: matches are highlighted in the accent, ↩ / ⌘G
  next, ⇧↩ / ⇧⌘G previous, Escape closes. In blocks mode the pane shows
  the classic terminal while the bar is open; the blocks view stays
  mounted but hidden, so the input editor keeps its draft, and the find
  field comes first in the pane's focus routing.
- Bell (BEL): per the `bell` setting, a short accent flash of the pane
  (`.pane.is-ringing`; bells during a flash are ignored, so a burst costs
  one class change), a soft generated tone (Web Audio, at most one per
  100 ms), or nothing.
- Copy on select: the selection is copied when a mouse button is released
  over the terminal. Selections made by search are not copied.

### Shell from the settings

`shell` / `shellArgs` are passed to `pty_spawn`; see
[commands.md](commands.md#settings-dialog). Changing them affects new
terminals only.

### Input

- App shortcuts (`src/shortcuts.ts`) are excluded from xterm with
  `attachCustomKeyEventHandler`; the window-level handler runs them.
- Links open in the default browser on ⌘-click (`src/ipc/shell.ts`, http(s)
  only). File references such as `src/a.ts:12:5` open in an editor on
  ⌘-click (`src/terminal/fileLinkProvider.ts`; see [editor.md](editor.md)).
- Input typed while the shell is starting is queued and sent, in order, once
  it is running.

### Without Tauri

`spawnPty` falls back to a mock (`src/ipc/ptyMock.ts`) when the page is not
running inside Tauri (`bun run dev` in a browser). It is not a shell, but it
prints OSC 7 and OSC 133 marks like the real integration, so blocks mode can
be worked on in a browser, and knows a few commands: `ls`, `cd`, `pwd`,
`echo`, `git status`, `seq N`, `sleep N` (⌃C stops it), `ask` (reads a
line), `vim`/`less` (alternate screen, `q` quits), `clear`, `true`,
`false`, `exit [n]`.

## Backend (`src-tauri/src/pty/`)

Uses [`portable-pty`](https://crates.io/crates/portable-pty) directly.

| File | Role |
|---|---|
| `session.rs` | One child on a PTY and its threads. No Tauri types, so it is unit-tested directly (`tests.rs`). |
| `manager.rs` | `PtyManager`: id → session registry in Tauri managed state. |
| `shell.rs` | Which program to run, its environment and working directory. |
| `process.rs` | Executable name of a pid, for the foreground process (Unix). |
| `integration.rs` | Shell integration: writes the scripts in `src-tauri/shell-integration/` to disk and makes the shell load them (Unix). |
| `commands.rs` | The `pty_*` commands: thin adapters from channels to a session's sinks. |

### Commands

| Command | Arguments (JS names) | Notes |
|---|---|---|
| `pty_spawn` | `cols`, `rows`, `cwd?`, `onData`, `onEvent` | Returns the session id. Output can start arriving before the id does. |
| `pty_write` | `id`, `data` | UTF-8 input. Queued; never blocks. Errors on an unknown id. |
| `pty_write_bytes` | `id`, `data` (byte array) | Input that is not text, e.g. legacy mouse reports (xterm's `onBinary`). |
| `pty_resize` | `id`, `cols`, `rows` | Errors on an unknown id. |
| `pty_ack` | `id`, `bytes` | Flow-control acknowledgement. Unknown ids are ignored. |
| `pty_kill` | `id` | SIGHUP, then SIGKILL after 250ms. Idempotent. An exit event still follows. |
| `pty_foreground` | `id` | `{ pid, name, isShell }` or `null`. See below. |

- `onData` receives an `ArrayBuffer` of raw bytes (sent as
  `InvokeResponseBody::Raw`; a `Channel<Vec<u8>>` would arrive as a JSON
  number array). Chunks can split UTF-8 sequences, which xterm handles.
- `onEvent` receives `{ event: "exit", data: { code, runtimeMs } }`. `code` is
  `null` when the child was ended by a signal; `runtimeMs` is how long it ran,
  measured in the backend because delivery of the event can lag the exit.
- All commands are synchronous, so Tauri runs them in arrival order on the
  main thread. That is what keeps keystrokes in order. Keep them that way.

`src/ipc/pty.ts` is the only caller.

### Foreground process

`pty_foreground` (`Pty.foreground()` in `src/ipc/pty.ts`) returns the
terminal's foreground process, e.g. `{ "pid": 4242, "name": "vim",
"isShell": false }`, for tab titles and for asking before closing a pane
with something running. It is the leader of the terminal's foreground
process group (`tcgetpgrp` on the master, via portable-pty's
`process_group_leader`). `name` is the executable name (macOS `proc_name`,
Linux `/proc/<pid>/comm`, so `zsh` rather than `-zsh`; empty if unreadable).
`isShell` is true when that process is the session's own child, i.e. the
shell is at its prompt. `null` for unknown or exited sessions and on
Windows. Lookup code is in `process.rs`. The mock PTY reports a shell.

### Shell and environment

- `CommandBuilder::new_default_prog()`: `$SHELL` if executable, else the
  account's shell, else `/bin/sh`, started as a **login shell** (via
  `argv[0] = "-zsh"`), so `PATH` is correct when the app is launched from
  Finder.
- `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=midterm`,
  `TERM_PROGRAM_VERSION`. On macOS `LANG=en_US.UTF-8` is set when no locale
  variable is present (Finder-launched apps have none).
- Working directory: the `cwd` argument if it is an existing directory,
  otherwise the home directory.
- zsh, bash and fish additionally get shell integration (below); bash is
  then started as `bash --rcfile …` instead of `-bash`.

### Shell integration

zsh, bash and fish report their working directory with OSC 7
(`ESC ] 7 ; file://<host><percent-encoded path> BEL`) before every prompt
(fish also whenever `$PWD` changes), and mark prompts and commands with
OSC 133 (below). The user's startup files are never
modified. The shell is recognised by the file name of the program
`new_default_prog` picks (`$SHELL`, else the passwd entry); anything else
starts exactly as before.

The scripts are in `src-tauri/shell-integration/`, embedded with
`include_str!` and written by `integration::install` on every spawn to
`~/Library/Caches/com.ron.midterm/shell-integration/<version>/` (Linux:
`$XDG_CACHE_HOME` or `~/.cache`). Unchanged files are left alone and changed
ones are replaced by atomic rename, so concurrent spawns and app instances
are safe. If writing fails the shell starts without integration.

| Shell | How it is injected |
|---|---|
| zsh | `ZDOTDIR=<dir>/zsh`, original in `MIDTERM_ZSH_ZDOTDIR` (absent if `ZDOTDIR` was unset). Our `.zshenv` restores/unsets `ZDOTDIR`, sources the user's `.zshenv`, then (interactive only) `midterm-integration.zsh`. zsh reads `.zprofile`/`.zshrc`/`.zlogin` from the restored location, so it stays a normal login shell (`-zsh`). Hooks are added to `precmd_functions` at the first prompt: ours first, and `_midterm_prompt_end` last (moved back to the end at every prompt). |
| bash | `bash --rcfile <dir>/bash/midterm.bash`. The script reads the login files itself (`/etc/profile`, then the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile`) and puts its hook **first** in `PROMPT_COMMAND` (string or 5.1+ array), passing `$?` through so the user's hooks still see it, and `_midterm_prompt_end` **last**. A DEBUG trap (chained to the user's) marks the start of a command. |
| fish | `<dir>` prepended to `XDG_DATA_DIRS`, so fish sources `<dir>/fish/vendor_conf.d/midterm.fish`. It removes the entry (`MIDTERM_FISH_DATA_DIR`) or unsets the variable if it was unset before (`MIDTERM_FISH_XDG_DATA_DIRS_UNSET`). |

Every integrated shell gets `MIDTERM_SHELL_INTEGRATION=1`. The scripts guard
against being sourced twice.

Why bash is not a real login shell: the Ghostty/kitty approach (`--posix`
with `ENV` pointing at the script) does not work with bash 3.2, the macOS
`/bin/bash`, which ignores `ENV` in posix mode, and an `argv[0]` of `-bash`
makes bash ignore `--rcfile`. The script reads the same files a login shell
would, but `$0` is the shell's path, `shopt login_shell` is off, `logout`
does not work (use `exit`) and `~/.bash_logout` is not read.

Paths are percent-encoded byte by byte (everything except `A-Za-z0-9/._~-`)
in zsh and bash, and with `string escape --style=url` in fish. The host is
`$HOST` (zsh), `$HOSTNAME` (bash) or `$hostname` (fish).

### OSC 133: prompt and command marks

Each script marks the parts of the screen (all terminated by BEL):

| Mark | Meaning | Emitted by |
|---|---|---|
| `ESC ] 133 ; A` | prompt starts | the prompt hook, after D and OSC 7 |
| `ESC ] 133 ; B` | prompt ends, input starts | the end of the prompt (`PS1`, or fish's wrapped `fish_prompt`) |
| `ESC ] 133 ; C` | command accepted, output starts | preexec |
| `ESC ] 133 ; D ; <status>` | command finished | the prompt hook (fish: `fish_postexec`), only if a C was printed since the last prompt |

So one command is `C … output … D;n (OSC 7) A prompt B`. An empty Enter or
⌃C at the prompt gives only `A B`. Redraws (zle `reset-prompt`, ⌃L) can
print B again; the frontend allows that, and ignores a second C for the
same command.

- **zsh**: `_midterm_precmd` (first precmd hook) prints D, OSC 7 and A;
  `_midterm_prompt_end` (last precmd hook, so themes that rewrite `PS1` in
  their own hooks keep it) strips and re-appends `%{ESC]133;B BEL%}` to
  `PS1` (only with `prompt_percent`); `_midterm_preexec` prints C. zsh
  runs the `precmd` function before a copy of `precmd_functions`, so when
  the user has no `precmd` function the script installs a one-off one that
  puts the hooks in order before the first prompt.
- **bash**: `_midterm_prompt_command` (first in `PROMPT_COMMAND`) prints
  D, OSC 7 and A and disarms the DEBUG trap; `_midterm_prompt_end` (last)
  appends `\[ESC]133;B BEL\]` to `PS1` and arms it. The trap prints C for
  the first command after it is armed, unless that command is our own
  prompt hook (nothing ran), and stays quiet inside functions (`set -T`).
  A DEBUG trap the user set in their startup files is chained: it still
  runs, with `$?` and `$_` as it would have seen them. The trap returns 0,
  so `extdebug` does not skip commands. (PS0 would be simpler on bash
  4.4+, but bash 3.2 has no PS0 and the trap works everywhere.)
- zsh prints its `PROMPT_SP` marker (an inverse `%` after output without
  a final newline) before precmd, so it appears at the end of such a
  block, as it does in the classic terminal. Output from a user's own
  `precmd` function also lands before D.
- **fish**: `__midterm_prompt` (`fish_prompt` event) prints OSC 7 and A
  and, once, wraps the user's `fish_prompt` (`functions -c`) to print B
  after it; `fish_preexec` prints C, `fish_postexec` prints D.

Known gaps are tracked in Linear (project "Terminal & Shell Hardening"; see [planning.md](planning.md)). The tests in
`src-tauri/src/pty/tests/shells.rs` run the real shells in a sandboxed
`HOME` and check the exact sequence of marks (fish is skipped when it is
not installed).

### Threads per session

- **Reader** fills a buffer from the PTY (macOS returns at most 1KB per read).
- **Pump** sends coalesced chunks (up to about 64KB, at most 4ms delayed) on
  the data channel, so a flood is tens of messages, not thousands.
- **Writer** drains queued input, so a child that stops reading cannot block
  the main thread.

### Flow control

The pump counts bytes sent but not yet acknowledged. Above `HIGH_WATERMARK`
(1 MiB) it stops sending until acknowledgements bring the count down to
`LOW_WATERMARK` (256 KiB). Stopping propagates back: the buffer fills, the
reader stops, the kernel PTY fills and the child blocks, exactly as it would
on a slow terminal. The frontend acknowledges each chunk from xterm's `write`
callback, i.e. once it has been parsed.

**The frontend must acknowledge every byte.** The exit event is held until
everything sent has been acknowledged (or 1s passes with no progress), because
data and events travel on separate channels and would otherwise race.
Unacknowledged bytes therefore delay every exit by a second.

### Exit and cleanup

- The exit event is sent after all output, and the session then removes
  itself from the registry.
- Sessions are tagged with their window's label. They are killed when that
  window is destroyed, when its page reloads (the old page's channels are
  dead, so its shells could never be reached again), and when the app exits.
- If the app process dies without a clean exit, the kernel hangs up the PTYs
  and the shells exit by themselves.

### Content Security Policy

Large chunks are delivered over Tauri's custom IPC protocol, so the CSP
(see [architecture.md](architecture.md#content-security-policy)) allows
`ipc: http://ipc.localhost` in `connect-src`. If that were blocked, Tauri
would fall back to `postMessage` and chunks would arrive as number arrays
(still handled by `src/ipc/pty.ts`, but slower).

## Working directory

A session learns its shell's directory from OSC 7 (`file://host/path`,
parsed by `src/terminal/osc.ts`). Only reports naming this machine count:
an empty host, `localhost`, or the host name from `gethostname` (the
`local_hostname` command, loaded at startup), which is what zsh, bash and
fish report. Reports from elsewhere (a shell inside `ssh`) are ignored.

- Each change is written to the pane's `PaneData.cwd` (`updatePaneData` in
  `src/actions.ts`: through the mounted layout's handle if the tab is
  showing, else the store), so it is saved with the layout.
- A session starts its shell in the pane's saved `cwd`; the backend falls
  back to the home directory if it no longer exists.
- New splits and new tabs start in the active pane's `cwd`.

## Tab titles

A tab the user has not named (`Tab.titleLocked`) is titled after its active
pane's terminal by `terminalTitle` (`src/terminal/titles.ts`): the
foreground program, or, while the shell waits, the last part of its
directory (`~` for home). Sessions look the foreground up (`pty_foreground`)
250 ms after output, since starting or ending a program always produces
some, and every 2 s while a program (not the shell) is in the foreground,
since one program can hand over to another silently. An idle shell is not
polled. Renaming a tab to an
empty name hands its title back to the panes.

## Asking before closing

`src/closing.ts` wraps closing a pane, tab or workspace: it looks up the
foreground of every terminal that would end and, if any is running a
program, asks with `confirm()` (`src/components/ui/ConfirmDialog.tsx`).
Menus and shortcuts use these; a shell that exits by itself closes its pane
through `closePaneNow` without asking.

Changing a terminal pane to another kind ends its shell, so it asks the same
way (`changePaneKind`).

Closing the window asks the same way (`installCloseGuards` in
`src/ipc/window.ts`), except on macOS, where the close button hides the app
instead (`app_hide_on_close`) and nothing ends, so nothing is asked.
Clicking the Dock icon (`RunEvent::Reopen` in `lib.rs`) or ⌘-Tab shows it
again. Quitting: the backend emits `quit-requested`, and the
webview asks, flushes the saved state (waiting for a save already in
flight) and calls `app_quit`. ⌘Q is our own menu item (`menu::QUIT_ID`);
Quit from the Dock, logout and shutdown go through
`applicationShouldTerminate:`, which `src-tauri/src/quit_guard.rs` adds to
Tao's app delegate at runtime. It lets termination through once `app_quit`
has run, or when there is no webview to ask.

Known gap: a program started with `exec` keeps the shell's pid, so it is
reported as the shell (`isShell: true`).

## Checking the real app without looking at it

`src/dev/selftest.ts` drives the running app (real webview, real shell) and
posts a JSON report to a local listener: raw-byte delivery, running commands,
environment, resize, an 8 MB flood, exit codes, kill, terminal scaling, a
terminal surviving a re-dock, focus after layout changes, and shell
integration (OSC 7), automatic tab titles, the close confirmation, and
M4–M7 features: blocks from the shell's OSC 133 marks (command, output,
exit status), settings reaching a live terminal, the generated menu bar,
editor file writes with the stale-save check, and fuzzy file listing; and
plugins (M8): the example plugin imported and loaded through `plugin://`,
its pane opened from a generated command, its stylesheet, skills (code,
`SKILL.md`, built in, a refused write, invalid input), the placeholder when
disabled, and removal; themes (M9): switching theme updates a CSS variable
and a live terminal's palette, and the theme editor pane opens; AI (M10,
with `&aistub=PORT` and `bun scripts/ai-stub.ts PORT` running): see
[ai.md](ai.md#self-test).

Known failure when the window is not frontmost: "closing a pane ends its
session" reports focus on `<body>` (also on M7).

```sh
# 1. a listener that accepts one POST on PORT and saves the body
# 2. the app, pointed at the self-test:
bun run tauri dev --config '{"build":{"devUrl":"http://localhost:1420/?selftest=PORT"}}'
```

It runs harmless commands in your login shell. Dev builds only.

## Block terminal (blocks mode)

There are two built-in terminal plugins (`src/plugins/builtin/terminal.tsx`,
kinds in `src/terminal/kinds.ts`): the **Classic terminal** (`terminal`)
and the **Block terminal** (`block-terminal`), which shows the output as
**blocks**, one per command, with an input editor at the bottom. Both show
the session kept for their pane id and share the terminal settings (saved
under `plugins.terminal.settings`; the block terminal's settings section
edits the same values). New terminals open in Settings → General →
Default terminal (`defaultTerminal`).

Switching a pane between them (the right-click menu's "Switch to block /
classic terminal", the `terminal.toggleBlocks` command, or Change pane
type) changes the pane's kind (`toggleBlocks` → `setPaneKind`). The session
survives: its liveness rule accepts both kinds, and `keepsStateOnChangeTo`
keeps `changePaneKind` from asking about a running program. The pane
remounts, so the input editor's draft is lost on a switch. "Blocks mode"
below means the block terminal.

Layouts saved before the split (state version 1) had one `terminal` kind
with a per-pane `terminalMode`; `restoreState` turns a blocks pane (or, with
no mode, any pane when the old setting was blocks) into a `block-terminal`
pane, and the file is saved again at once.

| File | Role |
|---|---|
| `src/terminal/blocks.ts` | `parseOsc133`, `BlockTracker`: follows the marks and keeps the list of blocks. Tested with `@xterm/headless`. |
| `src/terminal/blockRender.ts` | Buffer rows → styled runs (and plain text), duration format. |
| `src/terminal/history.ts` | History and autosuggestions; the global list in `history.json`. |
| `src/terminal/gitBranch.ts` | Branch of a directory (`gitStatus`, cached 3 s). |
| `src/terminal/blockMode.ts` | Mode, block actions, context-menu target, the toggle command. |
| `src/components/panes/BlocksView.tsx` | The blocks and their headers; `BlockInput.tsx` is the editor. |
| `src/styles/blocks.css` | Layout and look, from the mockup. |

### The terminal stays the source of truth

The xterm instance is unchanged in blocks mode: same size, same parsing,
same flow control. It stays attached under the blocks view, invisible
(`opacity: 0`), so switching to classic shows the full history and a
full-screen program can take over at once.

`session.blocks` (a `BlockTracker`) registers an OSC 133 handler on the
terminal's parser. On C it places an xterm marker (`registerMarker`) on
the cursor's row: the block's first output row. On D it places another at
the start of D's logical line, and records how many cells into that line D
was printed: output without a final newline ends there, even if the next
prompt follows on the same row (bash). Markers follow their rows through
scrollback trimming and reflow (a marker on a soft-wrapped row would be
disposed when widening merges it, hence the logical line start). When a finished block loses a marker (its
rows left the scrollback, or were erased) it is dropped. The running
block is re-anchored instead, at the top of the screen (erased) or of the
buffer (trimmed), and flagged `truncated`. `ESC [ 3 J` (what `clear`
sends), ⌃L in the editor and the Clear menu item drop all blocks; a
running `clear` is dropped when it ends.

A command sent from the input editor gets its block at once
(`tracker.submit`, before anything is written to the shell), anchored on the
prompt row, and the phase becomes `running`, so a second Enter or Run again
cannot type into it. C moves the start to the real output. If the next
prompt comes without a C (bash marks nothing for a line that is only a
subshell, or a DEBUG trap replaced ours) the block still ends there, with
its output starting after the echoed command line and no exit status.

Each block has its command (exactly what the editor sent, else read back
from the buffer between B and C), the cwd at C (from OSC 7), the branch of that cwd
(looked up at C), the exit status from D and the duration from C to D,
measured in the frontend.

The tracker also knows the **phase** (`prompt` after A/B/D, `running`
after C), whether the **alternate screen** is active
(`buffer.onBufferChange`), and whether the shell has **integration**:
`pending` until the first mark, `absent` if none came within 3 s of the
first output.

### What is shown

`TerminalPane` draws `BlocksView` over the terminal when the pane is in
blocks mode, the shell has not turned out to lack integration, and no
program is on the alternate screen. Otherwise the classic terminal shows
(vim, less, htop run full-pane as usual and the blocks come back when they
exit; a shell without integration stays classic, and the menu item says
so).

- Finished blocks are DOM, rendered once from their buffer rows
  (`renderRows`: cell colors and attributes to spans, soft-wrapped rows
  joined into one line so the DOM wraps them at its own width). At most
  the last 300 lines are rendered; "Show earlier lines" adds 2000 at a
  time. Blocks use `content-visibility: auto`.
- The running block is redrawn from the buffer at most once a frame while
  output arrives (the last 500 rows, with the cursor), so progress bars and
  `\r` updates look right.
- Blocks are bottom-aligned and the list sticks to the bottom unless the
  user scrolls up; running a command scrolls back down.
- Header: cwd (`~`-relative), branch, and `exit N · duration` (err color
  when non-zero), with copy command / copy output / run again buttons on
  hover. The same actions are at the top of the right-click menu on a
  block.
- Text in blocks is selectable; the menu's Copy uses the page selection.

### Keyboard

- At a prompt the **input editor** (a textarea with a ghost-text overlay)
  has the keyboard. ⏎ runs, ⇧⏎ adds a line, ⇥ or → (at the end) accepts
  the suggestion, ↑/↓ walk the history (from the first/last line), Esc
  leaves the history, ⌃C clears the line, ⌃D on an empty line sends EOF,
  ⌃L clears the blocks. App shortcuts still run first (capture phase).
  Paste from the menu goes into the editor.
- Running a command sends it to the shell as if typed
  (`session.runCommand`). A multi-line one has to arrive as one command
  line: as a bracketed paste when the shell enabled it, else with each
  newline quoted as ⌃V ⌃J, which readline (bash 3.2) and zle insert
  literally.
- While a command runs, the hidden terminal has the keyboard, so
  interactive prompts, ⌃C and typeahead work as in classic mode. Clicking
  the blocks gives the keyboard back to whichever target is current.
- `registerPaneFocuser` focuses the editor at a prompt, the terminal
  otherwise, and the pane hands focus over when the phase or mode changes
  while it has it.

### History and suggestions

The suggestion is the most recent history entry that starts with what is
typed. History is the pane's own commands (kept by its tracker, newest
first) followed by the global list, which every pane adds to and which is
saved in `history.json` (last 1000, via `openJsonFile`). Shell history
files are not read. At an empty prompt, and while it continues what is
typed, an AI suggestion can take its place (see [ai.md](ai.md#blocks-input)).
