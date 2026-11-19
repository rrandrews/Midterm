//! Each test runs in a fresh HOME (and ZDOTDIR) so the developer's own
//! configuration stays out of it. Shells that are not installed are skipped.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

use portable_pty::CommandBuilder;

use super::super::integration;
use super::super::manager::PtyManager;
use super::super::session::{Foreground, Session};
use super::super::shell::base_command;
use super::{Harness, Msg, TIMEOUT, wait_until};

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
        "marks=.zshenv .zprofile .zshrc .zlogin  zdotdir={} hooked=yes hooks=_midterm_precmd user_hook _midterm_prompt_end left=none si=1",
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
        text.contains("pc=[_midterm_prompt_command|user_hook|_midterm_prompt_end]"),
        "output: {text:?}"
    );
}

#[test]
fn bash_keeps_an_array_prompt_command_working() {
    let Some(bash) = find_shell("bash") else {
        eprintln!("bash not installed; skipped");
        return;
    };
    let sandbox = Sandbox::new("bash-array");
    // bash < 5.1 runs only the first element, bash 5.1+ all of them.
    sandbox.write(
        ".bash_profile",
        "user_hook() { HOOKED=yes; }\nPROMPT_COMMAND=(user_hook)\n",
    );
    let mut h = sandbox.spawn(&bash, &sandbox.home, |_| {});
    h.session
        .write(b"true\necho \"hooked=$HOOKED\"; exit\n".to_vec())
        .unwrap();
    assert_eq!(h.wait_for_exit(), Some(0));
    let text = h.text();
    assert!(text.contains("hooked=yes"), "output: {text:?}");
    assert!(!osc7_urls(&text).is_empty(), "no OSC 7: {text:?}");
}

