//! File system and git backend for the explorer pane.
//!
//! * [`list`] – directory listings (with ignore rules) and single-path stats.
//! * [`ops`] – create, rename, move to trash.
//! * [`find`] – every file under a root, for fuzzy file open.
//! * [`git`] – work tree status.
//! * [`watch`] – debounced, non-recursive directory watchers and their
//!   registry in Tauri managed state.
//! * [`commands`] – the `fs_*` and `git_status` Tauri commands.
//!
//! Everything but `commands` is independent of Tauri and unit-tested.

pub mod commands;
pub mod find;
pub mod git;
pub mod list;
pub mod ops;
pub mod watch;

pub use watch::WatchManager;
