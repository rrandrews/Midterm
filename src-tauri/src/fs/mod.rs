//! File system and git backend for the explorer, editor and viewer panes.
//!
//! * [`list`] – directory listings (with ignore rules) and single-path stats.
//! * [`ops`] – create, rename, move to trash.
//! * [`copy`] – copy a file or tree into a directory, never replacing.
//! * [`find`] – every file (or file and directory) under a root, for fuzzy
//!   file open and name search.
//! * [`search`] – streaming text search (ripgrep's crates) and the registry
//!   of running searches in Tauri managed state.
//! * [`file`] – whole-file reads and atomic writes for editors and viewers.
//! * [`git`] – work tree status.
//! * [`complete`] – `PATH` executables and directory entries for tab
//!   completion in the blocks input editor.
//! * [`watch`] – debounced, non-recursive directory watchers and their
//!   registry in Tauri managed state.
//! * [`commands`] – the `fs_*` and `git_status` Tauri commands.
//!
//! Everything but `commands` is independent of Tauri and unit-tested.

pub mod commands;
pub mod complete;
pub mod copy;
pub mod find;
pub mod file;
pub mod git;
pub mod list;
pub mod ops;
pub mod search;
pub mod watch;

pub use copy::TransferManager;
pub use search::SearchManager;
pub use watch::WatchManager;
