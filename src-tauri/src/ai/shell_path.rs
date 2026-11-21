//! The PATH a user's own terminal would have. An app started from Finder
//! inherits launchd's minimal PATH, so CLI providers installed by Homebrew,
//! npm or their own installers are not on it. We run the login shell once,
//! interactively (that is where most PATH edits live), and read its PATH.
//!
//! Shell start-up files can print anything, including OSC sequences from
//! shell integration, so the value is printed between two markers and cut
//! out of the output.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::process::{self, Run};

const BEGIN: &str = "__MIDTERM_PATH_BEGIN_5d1c__";
const END: &str = "__MIDTERM_PATH_END_5d1c__";
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Places worth searching even if no shell mentions them.
const FALLBACK_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin"];

/// The value printed between the markers, or `None` if they are missing.
/// Uses the last complete pair, in case start-up output echoed the command.
pub fn extract_marked(output: &str) -> Option<String> {
    let end = output.rfind(END)?;
    let begin = output[..end].rfind(BEGIN)? + BEGIN.len();
    Some(output[begin..end].to_string())
}

/// `primary`'s entries, then those of `extra` not already present. Empty
/// entries are dropped and `~/` is expanded.
pub fn merge(primary: &str, extra: &[&str], home: Option<&Path>) -> String {
    let mut seen: Vec<String> = Vec::new();
    let all = std::iter::once(primary).chain(extra.iter().copied());
    for list in all {
        for entry in list.split(':') {
            let entry = entry.trim();
            if entry.is_empty() {
                continue;
            }
            let entry = match (entry.strip_prefix("~/"), home) {
                (Some(rest), Some(home)) => home.join(rest).to_string_lossy().into_owned(),
                _ => entry.to_string(),
            };
            if !seen.contains(&entry) {
                seen.push(entry);
            }
        }
    }
    seen.join(":")
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

fn login_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".into()
            } else {
                "/bin/sh".into()
            }
        })
}

/// The command that prints PATH between the markers. The braces matter:
/// in `$PATH__MIDTERM…` the shell would read one long, unset variable name.
fn probe_script() -> String {
    format!("printf '%s' \"{BEGIN}${{PATH}}{END}\"")
}

/// Runs `$SHELL -l -i -c` to print PATH between markers. `None` if the
/// shell fails, hangs or prints no markers.
async fn probe() -> Option<String> {
    let script = probe_script();
    let output = process::run(Run {
        program: login_shell(),
        args: vec!["-l".into(), "-i".into(), "-c".into(), script.into()],
        cwd: home_dir(),
        env: vec![("TERM".into(), "dumb".into())],
        env_remove: vec![],
        stdin: None,
        timeout: PROBE_TIMEOUT,
    })
    .await
    .ok()?;
    extract_marked(&output.stdout).filter(|p| !p.trim().is_empty())
}

/// The PATH to search for and run CLI providers with: the login shell's,
/// then the app's own, then common install locations.
pub async fn resolve() -> String {
    let own = std::env::var("PATH").unwrap_or_default();
    if cfg!(windows) {
        // No login shell to ask; GUI apps get the user's PATH there.
        return own;
    }
    let login = probe().await;
    merge(
        login.as_deref().unwrap_or(""),
        &[&own, &FALLBACK_DIRS.join(":")],
        home_dir().as_deref(),
    )
}

/// The first executable file named `name` in `path_var`.
pub fn find_in_path(name: &str, path_var: &str) -> Option<PathBuf> {
    std::env::split_paths(&OsString::from(path_var))
        .flat_map(|dir| candidates(&dir, name))
        .find(|p| is_executable(p))
}

fn candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    if cfg!(windows) {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|ext| dir.join(format!("{name}.{ext}")))
            .collect()
    } else {
        vec![dir.join(name)]
    }
}

pub fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_between_markers() {
        let noisy = format!(
            "\x1b]133;A\x07Welcome!\n{BEGIN}/a/bin:/usr/bin{END}\x1b]133;D;0\x07\x1b]7;file://h/\x07"
        );
        assert_eq!(extract_marked(&noisy).as_deref(), Some("/a/bin:/usr/bin"));
        let echoed = format!("+ printf {BEGIN}$PATH{END}\n{BEGIN}/x{END}");
        assert_eq!(extract_marked(&echoed).as_deref(), Some("/x"));
        assert_eq!(extract_marked("no markers"), None);
        assert_eq!(extract_marked(&format!("{END}{BEGIN}")), None);
        assert_eq!(
            extract_marked(&format!("{BEGIN}{END}")).as_deref(),
            Some("")
        );
    }

    #[cfg(unix)]
    #[test]
    fn probe_script_prints_path_between_markers() {
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &probe_script()])
            .env("PATH", "/a/bin:/usr/bin:/bin")
            .output()
            .unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert_eq!(
            extract_marked(&stdout).as_deref(),
            Some("/a/bin:/usr/bin:/bin")
        );
    }

    #[test]
    fn merges_paths() {
        let home = Path::new("/home/u");
        assert_eq!(
            merge("/a::/b", &["/b:/c", "~/.local/bin:/a"], Some(home)),
            "/a:/b:/c:/home/u/.local/bin"
        );
        assert_eq!(merge("", &["/x"], None), "/x");
    }

    #[cfg(unix)]
    #[test]
    fn finds_executables() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("tool");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        let plain = dir.path().join("plain");
        std::fs::write(&plain, "").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path_var = format!("/nonexistent:{}", dir.path().display());
        assert_eq!(find_in_path("tool", &path_var), Some(exe));
        assert_eq!(find_in_path("plain", &path_var), None);
        assert_eq!(find_in_path("missing", &path_var), None);
    }
}
