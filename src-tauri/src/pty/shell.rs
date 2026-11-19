//! Builds the command line and environment for a terminal's shell.

use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

/// The user's shell, started as a login shell in `cwd`.
///
/// `CommandBuilder::new_default_prog` does the platform work:
///
/// * Unix: runs `$SHELL` if it is executable, else the shell from the
///   password database, else `/bin/sh`, with `argv[0]` set to `-<name>`
///   (e.g. `-zsh`). That is the convention `login(1)` and other terminal
///   emulators use to request a login shell and, unlike a `-l` flag, every
///   shell understands it. A login shell is what gives the right `PATH` when
///   the app is launched from Finder rather than from another shell.
/// * Windows: runs `%ComSpec%`, falling back to `cmd.exe`.
///
/// The process environment is inherited.
pub fn shell_command(cwd: Option<&str>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new_default_prog();
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "midterm");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));

    // Apps launched from Finder get no locale variables, and without a UTF-8
    // locale shells mangle non-ASCII input. The terminal always speaks UTF-8.
    #[cfg(target_os = "macos")]
    if !has_locale(&cmd) {
        cmd.env("LANG", "en_US.UTF-8");
    }

    if let Some(dir) = resolve_cwd(cwd) {
        cmd.cwd(dir);
    }
    cmd
}

/// `cwd` if it names an existing directory, otherwise the home directory.
fn resolve_cwd(cwd: Option<&str>) -> Option<PathBuf> {
    cwd.map(Path::new)
        .filter(|dir| dir.is_dir())
        .map(Path::to_path_buf)
        .or_else(std::env::home_dir)
}

#[cfg(target_os = "macos")]
fn has_locale(cmd: &CommandBuilder) -> bool {
    ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .any(|key| cmd.get_env(key).is_some_and(|value| !value.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_terminal_environment() {
        let cmd = shell_command(None);
        assert!(cmd.is_default_prog());
        let env = |key: &str| cmd.get_env(key).and_then(|v| v.to_str());
        assert_eq!(env("TERM"), Some("xterm-256color"));
        assert_eq!(env("COLORTERM"), Some("truecolor"));
        assert_eq!(env("TERM_PROGRAM"), Some("midterm"));
        assert_eq!(env("TERM_PROGRAM_VERSION"), Some(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn uses_cwd_only_if_it_is_a_directory() {
        let home = std::env::home_dir();
        let tmp = std::env::temp_dir();

        assert_eq!(resolve_cwd(tmp.to_str()), Some(tmp.clone()));
        assert_eq!(resolve_cwd(None), home);
        assert_eq!(resolve_cwd(Some("")), home);
        assert_eq!(resolve_cwd(Some("/definitely/not/a/real/dir")), home);

        let cmd = shell_command(tmp.to_str());
        assert_eq!(cmd.get_cwd().map(PathBuf::from), Some(tmp));
    }
}
