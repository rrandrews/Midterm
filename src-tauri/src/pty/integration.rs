//! Shell integration: scripts that make the shell report its working
//! directory (OSC 7) at every prompt, loaded without touching the user's
//! startup files.
//!
//! The scripts live in `src-tauri/shell-integration/`, are compiled into the
//! binary and written to [`default_dir`] on demand. How each shell is made to
//! load them:
//!
//! * **zsh** – `ZDOTDIR` points at our `zsh/` directory, whose `.zshenv`
//!   restores the user's `ZDOTDIR` (kept in `MIDTERM_ZSH_ZDOTDIR`), sources
//!   the user's `.zshenv` and loads the integration. All later startup files
//!   are read from the user's own directory again.
//! * **bash** – started as `bash --rcfile <bash/midterm.bash>`. The script
//!   reads the login startup files itself, then adds its hook to
//!   `PROMPT_COMMAND`. (The `--posix` + `ENV` trick other terminals use keeps
//!   bash a real login shell, but bash 3.2, the macOS `/bin/bash`, does not
//!   read `ENV` in posix mode.)
//! * **fish** – our directory is prepended to `XDG_DATA_DIRS`, so fish
//!   sources `fish/vendor_conf.d/midterm.fish`, which removes the entry
//!   again (`MIDTERM_FISH_DATA_DIR`, `MIDTERM_FISH_XDG_DATA_DIRS_UNSET`).
//!
//! Other shells start without integration. Every integrated shell gets
//! `MIDTERM_SHELL_INTEGRATION=1`.

use std::ffi::OsStr;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use portable_pty::CommandBuilder;

/// The embedded scripts, by path relative to the integration directory.
const SCRIPTS: &[(&str, &str)] = &[
    (
        "zsh/.zshenv",
        include_str!("../../shell-integration/zsh/.zshenv"),
    ),
    (
        "zsh/midterm-integration.zsh",
        include_str!("../../shell-integration/zsh/midterm-integration.zsh"),
    ),
    (
        "bash/midterm.bash",
        include_str!("../../shell-integration/bash/midterm.bash"),
    ),
    (
        "fish/vendor_conf.d/midterm.fish",
        include_str!("../../shell-integration/fish/vendor_conf.d/midterm.fish"),
    ),
];

/// A shell we know how to integrate with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    Zsh,
    Bash,
    Fish,
}

impl Shell {
    /// Recognises a shell by the file name of its executable.
    pub fn from_path(path: &str) -> Option<Self> {
        match Path::new(path).file_name()?.to_str()? {
            "zsh" => Some(Self::Zsh),
            "bash" => Some(Self::Bash),
            "fish" => Some(Self::Fish),
            _ => None,
        }
    }
}

/// Where the scripts are written: a per-version directory in the user's
/// cache directory (`~/Library/Caches/com.ron.midterm` on macOS,
/// `$XDG_CACHE_HOME/com.ron.midterm` or `~/.cache/com.ron.midterm`
/// elsewhere).
pub fn default_dir() -> Option<PathBuf> {
    let cache = if cfg!(target_os = "macos") {
        std::env::home_dir()?.join("Library/Caches")
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .or_else(|| std::env::home_dir().map(|home| home.join(".cache")))?
    };
    Some(
        cache
            .join("com.ron.midterm")
            .join("shell-integration")
            .join(env!("CARGO_PKG_VERSION")),
    )
}

/// Writes the scripts to `dir`, leaving files that are already up to date
/// alone. Each file is replaced atomically, so concurrent calls (and shells
/// starting meanwhile) only ever see complete scripts.
pub fn install(dir: &Path) -> io::Result<()> {
    for (name, contents) in SCRIPTS {
        let path = dir.join(name);
        if fs::read(&path).is_ok_and(|existing| existing == contents.as_bytes()) {
            continue;
        }
        let parent = path.parent().unwrap_or(dir);
        fs::create_dir_all(parent)?;
        write_atomically(&path, contents.as_bytes())?;
    }
    Ok(())
}

