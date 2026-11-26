# SSH remote parity

Midterm supports local-parity workflows over SSH across **classic and block
terminals**, the **file explorer**, the **editor and viewer**, and the
**command palette**, without permanently installing software on remote hosts.

## Architecture

Interactive `ssh` logins started from an integrated local terminal run through
`src-tauri/shell-integration/ssh/run.sh`, which ensures an OpenSSH
`ControlMaster` socket exists when possible — reusing the user's own concrete
`ControlPath` when `ControlMaster` is enabled (or when `-S`/`-o ControlPath`
is passed), or creating a short Midterm-owned socket in a private `0700`
directory `/tmp/mt-<uid>` under macOS's 104-byte `sun_path` limit. When the
user passes explicit control flags without a concrete `ControlPath` (such as
`ssh -M host`), `run.sh` honors the user's flags and skips `ssh=start`, leaving
the terminal untracked.

For filesystem, git, search, watching, and tab-completion requests against that
host, the Rust backend (`src-tauri/src/ssh/`) opens **one** multiplexed
non-interactive channel over the existing `ControlMaster` socket (`-F /dev/null
-S <sock> -o ControlMaster=no -o ProxyCommand=false -o BatchMode=yes -T -e
none`) and streams an in-memory helper over stdin:

1. **Primary (`helper.py`)**: Python 3 JSON-RPC line daemon running strictly in
   memory (zero files installed on the remote). Uses `ripgrep` (`rg`) when
   available on the remote, with an isolated killable Python regex subprocess
   fallback; uses Linux `inotify` (via `ctypes`) or macOS `select.kqueue`
   (vnode events supplemented by periodic directory snapshots) for directory
   watching, with a polling-only fallback on other hosts; uses `git` for
   repository status; implements atomic saves, `(dev, ino)`-checked directory
   copies, and chunked streaming transfers.
2. **Fallback (`fallback.sh`)**: Hardened POSIX `sh` RPC loop used
   automatically when `python3` is unavailable on the remote. Supports listing,
   stat, create, rename, permanent delete, version-checked text reads and
   writes (atomic via sibling temp file + `mv` when the parent directory is
   writable; falls back to staging in `$TMPDIR` and copying into an existing
   writable target when its parent directory is read-only), bounded byte reads,
   `PATH` command listing, completion, and `git_status` (when `git` is installed
   on the remote). Features that require `python3` on the remote — live
   directory watching, name/text search (`fs_find_entries` / `fs_search_text`,
   which return errors), command-palette file discovery (`fs_find_files`, which
   returns empty), and cross-host streaming copies — are unavailable under the
   shell fallback.

## Uniform location URIs

Local paths remain plain absolute POSIX strings (`/Users/...`). Remote
locations use an opaque authority prefix:

```
ssh://<remoteId>/<posixPath>
```

- `remoteId` (`<slug>-<12-hex-hash>`, 1–128 chars `[A-Za-z0-9._@-]`) hashes the
  canonical endpoint (`user@host:port`, `ProxyJump`, `ProxyCommand`) **and**
  effective authentication context (`IdentityFile`, `IdentitiesOnly`,
  `CertificateFile`, `IdentityAgent`, `PKCS11Provider`, `SecurityKeyProvider`,
  `ForwardAgent`) from `ssh -G`, isolating registry IDs, cache entries, and
  Midterm-owned control sockets (when the user explicitly configures a concrete
  `ControlPath` with `ControlMaster` enabled in `~/.ssh/config` or passes `-S`,
  `-M`, or `-o ControlPath` on the command line, `run.sh` reuses that configured
  socket path verbatim; with `ControlMaster no` and no explicit control option,
  `run.sh` uses a Midterm-owned socket).
- The `ssh://<remoteId>` prefix is internal. User-facing displays (breadcrumbs,
  tab titles, tooltips, block headers, command palette, clipboard copies, shell
  `cd`, and terminal pastes) strip the prefix and format locations as
  `<host>:~/...` or plain POSIX paths.
- Rust parsing lives in `src-tauri/src/ssh/location.rs`; frontend helpers live
  in `src/files/location.ts`.

## Wire protocol (`OSC 6974`)

In addition to `OSC 7` (cwd), `OSC 133` (prompt/command marks with `aid=`), and
`OSC 6973` (`PATH` with `aid=`), Midterm defines `OSC 6974` (`src/terminal/osc.ts`):

| Payload | Sender | Purpose |
|---|---|---|
| `ssh=start;id=…;label=…;host=…;user=…;port=…;sock=…;owned=<0\|1>;args=…;token=<tok>` | Local `ssh/run.sh` | Registers a remote connection and its ControlMaster socket. Requires exact match with the PTY's per-session secret `token`. |
| `ssh=end;id=…;token=<tok>` | Local `ssh/run.sh` | Marks the wrapped `ssh` command ended and decrements the connection's active terminal refcount. Requires matching `token`. |
| `meta=1;home=<enc>;shell=<name>[;aid=<aid>]` | Local or remote shell startup | Reports remote `$HOME` (for `~` display and `~/` completion/links) and shell name once per shell. |

## Security invariants

- **Token-authenticated control messages**: `pty_spawn` generates/receives a
  per-PTY secret `MIDTERM_PTY_TOKEN` injected only into local shells (kept in a
  non-exported shell variable and passed only via transient env to `run.sh`).
  Remote output cannot forge `ssh=start` or `ssh=end`.
