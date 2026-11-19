# Command palette

⌘K (or the title bar's command button) opens one fuzzy list of commands,
tabs, workspaces and files, plus "run this in a new terminal". ⌘P opens
it for files only, ⇧⌘P for commands only.

| File | Role |
|---|---|
| `src/palette/items.ts` | Pure: query parsing and ranking (fuzzysort). Unit-tested. |
| `src/palette/sources.ts` | Project root and the file list (cached 15 s). |
| `src/palette/recent.ts` | Recent files (recorded by `openFile`) and commands, saved to `recent.json`. |
| `src/palette/state.ts` | Open state, the palette commands, carrying out a chosen item. |
| `src/palette/Palette.tsx` | The dialog: Radix Dialog + cmdk (cmdk's own filtering is off; ranking is ours). |

## Query

| Typed | Lists |
|---|---|
| nothing | recent commands and files, then every command |
| text | best-matching groups first: commands, tabs (all workspaces), workspaces, files; "Run … in a new terminal" last |
| `> text` | commands only |
| `$ text` | only "run `text` in a new terminal" |

Disabled and hidden commands are left out. Recently used matches get a
small score boost. In files mode (⌘P) only files are listed (`>` still
switches to commands).

## Files

The root is the git work tree containing the active pane's directory (a
terminal's cwd, an explorer's root, an open file's folder; else any pane
in the tab), or that directory outside a repository. The home directory
and `/` are never used as roots. Files come from `fs_find_files` (ignore
crate: hidden files and ignored paths are skipped, symlinks not followed,
capped at 50 000, sorted). A file name match ranks above one spread over
the directories.

## Running a command

"Run" splits a terminal off the active pane in its directory and types
the command into the new shell (`queueStartupInput` in
`src/terminal/sessions.ts`; input waits until the shell is running).

## Focus

The dialog has `data-owns-keyboard`, which suspends app shortcuts while
it is open (⌘K inside it closes it). On close, focus returns to the
wanted pane; the chosen action runs on the next frame, after the dialog
has gone, so actions that ask (close pane) can open their own dialog.