fn write_atomically(path: &Path, contents: &[u8]) -> io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let tmp = PathBuf::from(tmp);
    // `create_new`: another process that happens to pick the same name (pids
    // repeat across PID namespaces sharing a cache) fails here instead of
    // truncating a file that is being written. Its file is not ours to remove.
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    let result = file.write_all(contents).and_then(|()| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Arranges for `cmd`, which must still be the default program (the user's
/// shell), to load the integration from `dir`. Returns the shell it set up,
/// or `None` (leaving `cmd` untouched) for shells it does not support.
///
/// The original values of the variables it changes are taken from `cmd`, so
/// set any overrides before calling this.
pub fn inject(cmd: &mut CommandBuilder, dir: &Path) -> Option<Shell> {
    let program = cmd.get_shell();
    inject_as(cmd, dir, program)
}

/// [`inject`] for the shell `program`, which `cmd` runs.
fn inject_as(cmd: &mut CommandBuilder, dir: &Path, program: String) -> Option<Shell> {
    debug_assert!(cmd.is_default_prog());
    let Some(shell) = Shell::from_path(&program) else {
        cmd.env_remove("MIDTERM_SHELL_INTEGRATION");
        return None;
    };
    match shell {
        Shell::Zsh => {
            match cmd.get_env("ZDOTDIR").map(OsStr::to_owned) {
                Some(original) => cmd.env("MIDTERM_ZSH_ZDOTDIR", original),
                None => cmd.env_remove("MIDTERM_ZSH_ZDOTDIR"),
            }
            cmd.env("ZDOTDIR", dir.join("zsh"));
        }
        Shell::Bash => {
            // Turns the default program into an explicit command line. An
            // `argv[0]` starting with `-` would make bash a login shell,
            // which ignores `--rcfile`, so the script does the login part.
            let argv = cmd.get_argv_mut();
            argv.push(program.into());
            argv.push("--rcfile".into());
            argv.push(dir.join("bash/midterm.bash").into_os_string());
        }
        Shell::Fish => {
            // XDG_DATA_DIRS is colon-separated, so our entry cannot hold one.
            if dir.as_os_str().as_encoded_bytes().contains(&b':') {
                cmd.env_remove("MIDTERM_SHELL_INTEGRATION");
                return None;
            }
            let original = cmd
                .get_env("XDG_DATA_DIRS")
                .filter(|dirs| !dirs.is_empty())
                .map(OsStr::to_owned);
            let mut dirs = dir.as_os_str().to_owned();
            dirs.push(":");
            match &original {
                Some(original) => {
                    dirs.push(original);
                    cmd.env_remove("MIDTERM_FISH_XDG_DATA_DIRS_UNSET");
                }
                None => {
                    // The default per the XDG spec, so fish still finds
                    // the system's vendor directories during startup.
                    dirs.push("/usr/local/share:/usr/share");
                    cmd.env("MIDTERM_FISH_XDG_DATA_DIRS_UNSET", "1");
                }
            }
            cmd.env("XDG_DATA_DIRS", dirs);
            cmd.env("MIDTERM_FISH_DATA_DIR", dir);
        }
    }
    cmd.env("MIDTERM_SHELL_INTEGRATION", "1");
    Some(shell)
}

/// [`install`]s the scripts in [`default_dir`] and [`inject`]s them into
/// `cmd`. Failing to install is not fatal: the shell then simply starts
/// without integration.
pub fn setup(cmd: &mut CommandBuilder) -> Option<Shell> {
    // Only worth touching the disk for shells we can integrate with.
    let dir = Shell::from_path(&cmd.get_shell())
        .and_then(|_| default_dir())
        .filter(|dir| match install(dir) {
            Ok(()) => true,
            Err(e) => {
                eprintln!(
                    "midterm: no shell integration, cannot write {}: {e}",
                    dir.display()
                );
                false
            }
        });
    match dir {
        Some(dir) => inject(cmd, &dir),
        None => {
            // Possibly inherited, e.g. when Midterm was started from Midterm.
            cmd.env_remove("MIDTERM_SHELL_INTEGRATION");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_shells_by_file_name() {
        assert_eq!(Shell::from_path("/bin/zsh"), Some(Shell::Zsh));
        assert_eq!(Shell::from_path("/usr/local/bin/bash"), Some(Shell::Bash));
        assert_eq!(
            Shell::from_path("/opt/homebrew/bin/fish"),
            Some(Shell::Fish)
        );
        assert_eq!(Shell::from_path("/bin/sh"), None);
        assert_eq!(Shell::from_path("/usr/bin/nu"), None);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("midterm-integration-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn install_writes_scripts_and_repairs_changed_ones() {
        let dir = temp_dir("install");
        install(&dir).expect("install failed");
        for (name, contents) in SCRIPTS {
            assert_eq!(fs::read_to_string(dir.join(name)).unwrap(), *contents);
        }
        let zshenv = dir.join("zsh/.zshenv");
        fs::write(&zshenv, "stale").unwrap();
        install(&dir).expect("second install failed");
        assert_eq!(fs::read_to_string(&zshenv).unwrap(), SCRIPTS[0].1);
        let leftovers = fs::read_dir(dir.join("zsh"))
            .unwrap()
            .filter(|entry| {
                let name = entry.as_ref().unwrap().file_name();
                name.to_string_lossy().ends_with(".tmp")
            })
            .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    fn default_prog(shell: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new_default_prog();
        cmd.env("SHELL", shell);
        cmd
    }

    fn env_of(cmd: &CommandBuilder, key: &str) -> Option<std::ffi::OsString> {
        cmd.get_env(key).map(OsStr::to_owned)
    }

    /// Like [`inject`](super::inject), but takes the shell from `$SHELL`
    /// even if it is not installed.
    fn inject(cmd: &mut CommandBuilder, dir: &str) -> Option<Shell> {
        let program = cmd.get_env("SHELL").unwrap().to_str().unwrap().to_owned();
        inject_as(cmd, Path::new(dir), program)
    }

    #[test]
    fn zsh_keeps_the_original_zdotdir() {
        let dir = "/midterm";
        let mut cmd = default_prog("/bin/zsh");
        cmd.env("ZDOTDIR", "/home/me/zsh");
        assert_eq!(inject(&mut cmd, dir), Some(Shell::Zsh));
        assert!(cmd.is_default_prog(), "zsh must stay a login shell");
        assert_eq!(env_of(&cmd, "ZDOTDIR"), Some("/midterm/zsh".into()));
        assert_eq!(
            env_of(&cmd, "MIDTERM_ZSH_ZDOTDIR"),
            Some("/home/me/zsh".into())
        );
        assert_eq!(env_of(&cmd, "MIDTERM_SHELL_INTEGRATION"), Some("1".into()));

        let mut cmd = default_prog("/bin/zsh");
        cmd.env_remove("ZDOTDIR");
        cmd.env("MIDTERM_ZSH_ZDOTDIR", "/stale");
        inject(&mut cmd, dir);
        assert_eq!(env_of(&cmd, "MIDTERM_ZSH_ZDOTDIR"), None);
    }

    #[test]
    fn bash_gets_an_rcfile() {
        let mut cmd = default_prog("/bin/bash");
        assert_eq!(inject(&mut cmd, "/midterm"), Some(Shell::Bash));
        let argv: Vec<_> = cmd.get_argv().iter().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(
            argv,
            ["/bin/bash", "--rcfile", "/midterm/bash/midterm.bash"]
        );
    }

    #[test]
    fn fish_gets_a_data_dir_that_it_removes_again() {
        let dir = "/midterm";
        let mut cmd = default_prog("/usr/bin/fish");
        cmd.env("XDG_DATA_DIRS", "/a:/b");
        assert_eq!(inject(&mut cmd, dir), Some(Shell::Fish));
        assert!(cmd.is_default_prog());
        assert_eq!(env_of(&cmd, "XDG_DATA_DIRS"), Some("/midterm:/a:/b".into()));
        assert_eq!(
            env_of(&cmd, "MIDTERM_FISH_DATA_DIR"),
            Some("/midterm".into())
        );
        assert_eq!(env_of(&cmd, "MIDTERM_FISH_XDG_DATA_DIRS_UNSET"), None);

        let mut cmd = default_prog("/usr/bin/fish");
        cmd.env_remove("XDG_DATA_DIRS");
        inject(&mut cmd, dir);
        assert_eq!(
            env_of(&cmd, "XDG_DATA_DIRS"),
            Some("/midterm:/usr/local/share:/usr/share".into())
        );
        assert_eq!(
            env_of(&cmd, "MIDTERM_FISH_XDG_DATA_DIRS_UNSET"),
            Some("1".into())
        );
    }

    #[test]
    fn other_shells_are_left_alone() {
        let mut cmd = default_prog("/bin/sh");
        assert_eq!(inject(&mut cmd, "/midterm"), None);
        assert!(cmd.is_default_prog());
        assert_eq!(env_of(&cmd, "MIDTERM_SHELL_INTEGRATION"), None);
    }
}
