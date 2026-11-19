//! File system and git backend for the explorer, editor and viewer panes.
//!
//! * [`list`] – directory listings (with ignore rules) and single-path stats.
//! * [`ops`] – create, rename, move to trash.
//! * [`file`] – whole-file reads and atomic writes for editors and viewers.
//! * [`git`] – work tree status.
//! * [`watch`] – debounced, non-recursive directory watchers and their
//!   registry in Tauri managed state.
//! * [`commands`] – the `fs_*` and `git_status` Tauri commands.
//!
//! Everything but `commands` is independent of Tauri and unit-tested.

pub mod commands;
pub mod file;
pub mod git;
pub mod list;
pub mod ops;
pub mod watch;

pub use watch::WatchManager;
