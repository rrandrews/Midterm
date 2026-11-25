# Editor and viewer panes

An **editor** pane edits one text file in CodeMirror 6. A **viewer** pane
shows one file: rendered Markdown, an image, or (for any other text) the
file read-only in CodeMirror. Both read and write through the Rust backend.

## Backend (`src-tauri/src/fs/file.rs`)

Pure functions, unit-tested with temp dirs; `commands.rs` has the thin
`async` adapters (blocking pool, like the explorer's commands).

| Command | Arguments (JS names) | Result |
|---|---|---|
| `fs_read_text` | `path` | `TextFile`: `{ kind: "text", text, version }`, or `{ kind: "binary" \| "tooLarge", version }`. Rejects if it is not a readable regular file (missing, a directory, a FIFO…). |
| `fs_read_bytes` | `path` | The raw bytes as an `ArrayBuffer` (`tauri::ipc::Response`, not JSON). Rejects above 64 MiB. |
| `fs_write_text` | `path`, `text`, `expect` | `WriteResult`: `{ kind: "written", version }` or `{ kind: "conflict", current }` (nothing written). `expect` is `{ kind: "version", version }`, `{ kind: "absent" }` or `{ kind: "any" }`. |
| `fs_file_version` | `path` | `FileVersion` or `null` if no file is there (missing, or a directory). |

- `FileVersion` is `{ mtime, size }`; `mtime` is nanoseconds since the
  epoch as a decimal string (a JSON number would not round-trip exactly).
  Change detection compares both (`sameVersion` in `src/ipc/fs.ts`).
- Text: files over 16 MiB are `tooLarge`; a NUL byte in the first 8000
  bytes (git's heuristic) or invalid UTF-8 means `binary`. So Latin-1 and
  UTF-16 files are not opened as text.
- Reading opens the file non-blocking and checks the handle is a regular
  file, so a FIFO or device never hangs a worker.
- Writing: `version` requires the file at that version; `absent` requires
  no file (used to recreate a deleted file without clobbering one that
  reappeared); `any` writes regardless. Missing files are created (the
  directory must exist). The write goes to a temp file in the same
  directory (`.midterm-save-*.tmp`), is synced, gets the old file's
  permissions (a new file: 0666 less the umask), and is renamed over the
  file. Symlinks are written through, also to a missing target (the link
  is kept). If the directory is not writable, the file is overwritten in
  place. Replacing the file breaks hard links and drops extended attributes
  and ACLs.
- Saves are serialized by a process-wide lock, so two panes saving one
  file cannot both pass the check. A change by another program between
  the check and the rename is still overwritten.

`src/ipc/fs.ts` wraps these (`readTextFile`, `readFileBytes`,
`writeTextFile`, `fileVersion`); `src/ipc/fsMock.ts` implements them over
its in-memory tree for `bun run dev` (it has contents for `SplitNode.tsx`,
`README.md`, `package.json`, `docs/logo.svg` and a binary `docs/data.bin`).

## Frontend

| File | Role |
|---|---|
| `src/editor/model.ts` | `EditorModel`: one pane's CodeMirror view, disk version, dirty state, external changes, save. Also used read-only by text viewers. |
| `src/editor/registry.ts` | Models by pane id (editors and viewers), a shared pane state (`src/plugins/paneState.ts`); pending line reveals; unsaved-changes queries; renames; font and editor settings. |
| `src/editor/settings.ts` | The editor plugin's settings (word wrap, tab size, line numbers) and the viewer's (Markdown rendered or as source). |
| `src/editor/text.ts` | Pure: line endings and BOM, `minimalChange`, indent detection, breadcrumb segments, position clamping. Unit-tested. |
| `src/editor/languages.ts` | Language by file name (`@codemirror/language-data`, loaded on demand). |
| `src/editor/highlight.ts` | Syntax highlighting as `tok-*` classes (styled in `src/styles/editor.css`). |
| `src/viewer/model.ts` | `ViewerModel`: rendered Markdown or an image blob URL, reloaded on change, scroll position. |
| `src/viewer/markdown.ts` | `marked` (GFM) → DOMPurify. |
| `src/viewer/links.ts` | Pure: where a link or image in a document points. Unit-tested. |
| `src/files/watch.ts` | One backend watcher shared by all open files (watches their parent directories). |
| `src/files/repoRoot.ts` | Nearest ancestor with a `.git` entry, cached; for breadcrumbs. |
| `src/files/kinds.ts` | Images (with MIME types), Markdown, viewer mode by extension. |
| `src/plugins/builtin/files.tsx` | The editor and viewer plugins: data, `fileHandler` (text → editor by default, viewer as an option; images → viewer), `reveal`, close checks, `editor.revert`. |
| `src/components/panes/FilePane.tsx` | `EditorPane` and `ViewerPane`, over a shared model host. |
| `src/components/panes/CodeView.tsx` | CodeMirror view with breadcrumbs and notices (editors, and text in viewers). |
| `src/components/panes/DocumentView.tsx` | Rendered Markdown and images. |
| `src/components/panes/FileStatus.tsx` | Status messages and the no-file state. |
| `src/editor/menu.ts` | Right-click items: save, revert, find, go to line, reveal, copy path. |
| `src/styles/editor.css` | CodeMirror chrome, syntax colours, Markdown body, image checkerboard. |

### State outside React

Same rule as terminals and explorers ([architecture.md](architecture.md)):
`acquireFileModel(paneId, kind, path)` returns the pane's model, creating
it if needed; the component attaches it on mount and releases it on
unmount. The registry disposes a model once no pane with its id, kind and
path is in the store and no component holds it. An `EditorModel` owns a
host element with the `EditorView` in it; mounting moves that element into
the pane, so undo history, selection, the search panel and unsaved changes
survive tab switches and re-docks. The scroll position is restored with
`view.scrollSnapshot()`.

Which model a pane gets: editors an editable `EditorModel`; viewers a
`ViewerModel` for Markdown (`.md`, `.markdown`…) and images (png, jpeg,
gif, webp, svg, bmp, ico, avif), and a read-only `EditorModel` for anything
else. Changing a pane's kind or file makes a new model.

Nothing new is persisted: the pane's `path` (already in `PaneData`) is all
that survives a restart. Unsaved changes do not survive one, which is why
quitting asks.

### Loading, dirty state, external changes

- On load the text is split from its BOM and line ending (taken from the
  first line break); saving writes both back. Indentation (tabs or the
  smallest space indent) is detected for `indentUnit`.
- Dirty means the document differs from the one last loaded or saved
  (`Text.eq`), so undoing back to the saved text clears it. The breadcrumb
  shows a dot.
- Each open file's parent directory is watched; a report makes the model
  stat the file (`fs_file_version`) and compare with the version its buffer
  is based on. Also checked when a pane is mounted, and after each save
  (reports during a save are skipped, since the save itself causes one).
  - Clean buffer: reloaded silently, as the smallest single change
    (`minimalChange`), so the cursor and scroll position stay. It goes
    into the undo history. If the user types while the file is being
    read, the edits are kept and the "changed on disk" notice shown
    instead. A save cancels any reload in flight.
  - Dirty buffer: a notice under the breadcrumb, "Changed on disk",
    with **Reload** (replace the buffer, undoable) and **Keep mine**
    (adopt the disk version as the base, so the next save overwrites
    without asking).
  - Deleted: the buffer is kept and a notice says saving creates the file
    again.
- Saving (⌘S) expects the base version (or `absent` for a file known to
  be deleted). A conflict asks ("changed on disk… Save anyway?") and, if
  confirmed, writes with `any`. Errors show in the notice row.
- A file that is missing, binary, too large or unreadable shows a message
  instead of the editor, and is tried again when the watcher reports a
  change.

### Commands and keys

The pane registers `find`, `findNext`, `findPrevious`, `goToLine` and (if
editable) `save` with `registerPaneActions` while its file is showing, so
⌘F, ⌘G, ⇧⌘G, ⌃G and ⌘S (`src/commands/core.ts`) reach CodeMirror's
search panel (top of the pane) and go-to-line dialog. Other keys (⌘Z, ⌘A,
Tab to indent, ⌘/ to comment…) are CodeMirror's default, search, history
and close-brackets keymaps. "Revert file" (`editor.revert`) is a palette
command.

### Opening files

`openFile(path, { fromPaneId, newPane, line, column })` in
`src/actions.ts`, used by the explorer, Markdown links and terminal links:

1. A pane of a suitable kind already showing the file gets focus.
2. Else an editor (for text; viewers for images) in the tab gets the file:
   the last active one, but **never one with unsaved changes**; if every
   editor has unsaved changes the file opens in a new editor pane. Nobody
   is asked and nothing is lost.
3. Else (or with `newPane`) a new pane is split off.

`line`/`column` are handed to `revealInPane`, which moves the cursor there
once the file is loaded and on screen. With a line only editors are
considered (a rendered Markdown viewer cannot show one). Renames update models in place
(`renameOpenModels`, from `renameOpenFiles`), keeping their buffers.

### Closing

`src/closing.ts` asks before closing anything holding running programs or
unsaved changes: one question naming both (`closePromptMessage` in
`src/closePrompt.ts`). Covers closing a pane, tab, several tabs, a
workspace, the window and quitting, and changing a pane's type. There is
no "Save" button in that dialog; save first.

### Breadcrumbs

28px row, 11.5px, `fg-dim` with the file name in `fg-soft`: the path
relative to the file's repository (nearest ancestor with `.git`), else from
`~`, else from `/`. The full path is the tooltip.

## Viewer

- **Markdown** is rendered with `marked` (GitHub-flavoured) and sanitized
  with DOMPurify (`<style>`, forms and inline `style` dropped). Styles from
  the mockup: 18px h1, 12.5px h2 in `fg-soft`, body `fg-muted` at line
  height 1.6.
- Nothing in the rendered HTML loads by itself: media, embeds, inline SVG
  and the like are dropped, and every resource attribute (`src`,
  `srcset`, `poster`, non-link `href`…) is removed, except that an image's
  source is kept in `data-src`. The view resolves them against the document's
  directory and reads local files through `fs_read_bytes` into blob URLs
  (cached per document, revoked on reload and dispose). `data:image/…`
  URLs are kept; remote images are not loaded (the CSP planned for M7
  allows only `blob:` and `data:` images).
- Links: http(s) open in the browser (`openExternal`); `#heading` scrolls
  to the heading with that GitHub-style slug; other Markdown files open in
  the same viewer; any other file goes through `openFile` (⌘-click: new
  pane), with `#L12` as a line. `file:` links (which DOMPurify would
  strip) are kept in `data-file-href`.
- Embedded images are resolved again on every reload of the document.
- **Images** are centred on a faint checkerboard; the file name (and
  pixel size) is shown top right in 10.5px mono, moving aside for the pane
  controls.
- Viewers reload when the file changes on disk. Scroll position survives
  remounts.

## Terminal links (`src/terminal/fileLinks.ts`, `pathTargets.ts`, `fileLinkProvider.ts`)

Files and folders named in terminal output are links, in both views of a
terminal: the classic xterm view (a link provider registered on each
terminal, `registerFileLinks` in `session.ts`) and the blocks view
(`OutputLine` in `BlocksView.tsx`, which looks a line up the first time
the pointer enters it and wraps the names in `.block-link` spans,
splitting styled runs with `splitAtLinks`). Hovering one underlines it.

- A click (`clickPath`) opens a file with `openFile`, at the line and
  column given, or `cd`s the shell to a folder (`changeDirectory`: `cd
  ./sub` inside the shell's directory, so `CDPATH` and names like `-P`
  cannot change it, else the absolute path; quoted with `shellQuoteArg`,
  sent with `runFromBlocks`). Only when `canChangeDirectory`: the shell is
  idle at a prompt of this machine, the foreground process is the shell
  (bash's `(cat)` has no command mark), and no command is being written
  (input editor draft or typed shell line), which the `cd` would discard.
  Paths with a backslash or control character are not sent (typed as
  keys, a tab would complete). Otherwise the click does nothing.
  ⌘-click (or Ctrl-click) opens either in a new pane: a file in a new
  editor or viewer, a folder in a new explorer pinned to it
  (`openDirectory` in `src/actions.ts`; Finder without the explorer
  plugin). Only a main-button click released where it was pressed counts
  (in the classic view xterm activates links on any button and reports a
  drag's selection only after activating, so the press position is
  tracked); a program reading the mouse (vim) gets plain clicks.
- A right click on one opens the link's own menu instead of the pane's:
  Open file / Change to this folder, Open in new pane, Open in default
  application (`fs_open_default`: the opener plugin's Rust API, absolute
  existing regular files and directories only, so the webview needs no
  open-path scope), Reveal in Finder, Copy file (folder) name, Copy full
  path (`pathMenuItems`). `TerminalPane` prevents the default on that
  `contextmenu` (which keeps the pane's Radix menu closed) and opens a
  dropdown at the pointer. Which link: hover records it per pane and view
  (`setHoveredPath`); `pathUnderPointer` takes it if the click was in the
  same view (in the blocks view, on a `.block-link`). It is taken on the
  right button press (pointerdown, capture phase), because xterm moves its
  text field under the pointer on that press, which ends the link's hover
  before `contextmenu` arrives. A program reading the mouse gets the right
  click unless ⌥ is held, as for the pane menu.
- Tooltips: the app's tooltip (`AnchoredTip` in `Tooltip.tsx`, a
  controlled Radix tooltip over a rectangle) shows the `~`-relative path
  and what a click (only if it would do something now) and a ⌘-click do,
  after 350 ms of hover (at once when
  moving to the next link). One at a time, from a small store in
  `pathTargets.ts` (`scheduleTip`, `hideTip`), rendered by `PathTip` in
  `TerminalPane`; hidden on leave, any button press, key, wheel or while
  the link menu is open. The classic view places it over the link's cells
  (`linkRect`, from xterm's cell size), the blocks view over the span's
  first line box.
- `findFileLinks` (pure, unit-tested) finds tokens that look like files
  (contain a `/` or end in an extension), with an optional position:
  `path:line`, `path:line:col` (trailing colon allowed), tsc's
  `path(line,col)` and Python's `File "path", line N`. URLs, numbers,
  versions, times and flags are skipped; trailing sentence punctuation is
  dropped. With `names: true` (what terminals use) bare names count too
  (`Makefile`, `src`, as `ls` prints them). A trailing `/` is dropped from
  the path but kept in the range; `tool*` and `link@` are tried as written,
  then without the marker (`unmarked`).
- The line is read across soft-wrapped rows, cell by cell, so wide
  characters keep the mapping from string index to cell right.
- `findPathLinks` resolves relative names against a list of directories,
  first that exists wins, `~` against the home directory. A block's output
  (`blockDirectories`) tries the shell's directory after the command (the
  next block's, or the current one), then where it started, so
  `cd x && ls` resolves in `x`. The classic view finds the block a row
  belongs to (`TerminalSession.linkDirectories`); a row outside any
  tracked block's output (a prompt, output from before a `clear`) uses
  the directory the next command started in, and rows after the last
  block the current one. Only what exists becomes a link; stats are
  cached (10 s for hits, 3 s for misses, at most 2000 entries), and the
  blocks view looks a line up again on each hover. Nothing links in a
  nested shell's (ssh) output (`host` or `nested` set). Known limit: names
  are split at whitespace, so `My Report.txt` in `ls` output can link only
  its `Report.txt` part (if that exists).