- **Socket trust verification**: `validate_control_path` and
  `verify_live_socket_trust` (`src-tauri/src/ssh/registry.rs`) reject symlinks
  for the socket itself and its immediate parent directory, verify both lexical
  and canonical ancestor directories are privately owned (or sticky root `/tmp`,
  so trusted intermediate symlinks such as macOS `/tmp` → `/private/tmp` work),
  and verify that live sockets are real Unix domain sockets owned by the current
  user with `mode & 0o022 == 0`.
- **Safe reconnect allowlist**: `validate_safe_ssh_args` only allows `-4`,
  `-6`, `-C`, `-p`, `-l`, `-i`, `-J`, and `-- <dest>`, rejecting `-o`, `-F`,
  `-S`, forwarding flags, and remote commands. When the original `ssh`
  invocation used non-replayable routing options (e.g. `-F`, `-o HostName=…`,
  `-o ProxyCommand=…`), `run.sh` transmits empty `args=`. When the registry
  also has empty stored `ssh_args` for that ID, direct-SSH splits stay
  multiplex-only (`-F /dev/null -o ControlMaster=no -o ProxyCommand=false`) so
  they can never silently connect to a different host (if an earlier replayable
  session was already registered under the same ID, `SshManager::register`
  retains those validated `ssh_args`).
- **No silent local fallback**: Malformed `ssh://` URIs fail closed across
  `pty_spawn`, `fs_*` commands, and viewer link/image resolution. Remote
  Markdown documents cannot resolve `file:` URLs.
- **Explicit permanent remote deletion**: `fs_trash` rejects remote paths;
  remote deletion uses a separate `fs_delete_permanent` command (refusing `/`)
  gated behind an explicit permanent-delete confirmation naming the host.
- **Second-hop isolation**: A tracked 1st-hop SSH session binds to its first
  remote shell `aid`. When a nested shell inside it (such as a 2nd-hop `ssh` or
  `docker exec`) emits prompt integration marks with a distinct `aid`, the
  session sets `subNested = true`, clears hop-1 block location when needed, and
  disables managed file/git/completion operations until hop 1 resumes. (A nested
  shell that emits no prompt marks is indistinguishable from a running command
  and does not itself toggle `subNested`.)

## Backend (`src-tauri/src/ssh/`)

| File | Role |
|---|---|
| `location.rs` | `Location::parse` (`Local` vs `Remote { remote_id, path }`), `validate_remote_id`, remote path formatting (preserving `..` for symlink semantics). |
| `registry.rs` | `SshConnectionInfo`, `SshStatus`, `/tmp/mt-<uid>` creation, ancestor & socket trust checks, `validate_safe_ssh_args`. |
| `client.rs` | `RemoteClient` multiplexed helper lifecycle, bounded line framing, RPC deadlines, cancelable streaming search, chunked byte transfers, watch event forwarding. |
| `transfer.rs` | Cross-host copy (`Local ↔ Remote`, `Remote A ↔ Remote B`) streaming 512 KiB chunks with `O_NOFOLLOW | O_NONBLOCK` local safety, cycle checks, and rollback. |
| `mod.rs` | `SshManager` (Tauri managed state): connection registry, lazy helper startup, generation-bound reconnect, serialized watch reconciler, sync spawn-info mirror for main-thread `pty_spawn`, graceful `-O exit` cleanup of Midterm-owned sockets. |
| `commands.rs` | Tauri commands: `ssh_register_connection`, `ssh_connection_ended`, `ssh_reconnect`, `ssh_restore_connection`, `ssh_list_connections`. Emits `ssh-connection-changed` events. |
| `helper.py` | Embedded Python 3 in-memory helper daemon. |
| `fallback.sh` | Embedded POSIX `sh` fallback helper. |
| `tests.rs` | Unit + real unprivileged localhost `sshd` integration tests covering both Python helper and shell fallback end-to-end. |

## Frontend (`src/files/location.ts`, `src/ipc/ssh.ts`, `src/ssh/`)

| File | Role |
|---|---|
| `src/files/location.ts` | Pure URI parsing, formatting, `sameHost`, `posixPathOf`, `isRootLocation`, `isAbsoluteLocation`, `fallbackHostLabel`. Unit-tested. |
| `src/ipc/ssh.ts` | Typed wrappers over `ssh_*` commands and `ssh-connection-changed` events (plus plain-browser mock registry for `bun run dev`). |
| `src/ssh/connections.ts` | Reactive connection store (`useSshConnection`, `subscribeConnections`), persistence to `ssh-connections.json` (loaded in `src/main.tsx` before state restore), `hostLabelForLocation`, `homeForLocation`, `displayLocation`. |

### Direct-SSH panes & reconnect

Splitting a remote terminal (⌘D), choosing "Open in new terminal" from a remote
explorer, running `$ cmd` from the palette in a remote project, or restoring a
pane whose saved `cwd` is `ssh://<id>/<path>` spawns `ssh -t` directly in
`pty::shell::ssh_command` (multiplexing over the ControlMaster socket and
passing base64-encoded `MIDTERM_REMOTE_CD` to `bootstrap.sh`, which fails
closed if the requested directory is unavailable).

When a connection drops or is restored across app restarts (`status:
"disconnected"`), remote explorer, editor, and viewer panes display an inline
disconnected bar with **Reconnect** (non-interactive `ssh_reconnect`) and
**Terminal** (opens a direct-SSH terminal when `sshArgs` are replayable, or a
local terminal when custom non-replayable routing options were used). Once
reconnected, explorers, open searches, watchers, editors, viewers (including
previously failed embedded Markdown images), and branch/repo caches refresh
automatically.
