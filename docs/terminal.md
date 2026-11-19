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

`sessions.ts` keeps sessions in a map keyed by pane id. Nothing disposes a
session directly. Instead, whenever the store changes (and whenever a
terminal is detached) the registry disposes every session that is **both**
off screen **and** has no `terminal` pane with its id anywhere in the store.

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
- Options and colors are in `theme.ts`. The background is transparent so the
  pane gradient shows through (`allowTransparency`).
- Fonts are preloaded in `main.tsx` before any terminal opens, because xterm
  measures its cell size from the font when it opens.
- `FitAddon` refits on a `ResizeObserver`, at most once per frame, and only
  while the host has a size.

### Input

- App shortcuts (`src/shortcuts.ts`) are excluded from xterm with
  `attachCustomKeyEventHandler`; the window-level handler runs them.
- Links open in the default browser on ⌘-click (`src/ipc/shell.ts`, http(s)
  only).
- Input typed while the shell is starting is queued and sent, in order, once
  it is running.

### Without Tauri

`spawnPty` falls back to a mock when the page is not running inside Tauri
(`bun run dev` in a browser). The mock echoes lines and understands `exit`.
It exists for layout work and is not a shell.

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
(fish also whenever `$PWD` changes). The user's startup files are never
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
| zsh | `ZDOTDIR=<dir>/zsh`, original in `MIDTERM_ZSH_ZDOTDIR` (absent if `ZDOTDIR` was unset). Our `.zshenv` restores/unsets `ZDOTDIR`, sources the user's `.zshenv`, then (interactive only) `midterm-integration.zsh`. zsh reads `.zprofile`/`.zshrc`/`.zlogin` from the restored location, so it stays a normal login shell (`-zsh`). Hooks are added to `precmd_functions` at the first prompt, in front of the user's. |
| bash | `bash --rcfile <dir>/bash/midterm.bash`. The script reads the login files itself (`/etc/profile`, then the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile`) and puts its hook **first** in `PROMPT_COMMAND` (string or 5.1+ array), passing `$?` through so the user's hooks still see it. |
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

**Adding OSC 133 (M6)**: each script has a prompt hook (`_midterm_precmd`
in zsh, `_midterm_prompt_command` in bash, `__midterm_prompt` in fish) that
runs before the prompt and already captures the previous command's exit
status in `ret` (zsh, bash), plus a preexec hook (`_midterm_preexec`,
`__midterm_preexec`; bash needs a DEBUG trap or `PS0`). Emit `D;$ret` and
`A` from the prompt hook, `B` at the end of the prompt and `C` from preexec.
The tests in `src-tauri/src/pty/tests/shells.rs` run the real shells in a
sandboxed `HOME` and are the place to check new marks.

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

### If a Content Security Policy is added

Large chunks are delivered over Tauri's custom IPC protocol. A CSP that blocks
it makes Tauri fall back to `postMessage`, and chunks then arrive as number
arrays (still handled by `src/ipc/pty.ts`, but slower). Allow
`ipc: http://ipc.localhost` in `connect-src`.

## Working directory

A session learns its shell's directory from OSC 7 (`file://host/path`,
parsed by `src/terminal/osc.ts`). The host in the first report, which comes
from our own shell integration, is taken as the local host; later reports
naming another host (a shell inside `ssh`) are ignored.

- Each change is written to the pane's `PaneData.cwd` (`updatePaneData` in
  `src/actions.ts`: through the mounted layout's handle if the tab is
  showing, else the store), so it is saved with the layout.
- A session starts its shell in the pane's saved `cwd`; the backend falls
  back to the home directory if it no longer exists.
- New splits and new tabs start in the active pane's `cwd`.

## Checking the real app without looking at it

`src/dev/selftest.ts` drives the running app (real webview, real shell) and
posts a JSON report to a local listener: raw-byte delivery, running commands,
environment, resize, an 8 MB flood, exit codes, kill, terminal scaling, a
terminal surviving a re-dock, and focus after layout changes.

```sh
# 1. a listener that accepts one POST on PORT and saves the body
# 2. the app, pointed at the self-test:
bun run tauri dev --config '{"build":{"devUrl":"http://localhost:1420/?selftest=PORT"}}'
```

It runs harmless commands in your login shell. Dev builds only.
