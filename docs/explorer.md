# File explorer

An explorer pane shows a directory tree with git decorations, backed by file
system, git and watcher commands in the Rust backend.

## Backend (`src-tauri/src/fs/`)

Uses [`ignore`](https://crates.io/crates/ignore) (ripgrep's ignore rules),
[`git2`](https://crates.io/crates/git2) (vendored libgit2, no network
features), [`notify`](https://crates.io/crates/notify) with
[`notify-debouncer-mini`](https://crates.io/crates/notify-debouncer-mini),
and [`trash`](https://crates.io/crates/trash).

| File | Role |
|---|---|
| `list.rs` | `list_dir` (one level, ignore rules, sorting) and `stat`. |
| `ops.rs` | `create`, `rename` (no-replace, case-only renames), `trash`. |
| `git.rs` | `status`: branch and one letter per changed file. |
| `watch.rs` | `DirWatch` (one watcher), `reported_dirs` (event → directories, pure), `WatchManager` (registry in Tauri managed state). |
| `commands.rs` | The commands below: thin adapters. |

Everything but `commands.rs` is independent of Tauri and unit-tested in place
(temp dirs, repositories made with git2, and real watcher events).

### Commands

All paths are absolute strings. `src/ipc/fs.ts` is the only caller, except for the two completion commands.

| Command | Arguments (JS names) | Notes |
|---|---|---|
| `fs_list_dir` | `path`, `showHidden` | `FsEntry[]`, directories first, then case-insensitive name (ties by exact name). Errors if `path` is not a readable directory. |
| `fs_stat` | `path` | `FsEntry` or `null` if nothing is there. `ignored` is always `false`. |
| `fs_create` | `path`, `dir` | Empty file or directory. Errors if anything is there or the parent is missing. |
| `fs_rename` | `from`, `to` | Rename or move. Errors if `to` exists, except a case-only rename of the same entry. |
| `fs_trash` | `paths` | Moves to the system trash. A symlink is trashed, not its target. |
| `fs_find_files` | `root`, `limit` | `{ paths, truncated }`: every file under `root` (relative, `/`-separated, sorted), hidden and ignored entries skipped, symlinks not followed. For the palette (`find.rs`). |
| `git_status` | `path` | `{ root, branch, entries }` or `null` outside a work tree (or bare). |
| `fs_watch_start` | `onEvent` | Returns a watcher id. Events arrive as `{ dirs }`. |
| `fs_watch_set` | `id`, `dirs` | Replaces the watched set. Errors on an unknown id. |
| `fs_watch_stop` | `id` | Unknown ids are ignored. |
| `fs_path_commands` | `path` (or `null`) | Executable names on a `PATH` value (the app's own for `null`), sorted, deduplicated; unreadable and relative entries skipped, each directory cached by mtime (30 s TTL). For ⇥ completion in the blocks editor (`complete.rs`, caller `src/ipc/complete.ts`). |
| `fs_complete_list` | `dir` | `{ name, dir, executable }[]` for every entry (dotfiles too, no ignore rules, symlinks followed). For ⇥ completion. |

- `FsEntry` is `{ name, path, kind: "file" | "dir", symlink, hidden, ignored }`.
  `path` is the listed directory as given joined with `name`. Symlinks
  report their target's kind; a broken one is a file. Names that are not
  UTF-8 are converted lossily (such paths cannot be used afterwards).
- `fs_rename` checks for `to` and then renames, so something created at
  `to` in between is replaced. Fine for user-driven renames.
- On macOS `fs_trash` uses `NSFileManager`, not the crate's default of
  scripting Finder, which would make macOS ask for permission to control
  Finder. The cost: "Put Back" may be missing for those items.

### Hidden and ignored

- `hidden`: the name starts with a dot.
- `ignored`: dropped by the `ignore` crate's rules, or the entry is `.git`.
  The rules are `.gitignore` files in the directory and its ancestors,
  `.git/info/exclude` and the global excludes file (`core.excludesFile`),
  all **only inside a git repository**, plus `.ignore` files anywhere.
- Without `showHidden`, hidden and ignored entries are left out; with it,
  everything is listed and flagged.

### Git status

The repository is found from `path` (`Repository::discover`, which ignores
`GIT_DIR`). `root` is the work tree root without a trailing slash, spelled
like the caller's `path` (libgit2 resolves symlinks, e.g. `/tmp` to
`/private/tmp`; the root is re-expressed with the caller's prefix when that
resolves to the same directory). `branch` is HEAD's branch, `null` when
detached; for an unborn branch (fresh `git init`) it is the branch HEAD
names.

`entries` maps `/`-separated paths relative to `root` to one letter.
Untracked directories are expanded to their files; ignored files are left
out. Staged renames are detected (reported at the new path); unstaged ones
show as `D` + `U`, as in `git status`.

| Letter | Meaning | Precedence |
|---|---|---|
| `C` | Conflicted | 1 (wins) |
| `D` | Deleted in the index or the work tree | 2 |
| `R` | Renamed in the index | 3 |
| `A` | New in the index | 4 |
| `M` | Modified or type change, index or work tree | 5 |
| `U` | Untracked | 6 |

Status never writes the index (no `update_index`): a write would wake the
`.git` watcher and request status again, in a loop.

### Watching

- Each directory is watched non-recursively. `fs_watch_set` diffs against
  the current set. Directories that do not exist are skipped silently and
  retried by the next set.
- Changes are debounced: a path is reported once it has been quiet for
  150 ms (`DEBOUNCE`).
- `reported_dirs` maps changed paths to directories: each path reports its
  parent (an entry created, deleted or renamed there), and itself if it is
  a watched directory. A path inside a watched `.git` directory reports
  only that `.git` directory, which is the frontend's cue to refresh git
  status; watching `<repo>/.git` non-recursively catches `index` and `HEAD`
  writes. Only watched directories are reported, deduplicated, in the
  spelling the frontend used.
- Event paths are canonical (FSEvents reports `/private/tmp/x` for
  `/tmp/x`), so each watched directory is stored with its canonical path
  and matched on that. Two spellings of one directory share one OS watch.
- Changes to the set are applied by a worker thread per watcher, latest
  set wins, as one batch (macOS rebuilds its FSEvents stream once per
  batch).
- Watchers are tagged with their window's label and stopped, like PTYs,
  when the window's page starts (re)loading, when the window is destroyed,
  and on exit (`lib.rs`).

### Threads

- `fs_list_dir`, `fs_stat`, `fs_create`, `fs_rename`, `fs_trash` and
  `git_status` are `async` and run on Tauri's blocking pool, so a large
  directory, repository or slow mount never stalls the main thread. Their
  relative order is not guaranteed; the frontend awaits each.
- The watch commands are synchronous (main thread, ordered with each other
  and with window cleanup) but never block: `fs_watch_set` only queues the
  new set for the watcher's worker thread, and stopping only drops the
  worker's channel.
- Per watcher: notify's own thread (FSEvents run loop on macOS), the
  debouncer's thread (which matches events and sends them on the channel)
  and the worker.

## Frontend (`src/explorer/`, `src/components/panes/Explorer*.tsx`)

| File | Role |
|---|---|
| `src/ipc/fs.ts` | Typed wrapper over the backend commands; the contract. |
| `src/ipc/fsMock.ts` | In-memory tree used outside Tauri (`bun run dev`), with dotfiles, an ignored directory and git statuses. |
| `src/explorer/tree.ts` | Pure helpers: paths, `flattenTree` (the visible rows), `gitBadges` (roll-up), `findByPrefix` (type-ahead). Unit-tested. |
| `src/explorer/model.ts` | `ExplorerModel`: one pane's root, expanded directories, listings, selection, inline edit, git status and watcher. |
| `src/explorer/explorers.ts` | Models keyed by pane id (a shared pane state), and root following: unpinned explorers follow the `directory` of the last focused pane whose plugin sets `explorerFollows` (terminals). |
| `src/plugins/builtin/explorer.tsx` | The explorer plugin: data validation, menu, settings (follow the terminal, hidden files by default). |
| `ExplorerPane.tsx` | Header, virtualized tree (`@tanstack/react-virtual`), keyboard, inline rename/create. A row is: indent, chevron, 16px file icon (`FileIcon`, see [icons.md](icons.md)), name, git badge. |
| `ExplorerMenus.tsx` | Right-click items for entries and for the explorer as a whole; trash confirmation. |

### State outside React

Like terminal sessions, an `ExplorerModel` outlives its component. The
pane `attach`es on mount and `detach`es on unmount; the registry disposes a
model once its pane is gone from the store and it is off screen. The
component reads `model.snapshot()` with `useSyncExternalStore`.

What survives a restart is written to the pane's `PaneData` (`root`,
`pinned`, `showHidden`, `expanded`) through `updatePaneData` whenever it
changes.

### Loading and watching

- A directory is listed when it is first shown, when it is expanded again
  (it was not watched while collapsed), and when the watcher reports it.
  A reload keeps the old entries on screen until the new ones arrive;
  responses that lost a race with a newer request are dropped.
- While attached, the model watches the root, every expanded directory
  under it and, inside a repository, `<repo>/.git` (index and HEAD writes).
  Off screen it does not watch, and catches up with a full reload on attach.
- An expanded directory that disappears from its parent's listing is
  forgotten.
- Git status is fetched for the root 400 ms after the last change of any
  kind. Files show their letter; directories show a dot in the color of the
  most significant status inside them (C > D > M > R > A > U).

### Root

An unpinned explorer follows the terminal that last had focus in its tab
(remembered per tab, since focus moves to the explorer as soon as it is
used): its root is that terminal's working directory. Pinning (pane menu,
"Show only this folder", "Go to parent folder") stops following;
unpinning jumps back to the terminal's directory.

### Opening files

`openFile` in `src/actions.ts`: a pane already showing the file gets focus;
else an editor or viewer pane already in the tab gets the file (the last
active one if several, never an editor with unsaved changes; images go to
viewers only); with "Open in new pane", or if there is none, a new pane is
split off the roomiest non-explorer pane, along its longer side
(`addPaneBeside`). The path is `PaneData.path`. Renaming a file updates
panes showing it (`renameOpenFiles`), keeping their buffers. See
[editor.md](editor.md).

`openDirectory` in `src/actions.ts` (a folder ⌘-clicked in a terminal, or
`/open dir`) pins the tab's last active explorer to the folder, or, with
"Open in new pane" or when the tab has none, splits off a new explorer
pinned to it.

### Keyboard

| Key | Does |
|---|---|
| ↑ ↓, Page Up/Down, Home/End | Move the selection |
| → | Expand; on an expanded directory, go to its first child |
| ← | Collapse; otherwise go to the parent |
| ⌘O, ⌘↓ | Open a file, toggle a directory (with ⇧: open in a new pane) |
| ↩, F2 | Rename (as in Finder) |
| ⌘⌫ | Move to Trash (asks) |
| letters | Type-ahead; repeating one letter cycles through names starting with it |

Mouse: a click selects (and toggles a directory), a double click opens a
file, a middle click opens it in a new pane.
