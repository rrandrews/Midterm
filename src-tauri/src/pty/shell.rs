//! Builds the command line and environment for a terminal's shell.

use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

/// A program chosen in the settings instead of the login shell.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CustomShell {
    pub program: String,
    pub args: Vec<String>,
}

/// The command for a new terminal in `cwd`: the user's login shell with
/// shell integration where supported (see `super::integration`), or
/// `custom` (from the settings) exactly as given, without integration.
pub fn shell_command(cwd: Option<&str>, custom: Option<&CustomShell>) -> CommandBuilder {
    if let Some(custom) = custom.filter(|custom| !custom.program.trim().is_empty()) {
        let mut cmd = CommandBuilder::new(custom.program.trim());
        cmd.args(&custom.args);
        apply_environment(&mut cmd, cwd);
        return cmd;
    }
    #[allow(unused_mut)]
    let mut cmd = base_command(cwd);
    #[cfg(unix)]
    super::integration::setup(&mut cmd);
    cmd
}

/// [`shell_command`] without the shell integration.
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
pub fn base_command(cwd: Option<&str>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new_default_prog();
    apply_environment(&mut cmd, cwd);
    cmd
}

/// The terminal environment and working directory every shell gets.
fn apply_environment(cmd: &mut CommandBuilder, cwd: Option<&str>) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "midterm");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));

    // Apps launched from Finder get no locale variables, and without a UTF-8
    // locale shells mangle non-ASCII input. The terminal always speaks UTF-8.
    #[cfg(target_os = "macos")]
    if !has_locale(cmd) {
        cmd.env("LANG", "en_US.UTF-8");
    }

    if let Some(dir) = resolve_cwd(cwd) {
        cmd.cwd(dir);
    }
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
        let cmd = shell_command(None, None);
        let env = |key: &str| cmd.get_env(key).and_then(|v| v.to_str());
        assert_eq!(env("TERM"), Some("xterm-256color"));
        assert_eq!(env("COLORTERM"), Some("truecolor"));
        assert_eq!(env("TERM_PROGRAM"), Some("midterm"));
        assert_eq!(env("TERM_PROGRAM_VERSION"), Some(env!("CARGO_PKG_VERSION")));
        assert!(base_command(None).is_default_prog());
    }

    #[test]
    fn runs_a_custom_shell_as_given() {
        let custom = CustomShell { program: "/bin/sh".into(), args: vec!["-i".into()] };
        let cmd = shell_command(None, Some(&custom));
        assert!(!cmd.is_default_prog());
        let argv: Vec<_> = cmd.get_argv().iter().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(argv, ["/bin/sh", "-i"]);
        assert_eq!(cmd.get_env("TERM_PROGRAM").and_then(|v| v.to_str()), Some("midterm"));

        let blank = CustomShell { program: "  ".into(), args: vec![] };
        assert!(shell_command(None, Some(&blank)).get_env("TERM").is_some());
    }

    #[test]
    fn uses_cwd_only_if_it_is_a_directory() {
        let home = std::env::home_dir();
        let tmp = std::env::temp_dir();

        assert_eq!(resolve_cwd(tmp.to_str()), Some(tmp.clone()));
        assert_eq!(resolve_cwd(None), home);
        assert_eq!(resolve_cwd(Some("")), home);
        assert_eq!(resolve_cwd(Some("/definitely/not/a/real/dir")), home);

        let cmd = shell_command(tmp.to_str(), None);
        assert_eq!(cmd.get_cwd().map(PathBuf::from), Some(tmp));
    }
}
