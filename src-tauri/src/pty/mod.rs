//! Pseudo-terminal backend.
//!
//! * [`session`] – one child process on a PTY and the threads that stream
//!   its output, with flow control. Independent of Tauri.
//! * [`manager`] – the id -> session registry held in Tauri managed state.
//! * [`shell`] – which program to run and with what environment.
//! * [`commands`] – the `pty_*` Tauri commands exposed to the frontend.

pub mod commands;
pub mod manager;
pub mod session;
pub mod shell;

#[cfg(test)]
mod tests;

pub use manager::PtyManager;
