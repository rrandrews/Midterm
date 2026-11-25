//! Builds the command line and environment for a terminal's shell.

use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;
use serde::Deserialize;

/// A program chosen in the settings instead of the login shell.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CustomShell {
    pub program: String,
    pub args: Vec<String>,
}

/// One environment variable for a new shell (from the workspace settings).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

/// The Python environment a new shell starts in.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonEnv {
    /// `venv` or `conda`; anything else is ignored.
    pub kind: String,
    /// The venv directory, or the conda environment's name.
    pub target: String,
}

/// What the workspace adds to a new shell's environment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SpawnEnv {
    /// User variables, secrets included (already resolved), applied in order.
    pub vars: Vec<EnvVar>,
    pub python: Option<PythonEnv>,
}

/// Names the shell can take as an environment variable.
fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Midterm's own names: `MIDTERM_*` (set for the integration) and
/// `_midterm*` (the integration scripts' variables, such as their load
/// guard, which would switch the integration off). Mirrors
/// `reservedEnvName` in src/settings/schema.ts.
fn reserved_name(name: &str) -> bool {
    name.to_ascii_uppercase().starts_with("MIDTERM_") || name.to_ascii_lowercase().starts_with("_midterm")
}

impl SpawnEnv {
    /// The user's variables go on top of the terminal environment but
    /// before the shell integration is set up, which therefore always wins
    /// (and sees the user's `ZDOTDIR` & co. as the originals). Invalid
    /// names, Midterm's own names (`reserved_name`) and values with a NUL
    /// are skipped.
    fn apply_vars(&self, cmd: &mut CommandBuilder) {
        for var in &self.vars {
            if !valid_env_name(&var.name) || reserved_name(&var.name) || var.value.contains('\0') {
                eprintln!("pty: environment variable {:?} skipped", var.name);
                continue;
            }
            cmd.env(&var.name, &var.value);
        }
    }

    /// Hands the Python environment to the shell. Integrated shells activate
    /// it themselves at the first prompt, after their startup files (the
    /// scripts in `shell-integration/`), and unset these variables. Without
    /// integration there is nobody to do that, so a venv is applied directly
    /// (`VIRTUAL_ENV` and `PATH`); a conda environment cannot be. A venv
    /// must be an absolute path: a relative one would be looked up in
    /// whatever directory the terminal starts in, running that directory's
    /// activate script.
    fn apply_python(&self, cmd: &mut CommandBuilder, integrated: bool) {
        // Possibly inherited, e.g. when Midterm was started from Midterm.
        cmd.env_remove("MIDTERM_PYTHON_VENV");
        cmd.env_remove("MIDTERM_PYTHON_CONDA");
        let Some(python) = &self.python else { return };
        let target = python.target.trim();
        if target.is_empty() || target.contains('\0') {
            return;
        }
        match python.kind.as_str() {
            "venv" if !Path::new(target).is_absolute() => {
                eprintln!("pty: venv path {target:?} is not absolute, ignored");
            }
            "venv" if integrated => cmd.env("MIDTERM_PYTHON_VENV", target),
            "venv" => {
                cmd.env("VIRTUAL_ENV", target);
                let mut paths = vec![Path::new(target).join("bin")];
                if let Some(path) = cmd.get_env("PATH").filter(|path| !path.is_empty()) {
                    paths.extend(std::env::split_paths(path));
                }
                match std::env::join_paths(paths) {
                    Ok(path) => cmd.env("PATH", path),
                    Err(_) => eprintln!("pty: venv path {target:?} not usable in PATH"),
                }
            }
            "conda" if integrated => cmd.env("MIDTERM_PYTHON_CONDA", target),
            _ => {}
        }
    }
}

/// The command for a new terminal in `cwd`: the user's login shell with
/// shell integration where supported (see `super::integration`; with
/// `ssh`, also on ssh remotes), or `custom` (from the settings) exactly as
/// given, without integration. `spawn` adds the workspace's variables and
/// Python environment.
pub fn shell_command(
    cwd: Option<&str>,
    custom: Option<&CustomShell>,
    ssh: bool,
    spawn: &SpawnEnv,
) -> CommandBuilder {
    if let Some(custom) = custom.filter(|custom| !custom.program.trim().is_empty()) {
        let mut cmd = CommandBuilder::new(custom.program.trim());
        cmd.args(&custom.args);
        apply_environment(&mut cmd, cwd);
        spawn.apply_vars(&mut cmd);
        spawn.apply_python(&mut cmd, false);
        return cmd;
    }
    default_shell_command(base_command(cwd), ssh, spawn)
}

