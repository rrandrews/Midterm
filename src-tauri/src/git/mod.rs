//! Source Control (Git) backend for the Source Control pane plugin.
//!
//! Dispatches seamlessly over local work trees (`tokio::process::Command`) and
//! remote SSH hosts (`SshManager::git_exec`), reusing one set of pure Rust
//! parsers (`parse`) and strict input validators (`exec`).

pub mod commands;
pub mod exec;
pub mod parse;
pub mod types;

#[cfg(test)]
mod tests;
