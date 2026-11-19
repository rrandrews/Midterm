//! Pseudo-terminal backend.
//!
//! * [`session`] – one child process on a PTY and the threads that stream
//!   its output, with flow control. Independent of Tauri.
//! * [`manager`] – the id -> session registry held in Tauri managed state.
//! * [`shell`] – which program to run and with what environment.
//! * `integration` – shell integration scripts (OSC 7) and how each shell is
//!   made to load them (Unix).
//! * [`commands`] – the `pty_*` Tauri commands exposed to the frontend.

pub mod commands;
#[cfg(unix)]
pub mod integration;
pub mod manager;
pub mod session;
pub mod shell;

#[cfg(test)]
mod tests;

pub use manager::PtyManager;
