# Editor and viewer panes

An **editor** pane edits one text file in CodeMirror 6. A **viewer** pane
shows one file: rendered Markdown, an image, or (for any other text) the
file read-only in CodeMirror. Both read and write through the Rust backend.

## Backend (`src-tauri/src/fs/file.rs`)

Pure functions, unit-tested with temp dirs; `commands.rs` has the thin
`async` adapters (blocking pool, like the explorer's commands).

| Command | Arguments (JS names) | Result |
|---|---|---|
| `fs_read_text` | `path` | `TextFile`: `{ kind: "text", text, version }`, or `{ kind: "binary" \| "tooLarge", version }`. Rejects if the file cannot be read (missing, a directory…). |
| `fs_read_bytes` | `path` | The raw bytes as an `ArrayBuffer` (`tauri::ipc::Response`, not JSON). Rejects above 64 MiB. |
| `fs_write_text` | `path`, `text`, `expected` | `WriteResult`: `{ kind: "written", version }` or `{ kind: "conflict", current }` (nothing written). |
| `fs_file_version` | `path` | `FileVersion` or `null` if no file is there (missing, or a directory). |

- `FileVersion` is `{ mtime, size }`; `mtime` is fractional milliseconds
  since the epoch. Change detection compares both (`sameVersion` in
  `src/ipc/fs.ts`).
- Text: files over 16 MiB are `tooLarge`; a NUL byte in the first 8000
  bytes (git's heuristic) or invalid UTF-8 means `binary`. So Latin-1 and
  UTF-16 files are not opened as text.
- Writing: with `expected`, the file must still be that version (and
  exist), else it is a conflict. With `expected: null` it is written
  regardless and created if missing (the directory must exist). The write
  goes to a temp file in the same directory (`.midterm-save-*.tmp`), is
  synced, gets the old file's permissions (new files 0644), and is renamed
  over the file. Symlinks are written through (the target is replaced, the
  link kept). If the directory is not writable, the file is overwritten in
  place. Replacing the file breaks hard links and drops extended attributes
  and ACLs.
- The check and the write are not one atomic step: a change landing in
  between is overwritten.

`src/ipc/fs.ts` wraps these (`readTextFile`, `readFileBytes`,
`writeTextFile`, `fileVersion`); `src/ipc/fsMock.ts` implements them over
its in-memory tree for `bun run dev` (it has contents for `SplitNode.tsx`,
`README.md`, `package.json`, `docs/logo.svg` and a binary `docs/data.bin`).

## Frontend

| File | Role |
|---|---|
| `src/editor/model.ts` | `EditorModel`: one pane's CodeMirror view, disk version, dirty state, external changes, save. Also used read-only by text viewers. |
| `src/editor/registry.ts` | Models by pane id (editors and viewers), reconciled against the store; pending line reveals; unsaved-changes queries; renames; font settings. |
| `src/editor/text.ts` | Pure: line endings and BOM, `minimalChange`, indent detection, breadcrumb segments, position clamping. Unit-tested. |
| `src/editor/languages.ts` | Language by file name (`@codemirror/language-data`, loaded on demand). |
| `src/editor/highlight.ts` | Syntax highlighting as `tok-*` classes (styled in `src/styles/editor.css`). |
| `src/editor/commands.ts` | `editor.revert` ("Revert file"). |
| `src/viewer/model.ts` | `ViewerModel`: rendered Markdown or an image blob URL, reloaded on change, scroll position. |
| `src/viewer/markdown.ts` | `marked` (GFM) → DOMPurify. |
| `src/viewer/links.ts` | Pure: where a link or image in a document points. Unit-tested. |
| `src/files/watch.ts` | One backend watcher shared by all open files (watches their parent directories). |
| `src/files/repoRoot.ts` | Nearest ancestor with a `.git` entry, cached; for breadcrumbs. |
| `src/files/kinds.ts` | Images (with MIME types), Markdown, viewer mode by extension. |
| `src/components/panes/FilePane.tsx` | The editor and viewer components: breadcrumbs, notices, status messages, Markdown and image views. |
| `src/components/panes/FileMenuItems.tsx` | Right-click items: save, revert, find, go to line, reveal, copy path. |
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
    into the undo history.
  - Dirty buffer: a notice under the breadcrumb, "Changed on disk",
    with **Reload** (replace the buffer, undoable) and **Keep mine**
    (adopt the disk version as the base, so the next save overwrites
    without asking).
  - Deleted: the buffer is kept and a notice says saving creates the file
    again.
- Saving (⌘S) sends the base version as `expected`. A conflict asks
  ("changed on disk… Save anyway?") and, if confirmed, writes with
  `expected: null`. Errors show in the notice row.
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
once the file is loaded and on screen. Renames update models in place
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
- Image sources are moved to `data-src` during sanitizing so nothing is
  fetched by the webview. The view resolves them against the document's
  directory and reads local files through `fs_read_bytes` into blob URLs
  (cached per document, revoked on reload and dispose). `data:image/…`
  URLs are kept; remote images are not loaded (the CSP planned for M7
  allows only `blob:` and `data:` images).
- Links: http(s) open in the browser (`openExternal`); `#heading` scrolls
  to the heading with that GitHub-style slug; other Markdown files open in
  the same viewer; any other file goes through `openFile` (⌘-click: new
  pane), with `#L12` as a line.
- **Images** are centred on a faint checkerboard; the file name (and
  pixel size) is shown top right in 10.5px mono, moving aside for the pane
  controls.
- Viewers reload when the file changes on disk. Scroll position survives
  remounts.

## Terminal links (`src/terminal/fileLinks.ts`, `fileLinkProvider.ts`)

A link provider registered on each terminal (`registerFileLinks` in
`session.ts`) turns file references in output into links; ⌘-click (or
Ctrl-click) opens the file with `openFile` from the terminal's pane, at the
line and column given.

- `findFileLinks` (pure, unit-tested) finds tokens that look like files
  (contain a `/` or end in an extension), with an optional position:
  `path:line`, `path:line:col` (trailing colon allowed), tsc's
  `path(line,col)` and Python's `File "path", line N`. URLs, numbers,
  versions, times and flags are skipped; trailing sentence punctuation is
  dropped.
- The line is read across soft-wrapped rows, cell by cell, so wide
  characters keep the mapping from string index to cell right.
- Paths are resolved against the session's current directory (OSC 7), `~`
  against the home directory. Only existing files become links; stats are
  cached (10 s for hits, 3 s for misses, at most 2000 entries).
