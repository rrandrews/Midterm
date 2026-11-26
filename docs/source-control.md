# Source Control

Midterm ships a built-in **Source Control** plugin (`id: "source-control"`, icon `git-branch`) with VS Code-style Git workflows and local + SSH remote parity (remote hosts require `python3` and `git`; the POSIX `sh` SSH fallback does not support `scm_*` commands).

## Source map

| Path | What lives there |
|---|---|
| `src-tauri/src/git/types.rs` | Wire types (`ScmStatus`, `ScmDiff`, `ScmBranch`, `ScmCommit`, `ScmCommitFile`, `ScmStash`, `ScmDiffMode`, `ConflictStrategy`). |
| `src-tauri/src/git/exec.rs` | Safe `git` runner (local `tokio::process::Command` and SSH helper dispatch), sanitized Git environment, C-locale message stabilization, bounded output/timeouts, and strict ref/path/hash/remote validators. |
| `src-tauri/src/git/parse.rs` | Parsers for NUL-delimited `status --porcelain=v2`, unified diffs (with CRLF preservation, C-quoted rename decoding, file-type-change handling, non-UTF-8 flagging, and line-count caps), `for-each-ref`, `log --decorate=full`, `commit_files`, and stashes. |
| `src-tauri/src/git/commands.rs` | 26 Tauri `scm_*` commands registered in `src-tauri/src/lib.rs`, plus Unix `openat`/`renameat` descriptor-confined untracked read & Trash staging. |
| `src-tauri/src/ssh/helper.py` | Remote `git_exec` (bounded streaming `Popen` with deadline across stdin/stdout/stderr/wait), `git_read_untracked`, and `git_remove_untracked` (`dir_fd` + `O_NOFOLLOW` + `.git` inode exclusion). |
| `src/ipc/scm.ts`, `src/ipc/scmMock.ts` | Typed wrappers over all `scm_*` commands + stateful in-memory browser/test mock. |
| `src/scm/tree.ts` | Path splitting, compacted folder tree builder (for List vs Tree view), single-hunk unified patch builder (`buildHunkPatch`), status badge tokens, and relative timestamps. |
| `src/scm/graph.ts` | Pure SVG commit-graph lane layout calculator (`computeGraphLayout`). |
| `src/scm/layout.ts` | Vertical accordion sizing & sash-drag calculations (`Changes`, `Graph`, `Stashes`) with `< 1.5 lines` auto-collapse and outward-drag re-expansion. |
| `src/scm/commitMessage.ts` | Default commit-message prompt (`DEFAULT_COMMIT_PROMPT`), custom prompt resolution, response fence/quote cleanup, and bounded (`24 KB`), abortable, secret-redacted diff context assembly (amend: HEAD + staged; normal: staged > unstaged+untracked; lockfile diffs skipped). |
| `src/scm/ScmSettingsSection.tsx` | Custom Settings → Source Control section for choosing the AI model profile (`settings.ai.features.commit`) from saved models and editing/resetting the commit message prompt. |
| `src/scm/model.ts` | Per-pane `ScmModel` (outside React), fs watching (`root`, `gitDir`, `refs/heads`), SSH reconnect recovery, cross-pane `notifyRepoChange` / `subscribeRepoChange` sync, accordion section weights, AI commit message streaming/cancellation, and all Git actions. |
| `src/scm/registry.ts` | `createPaneState` registry, terminal-following / linking logic (matching `src/explorer/explorers.ts`), and `openScmDiff` sibling diff pane manager. |
| `src/scm/SourceControlPane.tsx` | Sidebar view (commit composer defaulting to min height, right-aligned Generate/Amend/Undo, split Commit/Sync/Publish button, 3-pane resizable Changes/Graph/Stashes accordion with nested Merge Conflicts/Staged/Unstaged groups, bottom branch & sync bar) and diff-mode router. |
| `src/scm/DiffView.tsx` | Interactive Diff Viewer pane (`ScmDiffPane`): Unified and Side-by-Side (Split) layouts, word-level inline highlights (`diffWordsWithSpace`), prev/next hunk navigation, Stage Hunk / Unstage Hunk / Revert Hunk actions, and Open File in Editor. |
| `src/scm/BranchPicker.tsx` | Searchable branch switcher popover with inline branch creation, rename, merge, and delete (with unmerged force-delete fallback). |
| `src/scm/CommitGraph.tsx` | Resizable Graph accordion pane with compact relative timestamps (no `"ago"`), non-local ref pills on title rows, continuous vertical SVG rails alongside expanded commit details, SHA copy, and changed-file commit diff links. |
| `src/scm/StashList.tsx` | Collapsible Stashes section with inline stash creation (optional message + include untracked), Pop / Apply / Drop actions, and expandable stash file diffs. |
| `src/scm/menus.ts`, `src/scm/skills.ts`, `src/scm/plugin.tsx` | Pane options/context menus, AI `source-control.git` read skill (`status`, `diff`, `log`, `branches`), commands (`Ctrl+Shift+G`, generate commit message), declarative settings, and custom `ScmSettingsSection`. |
| `src/styles/scm.css` | Theme-token styles for sidebar headers, buttons, and diff highlights (dark & light compatible). |

## Dual-mode pane architecture

A `source-control` pane works in two modes determined by `pane.data.diffTarget`:

- **Sidebar mode** (`diffTarget` unset): follows the focused or linked terminal (unless pinned), displays icon-only subtabs (`subtabIconOnly` predicate), and hosts the full repository sidebar.
- **Diff viewer mode** (`diffTarget` set): displays a descriptive subtab label such as `Header.tsx (Working Tree)`, `Header.tsx (Staged)`, or `Header.tsx (a1b2c3d)`, stays in sync with sidebar mutations via `subscribeRepoChange`, and is reused by `openScmDiff` when clicking subsequent files without squeezing the sidebar.

## Security & correctness invariants

- **No shell execution**: Local and remote Git invocations pass explicit argument arrays (`--literal-pathspecs`, `-c core.quotepath=false`, `--no-textconv` on patch diffs, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` on reads, `LC_MESSAGES=C` / `LANGUAGE=C` while preserving `LC_CTYPE`).
- **Input validation**: Ref names, repo-relative paths (rejecting traversal and case-insensitive `.git`), commit hashes, stash refs, and configured remote names are validated before running Git.
- **Confined untracked reads & discards**: Local Unix operations walk ancestors via `openat(..., O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)`, verify no component aliases `git_dir`, and atomically claim files via `renameat` into a private `0700` staging directory before calling Trash. Remote operations use matching `dir_fd` + `O_NOFOLLOW` confinement in `helper.py` and re-verify untracked status before unlinking.
- **Atomic commit undo**: `scm_undo_last_commit` captures `HEAD`'s OID and symbolic ref up front, inspects that exact commit object's `parent` headers (`cat-file -p`), and performs a compare-and-swap `git update-ref` conditioned on the inspected OID.
- **Safe hunk patching**: `ScmDiff.patchable` is false whenever a diff is binary, truncated/over the line cap (`MAX_DIFF_LINES`), non-UTF-8, or a file-type change; hunk Stage/Unstage/Revert controls are disabled in those cases while file-level actions remain available.