/// [`shell_command`] for the login shell, from its bare `cmd`.
fn default_shell_command(mut cmd: CommandBuilder, ssh: bool, spawn: &SpawnEnv) -> CommandBuilder {
    spawn.apply_vars(&mut cmd);
    #[cfg(unix)]
    let integrated = super::integration::setup(&mut cmd, ssh).is_some();
    #[cfg(not(unix))]
    let integrated = {
        let _ = ssh;
        false
    };
    spawn.apply_python(&mut cmd, integrated);
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

    fn plain() -> SpawnEnv {
        SpawnEnv::default()
    }

    fn var(name: &str, value: &str) -> EnvVar {
        EnvVar { name: name.into(), value: value.into() }
    }

    fn env_of(cmd: &CommandBuilder, key: &str) -> Option<String> {
        cmd.get_env(key).and_then(|v| v.to_str()).map(str::to_owned)
    }

    #[test]
    fn sets_terminal_environment() {
        let cmd = shell_command(None, None, true, &plain());
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
        let cmd = shell_command(None, Some(&custom), true, &plain());
        assert!(!cmd.is_default_prog());
        let argv: Vec<_> = cmd.get_argv().iter().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(argv, ["/bin/sh", "-i"]);
        assert_eq!(cmd.get_env("TERM_PROGRAM").and_then(|v| v.to_str()), Some("midterm"));

        let blank = CustomShell { program: "  ".into(), args: vec![] };
        assert!(shell_command(None, Some(&blank), true, &plain()).get_env("TERM").is_some());
    }

    #[test]
    fn uses_cwd_only_if_it_is_a_directory() {
        let home = std::env::home_dir();
        let tmp = std::env::temp_dir();

        assert_eq!(resolve_cwd(tmp.to_str()), Some(tmp.clone()));
        assert_eq!(resolve_cwd(None), home);
        assert_eq!(resolve_cwd(Some("")), home);
        assert_eq!(resolve_cwd(Some("/definitely/not/a/real/dir")), home);

        let cmd = shell_command(tmp.to_str(), None, true, &plain());
        assert_eq!(cmd.get_cwd().map(PathBuf::from), Some(tmp));
    }

    #[test]
    fn env_names_are_validated() {
        for ok in ["A", "_", "a_1", "PATH", "_9"] {
            assert!(valid_env_name(ok), "{ok}");
        }
        for bad in ["", "1A", "A-B", "A B", "A=B", "é", "A\0"] {
            assert!(!valid_env_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn user_env_goes_on_top_of_the_terminal_environment() {
        let spawn = SpawnEnv {
            vars: vec![
                var("MY_VAR", "1"),
                var("TERM", "dumb"),
                var("MY_VAR", "2"),
                var("1BAD", "x"),
                var("BAD-NAME", "x"),
                var("MIDTERM_SHELL_INTEGRATION", "no"),
                var("MIDTERM_X", "no"),
                var("_midterm_si_loaded", "1"),
                var("_MIDTERM_X", "1"),
                var("NUL", "a\0b"),
                var("EMPTY", ""),
            ],
            python: None,
        };
        let custom = CustomShell { program: "/bin/sh".into(), args: vec![] };
        let cmd = shell_command(None, Some(&custom), true, &spawn);
        assert_eq!(env_of(&cmd, "MY_VAR").as_deref(), Some("2"));
        assert_eq!(env_of(&cmd, "TERM").as_deref(), Some("dumb"));
        assert_eq!(env_of(&cmd, "EMPTY").as_deref(), Some(""));
        for skipped in ["1BAD", "BAD-NAME", "MIDTERM_X", "_midterm_si_loaded", "_MIDTERM_X", "NUL"] {
            assert_eq!(env_of(&cmd, skipped), None, "{skipped}");
        }
        // (Possibly inherited, when the tests run in a Midterm terminal.)
        assert_ne!(env_of(&cmd, "MIDTERM_SHELL_INTEGRATION").as_deref(), Some("no"));
        assert_eq!(env_of(&cmd, "TERM_PROGRAM").as_deref(), Some("midterm"));
    }

    #[cfg(unix)]
    #[test]
    fn integration_variables_win_over_user_ones() {
        let spawn = SpawnEnv {
            vars: vec![var("ZDOTDIR", "/user/zdot"), var("XDG_DATA_DIRS", "/user/share")],
            python: None,
        };
        let mut bare = CommandBuilder::new_default_prog();
        bare.env("SHELL", "/bin/zsh");
        let cmd = default_shell_command(bare, false, &spawn);
        if env_of(&cmd, "MIDTERM_SHELL_INTEGRATION").is_none() {
            return; // the scripts could not be written here
        }
        // Ours, with the user's value kept as the original.
        assert_ne!(env_of(&cmd, "ZDOTDIR").as_deref(), Some("/user/zdot"));
        assert_eq!(env_of(&cmd, "MIDTERM_ZSH_ZDOTDIR").as_deref(), Some("/user/zdot"));
        // Not touched by the zsh integration, so the user's stays.
        assert_eq!(env_of(&cmd, "XDG_DATA_DIRS").as_deref(), Some("/user/share"));
    }

    fn python(kind: &str, target: &str) -> SpawnEnv {
        SpawnEnv {
            vars: vec![],
            python: Some(PythonEnv { kind: kind.into(), target: target.into() }),
        }
    }

    #[cfg(unix)]
    #[test]
    fn python_environment_is_handed_to_integrated_shells() {
        let mut bare = CommandBuilder::new_default_prog();
        bare.env("SHELL", "/bin/zsh");
        bare.env("PATH", "/usr/bin");
        bare.env("MIDTERM_PYTHON_CONDA", "stale");
        let cmd = default_shell_command(bare, false, &python("venv", "/p/.venv"));
        if env_of(&cmd, "MIDTERM_SHELL_INTEGRATION").is_none() {
            return;
        }
        assert_eq!(env_of(&cmd, "MIDTERM_PYTHON_VENV").as_deref(), Some("/p/.venv"));
        assert_eq!(env_of(&cmd, "MIDTERM_PYTHON_CONDA"), None);
        // The shell activates it itself, after its startup files.
        assert_eq!(env_of(&cmd, "VIRTUAL_ENV"), None);
        assert_eq!(env_of(&cmd, "PATH").as_deref(), Some("/usr/bin"));

        let mut bare = CommandBuilder::new_default_prog();
        bare.env("SHELL", "/bin/zsh");
        let cmd = default_shell_command(bare, false, &python("conda", "ml"));
        assert_eq!(env_of(&cmd, "MIDTERM_PYTHON_CONDA").as_deref(), Some("ml"));
        assert_eq!(env_of(&cmd, "MIDTERM_PYTHON_VENV"), None);
    }

    #[test]
    fn python_environment_of_a_custom_shell() {
        let custom = CustomShell { program: "/bin/sh".into(), args: vec![] };
        let mut cmd = shell_command(None, Some(&custom), true, &python("venv", "/p/.venv"));
        assert_eq!(env_of(&cmd, "VIRTUAL_ENV").as_deref(), Some("/p/.venv"));
        let path = env_of(&cmd, "PATH").unwrap();
        assert!(path.starts_with("/p/.venv/bin:"), "{path}");
        // Nothing would act on it, and a shell started inside would activate again.
        assert_eq!(env_of(&cmd, "MIDTERM_PYTHON_VENV"), None);

        // Without a PATH at all it is just the venv's bin.
        cmd.env_remove("PATH");
        python("venv", "/q").apply_python(&mut cmd, false);
        assert_eq!(env_of(&cmd, "PATH").as_deref(), Some("/q/bin"));

        let cmd = shell_command(None, Some(&custom), true, &python("conda", "ml"));
        assert_eq!(env_of(&cmd, "MIDTERM_PYTHON_CONDA"), None);
        assert_eq!(env_of(&cmd, "VIRTUAL_ENV"), None);
    }

    #[test]
    fn unknown_or_empty_python_is_ignored() {
        let custom = CustomShell { program: "/bin/sh".into(), args: vec![] };
        for spawn in [python("pipenv", "x"), python("venv", ""), python("conda", "  "), python("venv", "a\0b"), python("venv", ".venv")] {
            let mut cmd = CommandBuilder::new("/bin/sh");
            cmd.env("MIDTERM_PYTHON_VENV", "stale");
            spawn.apply_python(&mut cmd, true);
            assert_eq!(env_of(&cmd, "MIDTERM_PYTHON_VENV"), None, "{spawn:?}");
            spawn.apply_python(&mut cmd, false);
            assert_eq!(env_of(&cmd, "VIRTUAL_ENV"), None, "{spawn:?}");
            let cmd = shell_command(None, Some(&custom), true, &spawn);
            assert_eq!(env_of(&cmd, "MIDTERM_PYTHON_CONDA"), None, "{spawn:?}");
        }
    }
}