#[test]
fn zsh_survives_options_set_in_the_global_zshenv() {
    let Some(zsh) = find_shell("zsh") else {
        eprintln!("zsh not installed; skipped");
        return;
    };
    // A HOME with a space, and the user's .zshenv turning on options that
    // change how unquoted expansions and arrays behave.
    let sandbox = Sandbox::new("zsh options");
    sandbox.write(
        ".zshenv",
        "setopt sh_word_split ksh_arrays no_unset err_return\n",
    );
    sandbox.write(".zshrc", "");
    let start = sandbox.root.join("a dir");
    fs::create_dir_all(&start).unwrap();
    let mut h = sandbox.spawn(&zsh, &start, |_| {});
    h.wait_for_cwd_report(&start);
    h.session.write(b"exit 0\n".to_vec()).unwrap();
    assert_eq!(h.wait_for_exit(), Some(0));
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

const MARK_B: &str = "\x1b]133;B\x07";

/// Every OSC 133 mark in `output` (terminated by BEL or ST) with the byte
/// offset where it starts, e.g. `(120, "D;0")`.
fn osc133_marks(output: &str) -> Vec<(usize, String)> {
    output
        .match_indices("\x1b]133;")
        .filter_map(|(at, intro)| {
            let rest = &output[at + intro.len()..];
            Some((at, rest[..rest.find(['\x07', '\x1b'])?].to_string()))
        })
        .collect()
}

fn mark_names(marks: &[(usize, String)]) -> Vec<&str> {
    marks.iter().map(|(_, mark)| mark.as_str()).collect()
}

impl Harness {
    /// Waits until the output holds at least `count` OSC 133 marks.
    fn wait_for_marks(&mut self, count: usize) {
        let deadline = Instant::now() + TIMEOUT;
        while osc133_marks(&self.text()).len() < count {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.next(left) {
                Some(Msg::Data(_)) => {}
                other => panic!(
                    "{other:?} while waiting for {count} OSC 133 marks; output: {:?}",
                    self.text()
                ),
            }
        }
    }

    /// Types `line` plus Enter and waits for the marks it should produce.
    fn run_line(&mut self, line: &str, marks_after: usize) {
        self.session
            .write(format!("{line}\n").into_bytes())
            .unwrap();
        self.wait_for_marks(marks_after);
    }
}

/// Runs a failing command (`fail`, exiting with 3), `echo hi`, an empty
/// line and `exit`, waiting for each prompt, and checks the OSC 133 marks:
/// A and B around every prompt, C before and D;<status> after each command,
/// and nothing for the empty line. Returns the output.
fn check_prompt_marks(h: &mut Harness, fail: &str) -> String {
    h.wait_for_output(MARK_B);
    h.wait_for_marks(2);
    h.run_line(fail, 6);
    h.run_line("echo hi", 10);
    h.run_line("", 12);
    h.session.write(b"exit\n".to_vec()).unwrap();
    assert_eq!(h.wait_for_exit(), Some(0));

    let text = h.text();
    let marks = osc133_marks(&text);
    let names = mark_names(&marks);
    let expected = [
        "A", "B", "C", "D;3", "A", "B", "C", "D;0", "A", "B", "A", "B",
    ];
    assert!(
        names.starts_with(&expected) && matches!(&names[expected.len()..], [] | ["C"]),
        "marks {names:?} in {text:?}"
    );
    // C follows the echo of what was typed after the prompt.
    let typed_fail = marks[1].0 + text[marks[1].0..].find(fail).expect("no echo");
    assert!(typed_fail < marks[2].0, "C before the echo: {text:?}");
    let typed_echo = marks[5].0 + text[marks[5].0..].find("echo hi").expect("no echo");
    assert!(typed_echo < marks[6].0, "C before the echo: {text:?}");
    // The command's output is between its C and D.
    assert!(
        text[marks[6].0..marks[7].0].contains("hi\r\n"),
        "output not between C and D: {text:?}"
    );
    text
}

#[test]
fn zsh_emits_prompt_marks() {
    let Some(zsh) = find_shell("zsh") else {
        eprintln!("zsh not installed; skipped");
        return;
    };
    let sandbox = Sandbox::new("zsh-marks");
    sandbox.write(".zshrc", "PS1='zsh> '\n");
    let mut h = sandbox.spawn(&zsh, &sandbox.home, |_| {});
    let text = check_prompt_marks(&mut h, "(exit 3)");
    assert_eq!(
        text.matches(&format!("zsh> {MARK_B}")).count(),
        4,
        "{text:?}"
    );
}

#[test]
fn zsh_puts_b_after_a_prompt_rewritten_by_a_hook() {
    let Some(zsh) = find_shell("zsh") else {
        eprintln!("zsh not installed; skipped");
        return;
    };
    let sandbox = Sandbox::new("zsh-theme");
    // A theme rebuilding PS1 at every prompt, from a hook that runs after
    // ours were installed.
    sandbox.write(
        ".zshrc",
        "set_ps1() { PS1=\"custom$((++N))> \" }\nprecmd_functions+=(set_ps1)\n",
    );
    let mut h = sandbox.spawn(&zsh, &sandbox.home, |_| {});
    check_prompt_marks(&mut h, "(exit 3)");
    let text = h.text();
    for n in 1..=4 {
        assert!(
            text.contains(&format!("custom{n}> {MARK_B}")),
            "no B after prompt {n}: {text:?}"
        );
    }

    // With a `precmd` function of the user's, B still follows from the
    // second prompt on, and the function keeps working.
    sandbox.write(
        ".zshrc",
        "set_ps1() { PS1=\"custom$((++N))> \" }\nprecmd_functions+=(set_ps1)\n\
         precmd() { PRECMD_RUNS=$((PRECMD_RUNS+1)) }\n",
    );
    let mut h = sandbox.spawn(&zsh, &sandbox.home, |_| {});
    h.wait_for_output("custom1> ");
    h.session.write(b"true\n".to_vec()).unwrap();
    h.wait_for_output(&format!("custom2> {MARK_B}"));
    h.session
        .write(b"echo \"runs=$PRECMD_RUNS\"; exit\n".to_vec())
        .unwrap();
    assert_eq!(h.wait_for_exit(), Some(0));
    assert!(h.text().contains("runs=2"), "output: {:?}", h.text());
}

#[test]
fn bash_emits_prompt_marks() {
    let Some(bash) = find_shell("bash") else {
        eprintln!("bash not installed; skipped");
        return;
    };
    let sandbox = Sandbox::new("bash-marks");
    // Under extdebug, a DEBUG trap that fails skips the command: ours must
    // not, even after a command that failed.
    sandbox.write(".bash_profile", "PS1='bash> '\nshopt -s extdebug\nset -T\n");
    let mut h = sandbox.spawn(&bash, &sandbox.home, |_| {});
    // A subshell alone gets no marks in bash (the DEBUG trap does not see
    // it), so the failing command is a simple one.
    let text = check_prompt_marks(&mut h, "sh -c 'exit 3'");
    assert_eq!(
        text.matches(&format!("bash> {MARK_B}")).count(),
        4,
        "{text:?}"
    );
}

#[test]
fn bash_marks_work_next_to_the_users_hook_and_debug_trap() {
    let Some(bash) = find_shell("bash") else {
        eprintln!("bash not installed; skipped");
        return;
    };
    let sandbox = Sandbox::new("bash-trap");
    // The user's trap records `$?` and `$_` as it sees them, and their hook
    // rebuilds PS1 at every prompt.
    sandbox.write(
        ".bash_profile",
        "trap 'TRAP_SAW=\"$? $_\"; DEBUG_HITS=$((DEBUG_HITS+1))' DEBUG\n\
         user_hook() { HOOK_STATUS=$?; PS1=\"custom$((++N))> \"; }\n\
         PROMPT_COMMAND=user_hook\n",
    );
    let mut h = sandbox.spawn(&bash, &sandbox.home, |_| {});
    check_prompt_marks(&mut h, "sh -c 'exit 3'");
    let text = h.text();
    for n in 1..=4 {
        assert!(
            text.contains(&format!("custom{n}> {MARK_B}")),
            "no B after prompt {n}: {text:?}"
        );
    }

    let mut h = sandbox.spawn(&bash, &sandbox.home, |_| {});
    h.wait_for_marks(2);
    // A subshell alone: no C, so no D either.
    h.run_line("(exit 4)", 4);
    h.run_line("echo \"hook=$HOOK_STATUS\"", 8);
    h.run_line("echo one two; false", 12);
    h.run_line("echo \"saw=$TRAP_SAW hits=$DEBUG_HITS\"", 16);
    h.session.write(b"exit\n".to_vec()).unwrap();
    assert_eq!(h.wait_for_exit(), Some(0));
    let text = h.text();
    let marks = osc133_marks(&text);
    let names = mark_names(&marks);
    assert_eq!(
        names[..16],
        [
            "A", "B", "A", "B", "C", "D;0", "A", "B", "C", "D;1", "A", "B", "C", "D;0", "A", "B"
        ],
        "{text:?}"
    );
    assert!(text.contains("hook=4"), "output: {text:?}");
    // The trap ran before the last echo with the status of `false` and
    // `$_` from it.
    let saw = text.find("saw=1 false hits=").expect("trap state");
    let hits: u32 = text[saw + "saw=1 false hits=".len()..]
        .split(|c: char| !c.is_ascii_digit())
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert!(hits >= 4, "the user's trap ran only {hits} times");
}

#[test]
fn fish_emits_prompt_marks() {
    let Some(fish) = find_shell("fish") else {
        eprintln!("fish not installed; skipped");
        return;
    };
    let sandbox = Sandbox::new("fish-marks");
    sandbox.write(
        ".config/fish/config.fish",
        "function fish_prompt; printf 'fish> '; end\n",
    );
    let mut h = sandbox.spawn(&fish, &sandbox.home, |_| {});
    let text = check_prompt_marks(&mut h, "sh -c 'exit 3'");
    assert!(text.contains(&format!("fish> {MARK_B}")), "{text:?}");
}

/// Waits until the session's foreground process satisfies `pred`.
fn wait_for_foreground(session: &Session, what: &str, pred: impl Fn(&Foreground) -> bool) {
    wait_until(what, || session.foreground().is_some_and(|fg| pred(&fg)));
}

#[test]
fn foreground_is_the_shell_at_the_prompt_and_the_job_otherwise() {
    let Some(zsh) = find_shell("zsh") else {
        eprintln!("zsh not installed; skipped");
        return;
    };
    let sandbox = Sandbox::new("foreground");
    // Keeps zsh-newuser-install from starting on some distributions.
    sandbox.write(".zshrc", "");
    let mut h = Harness::spawn(sandbox.command(&zsh, &sandbox.home));
    h.session.write(b"echo ready\n".to_vec()).unwrap();
    h.wait_for_output("ready");
    wait_for_foreground(&h.session, "the shell in the foreground", |fg| {
        fg.is_shell && fg.name == "zsh"
    });

    h.session.write(b"sleep 30\n".to_vec()).unwrap();
    wait_for_foreground(&h.session, "sleep in the foreground", |fg| {
        !fg.is_shell && fg.name == "sleep"
    });

    // ^C ends the job and gives the terminal back to the shell.
    h.session.write(b"\x03".to_vec()).unwrap();
    wait_for_foreground(&h.session, "the shell back in the foreground", |fg| {
        fg.is_shell
    });

    h.session.write(b"exit 0\n".to_vec()).unwrap();
    assert_eq!(h.wait_for_exit(), Some(0));
    assert_eq!(h.session.foreground(), None);
}

#[test]
fn foreground_json_shape_and_unknown_ids() {
    let fg = Foreground {
        pid: 42,
        name: "vim".into(),
        is_shell: false,
    };
    assert_eq!(
        serde_json::to_string(&fg).unwrap(),
        r#"{"pid":42,"name":"vim","isShell":false}"#
    );
    assert_eq!(PtyManager::default().foreground(42), None);
}
