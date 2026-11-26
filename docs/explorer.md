# File explorer

An explorer pane shows a directory tree with git decorations, backed by file
system, git and watcher commands in the Rust backend.

## Backend (`src-tauri/src/fs/`)

Uses [`ignore`](https://crates.io/crates/ignore) (ripgrep's ignore rules),
[`git2`](https://crates.io/crates/git2) (vendored libgit2, no network
features), ripgrep's library crates
([`grep-searcher`](https://crates.io/crates/grep-searcher),
[`grep-regex`](https://crates.io/crates/grep-regex),
[`grep-matcher`](https://crates.io/crates/grep-matcher)) for text search,
[`notify`](https://crates.io/crates/notify) with
[`notify-debouncer-mini`](https://crates.io/crates/notify-debouncer-mini),
and [`trash`](https://crates.io/crates/trash).

| File | Role |
|---|---|
| `list.rs` | `list_dir` (one level, ignore rules, sorting) and `stat`. |
| `ops.rs` | `create`, `rename` (no-replace, case-only renames), `trash`. |
| `copy.rs` | `copy_into`: a file or tree into a directory under a free Finder-style name. Every file is created with `create_new` and written through that handle (a clash inside a tree is an error, never an overwrite); a failed copy removes only what it created, entry by entry. |
| `find.rs` | `find_files` (palette) and `find_entries` (files and directories, name search) over one shared walker (`walk`). |
| `search.rs` | `search_text` (pure: root, options, cancel flag, event callback) and `SearchManager` (running searches in Tauri managed state). |
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
| `fs_trash` | `paths` | Moves local entries to the system trash. A symlink is trashed, not its target. Rejects remote `ssh://` paths. |
| `fs_delete_permanent` | `paths` | Permanently deletes remote `ssh://` entries (refuses remote `/`; rejects local paths). |
| `fs_find_files` | `root`, `limit` | `{ paths, truncated }`: every file under `root` (relative, `/`-separated, sorted), hidden and ignored entries skipped, symlinks not followed. For the palette (`find.rs`). |
| `fs_find_entries` | `root`, `limit`, `showHidden` | `{ entries: { path, dir }[], truncated }`: files and directories under `root` (not `root` itself; relative, `/`-separated, walk order = sorted by name per directory). Without `showHidden` the same skipping as `fs_find_files`; with it everything, except the contents of `.git` directories (the `.git` entry is listed). Symlinks not followed, reported with their target's kind. |
| `fs_copy` | `from`, `toDir` | Copies a file or directory tree into `toDir`, never replacing: a taken name becomes `a copy.txt`, `a copy 2.txt`, … (`dir copy`, `.env copy`: the extension is what follows the last dot, unless the name starts with it). Returns the copy's path. Symlinks are copied as links, permissions kept, sockets/FIFOs inside a tree skipped. Errors if a directory is copied into itself or a descendant; a failed tree copy is removed again. |
| `fs_search_text` | `root`, `options`, `onEvent` | Starts a text search and returns its id at once; results stream on `onEvent` (see [Text search](#text-search)). |
| `fs_search_cancel` | `id` | Cancels a search. Unknown ids are ignored. |
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

### Text search

`search.rs` runs ripgrep's engine (`grep-regex` matcher, `grep-searcher`
searcher) over the `ignore` walker from `find.rs`: sequential, sorted by
name, symlinks not followed, the same hidden/ignored rules as
`fs_find_entries` (with `showHidden`, `.git` contents are still skipped).

- Query is literal unless `regex` (Rust regex syntax; case-insensitive
  unless `caseSensitive`; `wholeWord` wraps it in word boundaries). An
  invalid pattern, or a root that is not a directory, sends one `error`
  event and no `done`. An empty query sends `done` at once.
- A file with a NUL byte anywhere is binary and skipped (its matches are
  dropped even if found before the NUL), as is a file over 8 MiB.
  UTF-16 files with a BOM are decoded by the searcher.
- A match is a line. Offsets are UTF-16 code units (JS string indices),
  computed by matching again on the line after lossy UTF-8 conversion, so
  invalid bytes become `U+FFFD` and ranges stay right. A regex matching
  the empty string yields only its non-empty matches; lines with none are
  dropped. Lines over 300 units are cut to a 300-unit window starting 60
  units before the first match, with `…` where cut and ranges clipped to it;
  `column` still refers to the full line. A byte-level regex match inside a
  multibyte character grows to the whole character. At most 100 ranges are
  kept per line.
- `maxResults` counts matching lines over all files; the search stops at the
  first match beyond it (`truncated: true`), after sending what it had.
- Events: `files` batches (flushed at 100 files or 50 ms; each file is in one
  batch with all its matches), then one `done { truncated, cancelled,
  filesSearched }`.
- Threads: `fs_search_text` is synchronous (registers the search, spawns a
  `text-search-<id>` thread, returns the id); the thread removes its entry
  when it ends. `fs_search_cancel` sets the search's `AtomicBool`, checked
  between files and on every match, so it also interrupts a big file. The
  channel failing to send (webview gone) cancels too. Searches are tagged
  with their window and cancelled, like watchers, on page (re)load, window
  destruction and exit (`lib.rs`). A cancelled search still sends `done`
  with `cancelled: true`.

### Remote SSH browsing

Filesystem and `git_status` commands accept both local POSIX paths and remote
`ssh://<remoteId>/<posixPath>` URIs, dispatching remote operations over the
host's multiplexed `ControlMaster` helper (see [ssh.md](ssh.md)), with explicit
host-scoped exceptions: `fs_open_default` and `fs_trash` reject remote paths,
while `fs_delete_permanent` rejects local paths:

- **Host indicator & reconnect**: When the root is remote, the top folder shows
  a compact SSH host pill with a live status dot and shortens the remote host's
  home directory to `~`. While disconnected, an inline banner offers
  **Reconnect** and **Terminal** (direct-SSH when reconnect args are replayable,
  else a local terminal); reconnecting automatically reloads the tree, git
  badges, active watches, and any open search overlay.
- **Permanent deletion**: Remote hosts have no local Trash, so ⌘⌫ and the
  context menu show **Delete…** with an explicit confirmation naming the host
  and call `fs_delete_permanent`.
- **Cross-host transfers**: `fs_copy` supports copying across hosts
  (`Local ↔ Remote`, `Remote A ↔ Remote B`) when `python3` is available on the
  remote host(s) (with `(dev, ino)` cycle checks and staged rollback; the POSIX
  `sh` fallback still supports `git_status` when `git` is installed, but omits
  cross-host transfers, live watching, and search). `fs_rename` stays same-host
  only. Dragging across hosts defaults to copy (green `+` badge) even without ⌥
  held.
- **Local-only actions hidden**: "Reveal in Finder" is omitted for remote
  entries/roots; "Copy path" copies the clean POSIX path without `ssh://`;
  dragging entries into a terminal only accepts drops onto a terminal on the
  same host and pastes shell-quoted POSIX paths.

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

- `fs_list_dir`, `fs_stat`, `fs_create`, `fs_rename`, `fs_trash`,
  `fs_copy`, `fs_find_entries` and `git_status` are `async` and run on Tauri's blocking pool, so a large
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
| `src/ipc/fs.ts` | Typed wrapper over the backend commands; the contract. `searchText` wraps the streaming channel and returns `{ cancel }`. |
| `src/ipc/fsMock.ts` | In-memory tree used outside Tauri (`bun run dev`), with dotfiles, an ignored directory and git statuses. |
| `src/explorer/tree.ts` | Pure helpers: paths, `flattenTree` (the visible rows), `gitBadges` (roll-up), `findByPrefix` (type-ahead). Unit-tested. |
| `src/explorer/model.ts` | `ExplorerModel`: one pane's root, link, expanded directories, listings, selection, inline edit, moves and copies, git status and watcher. Unit-tested against the mock (`model.test.ts`). |
| `src/explorer/explorers.ts` | Models keyed by pane id (a shared pane state), and root following: an explorer linked to a terminal follows its `directory`; other unpinned explorers follow the last focused pane whose plugin sets `explorerFollows` (terminals). `linkablePanes` lists the candidates. |
| `src/explorer/clipboard.ts` | The explorers' file clipboard (paths and cut or copy), shared by every explorer in the window. |
| `src/explorer/drag.ts` | The drag in progress (paths, pointer, drop target, copy), shared so every explorer can outline its target folder. |
| `src/explorer/search.ts` | Pure helpers for the search panel: fuzzy name matching, text results as rows, highlighted segments. Unit-tested. |
| `src/plugins/builtin/explorer.tsx` | The explorer plugin: data validation, menus (`menu`, `optionsMenu`, hides Maximize and Move to tab), the `explorer.searchText` command, settings (striped rows). |
| `ExplorerPane.tsx` | Top folder, virtualized tree (`@tanstack/react-virtual`), selection, keyboard, inline rename/create, the search overlay. A row is: indent, chevron, 16px file icon (`FileIcon`, see [icons.md](icons.md)), name, git badge. |
| `useExplorerDrag.ts` | Dragging entries with pointer events (see [Drag and drop](#drag-and-drop)). |
| `ExplorerSearch.tsx` | ⌘F name search and ⌃⌘F text search (see [Search](#search)). |
| `ExplorerMenus.tsx` | Right-click items for entries (one or several) and for the explorer as a whole, the … menu items, trash confirmation, cut/copy/paste helpers. |

### State outside React

Like terminal sessions, an `ExplorerModel` outlives its component. The
pane `attach`es on mount and `detach`es on unmount; the registry disposes a
model once its pane is gone from the store and it is off screen. The
component reads `model.snapshot()` with `useSyncExternalStore`.

What survives a restart is written to the pane's `PaneData` (`root`,
`pinned`, `link`, `showHidden`, `expanded`) through `updatePaneData`
whenever it changes. Selection and the clipboard are not saved.

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

### Root and the top folder

There is no path header: the root is the top folder, a fixed row above
the tree (`~` for home, `/`, else its name; full path in its tooltip),
in a slightly larger, bold font. Its entries sit at depth 0 under it,
not indented. A pin or link icon follows the name. While the explorer
has focus, New file and New folder buttons show at its right (left of
the pane's hover controls); they create in `targetDir()`: the cursor if
it is a folder, else the cursor's folder, else the root. A click on the
top folder clears the selection; right-click gives the explorer menu;
it is a drop target for the root.

The root follows a terminal, chosen in **Link to terminal ›** (… menu
and right-click menu):

- **Last focused terminal** (the default): the terminal that last had
  focus in its tab (remembered per tab, since focus moves to the
  explorer as soon as it is used).
- **A terminal of the tab**, listed by its directory (numbered when two
  share one). Highlighting an item outlines that terminal
  (`onHighlight` → `highlightPane`). Saved as `link`; if that terminal
  closes or leaves the tab, the explorer goes back to the last focused
  one.
- **None (stay in this folder)**: pinned. "Show only this folder" and
  "Go to parent folder" also pin.

**Show hidden files** (… menu and right-click menu) is per explorer
(saved as `showHidden`); new explorers start without. Neither option is
in Settings any more; Settings → Explorer has **Striped rows**, which
shades every other row (`.is-stripe`).

### Menus

- … menu: Link to terminal ›, Show hidden files, then Settings…, a
  divider and the pane items without Maximize and Move to tab (see
  [plugins.md](plugins.md#commands-and-menus)).
- Right-click on the empty area or the top folder: New file, New folder,
  Paste, Link to terminal ›, Go to parent folder, Show hidden files,
  Collapse all, Refresh, Reveal in Finder, Open in new terminal, Copy
  path, then the pane items.
- Right-click on an entry: for the selection if the entry is in it
  (several: no Open/New/Rename items, counts in the labels), else that
  entry alone (which gets selected): Open / New…, Reveal in Finder,
  Cut, Copy, Paste (into a folder, or the file's folder), Duplicate,
  Copy path(s), Copy relative path(s), Rename…, Move to Trash.

### Selection

The model keeps a cursor (`selected`, what the keyboard acts on), a set
(`selection`) and an anchor for ranges. Click selects one; ⌘-click adds
or removes; ⇧-click (and ⇧ with the arrow, page and Home/End keys)
selects from the anchor, ⇧⌘-click adds a range. ⌘A selects every row
shown. Collapsing a folder deselects what it hides. Commands act on
`selectedPaths()`: the selected rows shown, in tree order, leaving out
any inside a selected folder (they go with it), or the cursor alone.

### Moving and copying

`transfer(paths, dir, "move" | "copy")`: moves with `fs_rename`
(refusing a folder into itself, skipping moves into the same folder;
open folders and the selection follow, and `renameOpenFiles` updates
panes showing moved files), copies with `fs_copy` (free Finder-style
names, never replacing). Afterwards `dir` is opened and what arrived is
selected. Errors are summed up in the error line. `duplicate` copies
next to the original. A move onto an existing name fails with an error
(no replace prompt), and so does a move to another volume (`rename`
does not cross file systems). What arrives is selected only if it is
in this explorer's tree.

Clipboard: ⌘C / ⌘X put the selection on the explorers' clipboard (paths
only; cut rows are dimmed), ⌘V pastes into `targetDir()` (a cut is moved
once, then the clipboard keeps only what failed to move, to retry). The system clipboard is untouched,
except ⌥⌘C, which copies the paths as text.

### Drag and drop

Pointer events, not HTML drag and drop (the window takes native file
drops). A press on a row that moves 4px starts a drag of the selection
(if the row is in it) or the row; a drag image follows the pointer.
Targets are found under the pointer by markup: `data-drop-dir` on rows
(a folder, or a file's folder), the top folder and the tree's empty area
(the root), in any explorer; a terminal pane on the same host gets the
POSIX paths typed in, shell-quoted (and is outlined; cross-host terminal
drops are refused). ⌥ copies instead of moving (a + on the drag image),
and dragging across different hosts always defaults to copy. Hovering a
closed folder 700 ms opens it; near a tree's top
or bottom edge it scrolls. Escape cancels; the click that ends a drag is
swallowed.

### Search

`ExplorerSearch` is an overlay over the pane: a bar slides down over the
top folder, and once there is a query, results cover the tree (the tree
stays usable while the query is empty). Escape closes it; the last
query per pane and mode comes back, selected, next time. ⌘F and ⌃⌘F
switch modes while it is open. ↑ ↓ Page Up/Down move, ↩ acts.

- **⌘F, names** (the app's `pane.find`, registered as the pane's `find`
  action): `fs_find_entries` lists up to 50,000 files and folders once
  (cached 30 s per root), filtered with fuzzysort on the name and the
  path (name matches weigh more; ties go to shallower paths). ↩ or a
  click reveals the entry in the tree and closes the search; ⌘↩ or
  ⌘-click opens a file and keeps the search open.
- **⌃⌘F, text** (`explorer.searchText`, the pane's `searchText`
  action): `fs_search_text` 200 ms after typing, the previous search
  cancelled; up to 2,000 matching lines, grouped by file. Toggles: match
  case (⌥⌘C), whole word (⌥⌘W), regular expression (⌥⌘R). ↩ or a click
  opens the file at the match (`openFile` with line and column); on a
  file row it collapses the file.

### Opening files

`openFile` in `src/actions.ts`: a pane already showing the file gets focus;
else an editor or viewer pane already in the tab gets the file (the last
active one if several, never an editor with unsaved changes; images go to
viewers only); with "Open in new pane", or if there is none, a new pane is
split off the roomiest non-explorer pane, along its longer side
(`addPaneBeside`). The path is `PaneData.path`. Renaming a file updates
panes showing it (`renameOpenFiles`), keeping their buffers. See
[editor.md](editor.md).

`openDirectory` in `src/actions.ts` (a folder ⌘-clicked in a terminal
opens a new explorer; `/open dir` reuses one) pins the tab's last active explorer to the folder, or, with
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
| ⇧ + the keys above | Extend the selection |
| ⌘A | Select all rows shown |
| ⌘C, ⌘X, ⌘V | Copy, cut, paste (into the cursor's folder) |
| ⌥⌘C | Copy the selected paths as text |
| ⌘F, ⌃⌘F | Find by name, search in files |
| Escape | Several selected: keep only the cursor |
| ⌘⌫ | Move local selection to Trash, or permanently delete remote SSH selection (asks) |
| letters | Type-ahead; repeating one letter cycles through names starting with it |

Mouse: a click selects (and toggles a directory), ⌘-click and ⇧-click
change the selection, a double click opens a file, a middle click opens
it in a new pane, a drag moves (see above).
