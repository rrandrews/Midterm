//! Each test runs in a fresh HOME (and ZDOTDIR) so the developer's own
//! configuration stays out of it. Shells that are not installed are skipped.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use portable_pty::CommandBuilder;

use super::super::integration;
use super::super::shell::base_command;
use super::Harness;

/// A fresh, empty directory under the temp dir, with symlinks resolved so
/// that it matches what the shell reports as `$PWD`.
fn fresh_dir(name: &str) -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "midterm-test-{}-{}-{name}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("cannot create test dir");
    dir.canonicalize().expect("test dir must exist")
}

/// The first `name` executable on `PATH` or in the usual places.
fn find_shell(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map(PathBuf::from))
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Shells started the way `shell_command` starts them, but sandboxed:
/// `home` is HOME, and the scripts come from a private directory.
struct Sandbox {
    root: PathBuf,
    home: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let root = fresh_dir(name);
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        Self { root, home }
    }

    /// Writes a file relative to HOME.
    fn write(&self, relative: &str, contents: &str) {
        let path = self.home.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn scripts(&self) -> PathBuf {
        self.root.join("integration")
    }

    /// The environment of a sandboxed `shell`, before integration.
    fn command(&self, shell: &Path, cwd: &Path) -> CommandBuilder {
        let mut cmd = base_command(cwd.to_str());
        cmd.env("SHELL", shell);
        cmd.env("HOME", &self.home);
        for key in [
            "ZDOTDIR",
            "PROMPT_COMMAND",
            "ENV",
            "BASH_ENV",
            "XDG_CONFIG_HOME",
        ] {
            cmd.env_remove(key);
        }
        cmd.env("BASH_SILENCE_DEPRECATION_WARNING", "1");
        cmd
    }

    /// `shell` with integration, started in `cwd`. `configure` sets the
    /// variables the integration has to preserve, before it is injected.
    fn spawn(
        &self,
        shell: &Path,
        cwd: &Path,
        configure: impl FnOnce(&mut CommandBuilder),
    ) -> Harness {
        let mut cmd = self.command(shell, cwd);
        configure(&mut cmd);
        integration::install(&self.scripts()).expect("install failed");
        assert!(integration::inject(&mut cmd, &self.scripts()).is_some());
        Harness::spawn(cmd)
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// The URL of every OSC 7 in `output` (terminated by BEL or ST).
fn osc7_urls(output: &str) -> Vec<String> {
    output
        .split("\x1b]7;")
        .skip(1)
        .filter_map(|rest| Some(rest[..rest.find(['\x07', '\x1b'])?].to_string()))
        .collect()
}

/// Percent-encodes `path` byte by byte, the way the scripts must.
fn percent_encode(path: &Path) -> String {
    let mut out = String::new();
    for &byte in path.as_os_str().as_encoded_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'.' | b'_' | b'~' | b'-' => {
                out.push(char::from(byte));
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

impl Harness {
    /// Waits for an OSC 7 reporting `dir` as `file://<host><encoded path>`.
    fn wait_for_cwd_report(&mut self, dir: &Path) {
        let encoded = percent_encode(dir);
        self.wait_for_output(&format!("{encoded}\x07"));
        let urls = osc7_urls(&self.text());
        let url = urls
            .iter()
            .find(|url| url.ends_with(&encoded))
            .unwrap_or_else(|| panic!("no OSC 7 for {dir:?} in {urls:?}"));
        let rest = url.strip_prefix("file://").expect("not a file:// URL");
        let (host, path) = rest.split_at(rest.find('/').expect("no path"));
        assert!(!host.is_empty(), "no host in {url:?}");
        assert_eq!(path, encoded);
    }
}

/// Starts `shell` with integration in a directory whose name needs
/// encoding, `cd`s into another one and checks that both are reported.
fn check_cwd_reports(shell: &Path, sandbox: &Sandbox, configure: impl FnOnce(&mut CommandBuilder)) {
    let start = sandbox.root.join("start here é");
    let next = start.join("ünïcödé dir #1");
    fs::create_dir_all(&next).unwrap();

    let mut h = sandbox.spawn(shell, &start, configure);
    h.wait_for_cwd_report(&start);
    h.session
        .write("cd 'ünïcödé dir #1'\n".as_bytes().to_vec())
        .unwrap();
    h.wait_for_cwd_report(&next);
    h.session.write(b"exit\n".to_vec()).unwrap();
    assert_eq!(h.wait_for_exit(), Some(0));
}

#[test]
fn zsh_reports_cwd_and_reads_the_users_startup_files() {
    let Some(zsh) = find_shell("zsh") else {
        eprintln!("zsh not installed; skipped");
        return;
    };
    let sandbox = Sandbox::new("zsh");
    let zdotdir = sandbox.home.join("zdot");
    for file in [".zshenv", ".zprofile", ".zlogin"] {
        sandbox.write(&format!("zdot/{file}"), &format!("MARKS+=\"{file} \"\n"));
    }
    // A hook the user adds in .zshrc must keep working next to ours.
    sandbox.write(
        "zdot/.zshrc",
        "MARKS+=\".zshrc \"\nuser_hook() { HOOKED=yes }\nprecmd_functions+=(user_hook)\n",
    );
    check_cwd_reports(&zsh, &sandbox, |cmd| cmd.env("ZDOTDIR", &zdotdir));

    let mut h = sandbox.spawn(&zsh, &sandbox.home, |cmd| cmd.env("ZDOTDIR", &zdotdir));
    // Sourcing the integration again must not install it twice.
    let integration = sandbox.scripts().join("zsh/midterm-integration.zsh");
    let probe = format!(
        "source '{}'; echo \"marks=$MARKS zdotdir=$ZDOTDIR hooked=$HOOKED \
         hooks=${{precmd_functions[*]}} \
         left=${{MIDTERM_ZSH_ZDOTDIR-none}} si=$MIDTERM_SHELL_INTEGRATION\"; exit\n",
        integration.display()
    );
    h.session.write(probe.into_bytes()).unwrap();
    assert_eq!(h.wait_for_exit(), Some(0));
    let expected = format!(
        "marks=.zshenv .zprofile .zshrc .zlogin  zdotdir={} hooked=yes hooks=_midterm_precmd user_hook left=none si=1",
        zdotdir.display()
    );
    assert!(h.text().contains(&expected), "output: {:?}", h.text());
}

#[test]
fn zsh_without_zdotdir_reads_home_and_leaves_zdotdir_unset() {
    let Some(zsh) = find_shell("zsh") else {
        eprintln!("zsh not installed; skipped");
        return;
    };
    let sandbox = Sandbox::new("zsh-home");
    sandbox.write(".zshenv", "MARKS+=\"env \"\n");
    sandbox.write(".zshrc", "MARKS+=\"rc \"\n");
    let mut h = sandbox.spawn(&zsh, &sandbox.home, |_| {});
    h.session
        .write(b"echo \"marks=$MARKS zdotdir=${ZDOTDIR-unset}\"; exit\n".to_vec())
        .unwrap();
    assert_eq!(h.wait_for_exit(), Some(0));
    let text = h.text();
    assert!(
        text.contains("marks=env rc  zdotdir=unset"),
        "output: {text:?}"
    );
    assert!(!osc7_urls(&text).is_empty(), "no OSC 7: {text:?}");
}

#[test]
fn bash_reports_cwd_and_reads_the_login_startup_files() {
    let Some(bash) = find_shell("bash") else {
        eprintln!("bash not installed; skipped");
        return;
    };
    let sandbox = Sandbox::new("bash");
    sandbox.write(
        ".bash_profile",
        "PROFILE_RUNS=$((PROFILE_RUNS+1))\n\
         user_hook() { HOOK_STATUS=$?; HOOKED=yes; }\n\
         PROMPT_COMMAND=user_hook\n",
    );
    // A login shell reads only the first of these, and not .bashrc.
    sandbox.write(".profile", "PROFILE=yes\n");
    sandbox.write(".bashrc", "BASHRC=yes\n");
    check_cwd_reports(&bash, &sandbox, |_| {});

    let mut h = sandbox.spawn(&bash, &sandbox.home, |_| {});
    // Sourcing the script again must neither re-read the profile nor
    // install the hook twice. The user's hook must see the exit status.
    let script = sandbox.scripts().join("bash/midterm.bash");
    let probe = format!(
        "source '{}'; (exit 7)\n\
         echo \"runs=$PROFILE_RUNS hooked=$HOOKED status=$HOOK_STATUS \
         bashrc=${{BASHRC-no}} profile=${{PROFILE-no}} si=$MIDTERM_SHELL_INTEGRATION\"; \
         echo \"pc=[${{PROMPT_COMMAND//$'\\n'/|}}]\"; exit\n",
        script.display()
    );
    h.session.write(probe.into_bytes()).unwrap();
    assert_eq!(h.wait_for_exit(), Some(0));
    let text = h.text();
    assert!(
        text.contains("runs=1 hooked=yes status=7 bashrc=no profile=no si=1"),
        "output: {text:?}"
    );
    assert!(
        text.contains("pc=[_midterm_prompt_command|user_hook]"),
        "output: {text:?}"
    );
}

#[test]
fn bash_falls_back_to_dot_profile() {
    let Some(bash) = find_shell("bash") else {
        eprintln!("bash not installed; skipped");
        return;
    };
    let sandbox = Sandbox::new("bash-profile");
    sandbox.write(".profile", "PROFILE=yes\n");
    let mut h = sandbox.spawn(&bash, &sandbox.home, |_| {});
    h.session
        .write(b"echo \"profile=$PROFILE\"; exit\n".to_vec())
        .unwrap();
    assert_eq!(h.wait_for_exit(), Some(0));
    let text = h.text();
    assert!(text.contains("profile=yes"), "output: {text:?}");
    assert!(!osc7_urls(&text).is_empty(), "no OSC 7: {text:?}");
}

#[test]
fn fish_reports_cwd_and_restores_xdg_data_dirs() {
    let Some(fish) = find_shell("fish") else {
        eprintln!("fish not installed; skipped");
        return;
    };
    let sandbox = Sandbox::new("fish");
    sandbox.write(".config/fish/config.fish", "set -g MARK config\n");
    let configure = |cmd: &mut CommandBuilder| cmd.env("XDG_DATA_DIRS", "/a:/b");
    check_cwd_reports(&fish, &sandbox, configure);

    let mut h = sandbox.spawn(&fish, &sandbox.home, configure);
    h.session
        .write(
            b"echo \"mark=$MARK xdg=$XDG_DATA_DIRS left=$MIDTERM_FISH_DATA_DIR \
              si=$MIDTERM_SHELL_INTEGRATION\"; exit\n"
                .to_vec(),
        )
        .unwrap();
    assert_eq!(h.wait_for_exit(), Some(0));
    let text = h.text();
    assert!(
        text.contains("mark=config xdg=/a:/b left= si=1"),
        "output: {text:?}"
    );
}
