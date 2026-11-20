//! CLI providers: Claude Code (`claude -p`), Codex (`codex exec`) and
//! Antigravity (`agy -p`), run headless as child processes.
//!
//! Each run gets a fresh empty temporary directory as its working directory
//! (so no project files or instructions are picked up), the login shell's
//! PATH (scripts with `#!/usr/bin/env node` need it too), a timeout, and is
//! killed with its process group when cancelled. Tools are off or read-only:
//! see the argument builders for the flags and why.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::OnceCell;

use super::Reply;
use super::effort::{self, Effort, Resolved};
use super::error::{AiError, ErrorKind, truncate};
use super::process::{self, Output, Run};
use super::provider::CliKind;
use super::shell_path;

const SUGGEST_TIMEOUT: Duration = Duration::from_secs(120);
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
const MODELS_TIMEOUT: Duration = Duration::from_secs(30);

/// Environment variables removed from CLI runs. Claude Code refuses to start
/// "inside another Claude Code session" when these are inherited (as in a
/// dev build launched from one).
const ENV_REMOVE: &[&str] = &["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Set when the version is older than the flags we pass need.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outdated: Option<String>,
}

/// The oldest version whose flags we rely on: Claude Code's `--safe-mode`
/// came in 2.1.169.
fn min_version(kind: CliKind) -> Option<(&'static str, [u32; 3])> {
    match kind {
        CliKind::ClaudeCode => Some(("2.1.169", [2, 1, 169])),
        _ => None,
    }
}

/// The first `x.y.z` in a `--version` line.
fn parse_version(line: &str) -> Option<[u32; 3]> {
    line.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find_map(|word| {
            let mut parts = word.split('.').map(|p| p.parse::<u32>().ok());
            let v = [parts.next()??, parts.next()??, parts.next()??];
            Some(v)
        })
}

/// A message when `version` is known to be too old for `kind`.
pub fn outdated_note(kind: CliKind, version: Option<&str>) -> Option<String> {
    let (min, min_parts) = min_version(kind)?;
    let found = parse_version(version?)?;
    (found < min_parts).then(|| {
        format!(
            "Version {min} or later is needed; update `{}`",
            kind.binary()
        )
    })
}

/// Finds CLI executables. The login shell's PATH is resolved once, on first
/// use, and kept for the life of the app.
#[derive(Default)]
pub struct Discovery {
    path_var: OnceCell<String>,
}

impl Discovery {
    /// A discovery with a fixed PATH, skipping the login shell.
    #[cfg(test)]
    pub fn with_path_var(path_var: &str) -> Self {
        Self {
            path_var: OnceCell::new_with(Some(path_var.to_string())),
        }
    }

    pub async fn path_var(&self) -> &str {
        self.path_var.get_or_init(shell_path::resolve).await
    }

    /// The executable for `kind`: the override if given (a path, `~/…`, or
    /// a bare name looked up on PATH), else the provider's binary on PATH.
    pub async fn locate(
        &self,
        kind: CliKind,
        path_override: Option<&str>,
    ) -> Result<PathBuf, AiError> {
        let path_var = self.path_var().await;
        let name = path_override.unwrap_or(kind.binary());
        let found = if name.contains('/') || name.contains('\\') {
            let path = expand_home(name, shell_path::home_dir().as_deref());
            shell_path::is_executable(&path).then_some(path)
        } else {
            shell_path::find_in_path(name, path_var)
        };
        found.ok_or_else(|| {
            let message = match path_override {
                Some(p) => format!("no executable at {p:?}"),
                None => format!(
                    "`{}` was not found on the login shell's PATH",
                    kind.binary()
                ),
            };
            AiError::new(ErrorKind::NotFound, message)
        })
    }

    async fn base_run(&self, program: PathBuf, args: Vec<OsString>, timeout: Duration) -> Run {
        Run {
            program,
            args,
            cwd: None,
            env: vec![
                ("PATH".into(), self.path_var().await.into()),
                ("NO_COLOR".into(), "1".into()),
                ("TERM".into(), "dumb".into()),
            ],
            env_remove: ENV_REMOVE.to_vec(),
            stdin: None,
            timeout,
        }
    }

    pub async fn status(&self, kind: CliKind, path_override: Option<&str>) -> CliStatus {
        let Ok(program) = self.locate(kind, path_override).await else {
            return CliStatus {
                found: false,
                path: None,
                version: None,
                outdated: None,
            };
        };
        let run = self
            .base_run(program.clone(), vec!["--version".into()], VERSION_TIMEOUT)
            .await;
        let version = process::run(run)
            .await
            .ok()
            .filter(|o| o.success)
            .and_then(|o| first_line(&o.stdout).or_else(|| first_line(&o.stderr)));
        let outdated = outdated_note(kind, version.as_deref());
        CliStatus {
            found: true,
            path: Some(program.to_string_lossy().into_owned()),
            version,
            outdated,
        }
    }

    /// The models the CLI offers. Only Antigravity can list them
    /// (`agy models`); the others return none and the UI takes free text.
    pub async fn models(
        &self,
        kind: CliKind,
        path_override: Option<&str>,
    ) -> Result<Vec<String>, AiError> {
        if kind != CliKind::Antigravity {
            return Ok(Vec::new());
        }
        let program = self.locate(kind, path_override).await?;
        let run = self
            .base_run(program, vec!["models".into()], MODELS_TIMEOUT)
            .await;
        let output = process::run(run).await?;
        if !output.success {
            return Err(failure_error(kind, &output));
        }
        Ok(parse_agy_models(&output.stdout))
    }

    pub async fn complete(
        &self,
        kind: CliKind,
        path_override: Option<&str>,
        model: &str,
        system: &str,
        prompt: &str,
        resolved: &Resolved,
    ) -> Result<Reply, AiError> {
        let program = self.locate(kind, path_override).await?;
        let dir = tempfile::Builder::new()
            .prefix("midterm-ai-")
            .tempdir()
            .map_err(|e| AiError::other(format!("could not create a temporary directory: {e}")))?;
        let out_file = dir.path().join("last-message.txt");
        let system_file = dir.path().join("instructions.md");
        if kind == CliKind::Codex {
            std::fs::write(&system_file, system_or_default(system)).map_err(|e| {
                AiError::other(format!("could not write the instructions file: {e}"))
            })?;
        }
        let level = effort::cli_level(kind, model, resolved.level);
        let timeout = effort::scaled(SUGGEST_TIMEOUT, resolved);
        let attempt = |level: Option<Effort>| {
            let program = program.clone();
            let cwd = dir.path().to_path_buf();
            let (args, stdin) = match kind {
                CliKind::ClaudeCode => {
                    (claude_args(model, system, level), Some(prompt.to_string()))
                }
                CliKind::Codex => (
                    codex_args(model, dir.path(), &out_file, &system_file, level),
                    Some(prompt.to_string()),
                ),
                CliKind::Antigravity => (
                    agy_args(model, &combined_prompt(system, prompt), level),
                    None,
                ),
            };
            async move {
                let mut run = self.base_run(program, args, timeout).await;
                run.cwd = Some(cwd);
                run.stdin = stdin;
                // The environment variable outranks `--effort`.
                if kind == CliKind::ClaudeCode && level.is_some() {
                    run.env_remove.push("CLAUDE_CODE_EFFORT_LEVEL");
                }
                process::run(run).await
            }
        };
        let mut effort_dropped = false;
        let mut output = attempt(level).await?;
        // Codex says which config value it rejected; run once more without it.
        if !output.success && kind == CliKind::Codex && level.is_some() && mentions_effort(&output)
        {
            effort_dropped = true;
            output = attempt(None).await?;
        }
        if !output.success {
            return Err(failure_error(kind, &output));
        }
        let text = match kind {
            CliKind::Codex => std::fs::read_to_string(&out_file).unwrap_or(output.stdout),
            _ => output.stdout,
        };
        let text = strip_ansi(&text).trim().to_string();
        if text.is_empty() {
            return Err(AiError::new(
                ErrorKind::Empty,
                format!("`{}` printed no reply", kind.binary()),
            ));
        }
        Ok(Reply {
            text,
            effort_dropped,
        })
    }
}

/// Whether a failed run's output blames the effort setting.
fn mentions_effort(output: &Output) -> bool {
    let said = format!("{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
    said.contains("reasoning_effort") || said.contains("reasoning effort")
}

/// Sent as the system prompt when the caller has none, so a CLI's own
/// default (a coding agent's long instructions) is never used.
const DEFAULT_SYSTEM: &str = "You are a helpful assistant. Reply concisely.";

fn system_or_default(system: &str) -> &str {
    if system.trim().is_empty() {
        DEFAULT_SYSTEM
    } else {
        system
    }
}

/// A TOML basic string, for `codex -c key=value` overrides.
fn toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `claude -p`, prompt on stdin. `--system-prompt` replaces Claude Code's own
/// system prompt (always passed, see [`DEFAULT_SYSTEM`]), and `--safe-mode`
/// leaves out the user's CLAUDE.md files, skills, plugins, hooks, output
/// styles and MCP servers. `--tools ""` turns every built-in tool off,
/// `--strict-mcp-config` with no config loads no MCP servers,
/// `--permission-mode dontAsk` denies anything that would ask, and
/// `--no-session-persistence` keeps these runs out of the user's history.
/// `--effort` is passed when there is a level (none: the CLI's default).
pub fn claude_args(model: &str, system: &str, effort: Option<Effort>) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "-p".into(),
        "--safe-mode".into(),
        "--output-format".into(),
        "text".into(),
        "--tools".into(),
        "".into(),
        "--strict-mcp-config".into(),
        "--disable-slash-commands".into(),
        "--permission-mode".into(),
        "dontAsk".into(),
        "--no-session-persistence".into(),
    ];
    if let Some(level) = effort {
        args.push("--effort".into());
        args.push(level.as_str().into());
    }
    args.push("--system-prompt".into());
    args.push(system_or_default(system).into());
    if !model.trim().is_empty() {
        args.push("--model".into());
        args.push(model.trim().into());
    }
    args
}

/// `codex exec -`, prompt on stdin. The system prompt is written to
/// `system_file` and replaces Codex's own base instructions
/// (`model_instructions_file`); the permissions, apps, collaboration-mode
/// and environment sections it would add are turned off, and no AGENTS.md
/// is read (`project_doc_max_bytes=0`). The user's `config.toml` is not loaded (`--ignore-user-config`;
/// sign-in still comes from `CODEX_HOME`), so MCP servers and other tools
/// configured there are not available to a run fed with terminal output;
/// `mcp_servers={}` makes sure of it. Read-only sandbox, no session files,
/// allowed outside a git repository, final message written to `out_file`
/// (stdout also carries progress). `model_reasoning_effort` is set when
/// there is a level.
pub fn codex_args(
    model: &str,
    cwd: &Path,
    out_file: &Path,
    system_file: &Path,
    effort: Option<Effort>,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "exec".into(),
        "--ignore-user-config".into(),
        "-c".into(),
        "mcp_servers={}".into(),
        "--sandbox".into(),
        "read-only".into(),
        "--skip-git-repo-check".into(),
        "--ephemeral".into(),
        "--color".into(),
        "never".into(),
        "-c".into(),
        format!(
            "model_instructions_file={}",
            toml_string(&system_file.to_string_lossy())
        )
        .into(),
    ];
    if let Some(level) = effort {
        args.push("-c".into());
        args.push(format!("model_reasoning_effort=\"{}\"", level.as_str()).into());
    }
    for key in [
        "include_permissions_instructions",
        "include_apps_instructions",
        "include_collaboration_mode_instructions",
        "include_environment_context",
    ] {
        args.push("-c".into());
        args.push(format!("{key}=false").into());
    }
    args.extend::<[OsString; 6]>([
        "-c".into(),
        "project_doc_max_bytes=0".into(),
        "-C".into(),
        cwd.into(),
        "-o".into(),
        out_file.into(),
    ]);
    if !model.trim().is_empty() {
        args.push("-m".into());
        args.push(model.trim().into());
    }
    args.push("-".into());
    args
}

/// `agy -p <prompt>` (the flag takes the prompt as its value; there is no
/// stdin form and no system flag). `--sandbox` restricts terminal access,
/// `--disable-slash-commands` keeps a prompt starting with `/` literal;
/// without `--dangerously-skip-permissions` tool permission requests are not
/// granted. `--effort` is passed when there is a level; Antigravity's model
/// ids can carry their own (`…-low`), and then none is given (see
/// `effort::cli_level`).
pub fn agy_args(model: &str, prompt: &str, effort: Option<Effort>) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "--sandbox".into(),
        "--disable-slash-commands".into(),
        "--output-format".into(),
        "text".into(),
    ];
    if let Some(level) = effort {
        args.push("--effort".into());
        args.push(level.as_str().into());
    }
    if !model.trim().is_empty() {
        args.push("--model".into());
        args.push(model.trim().into());
    }
    args.push("-p".into());
    args.push(prompt.into());
    args
}

pub fn combined_prompt(system: &str, prompt: &str) -> String {
    if system.trim().is_empty() {
        prompt.to_string()
    } else {
        format!("{}\n\n{}", system.trim_end(), prompt)
    }
}

/// `agy models` prints `id<TAB>display name` per line (after a status line).
pub fn parse_agy_models(stdout: &str) -> Vec<String> {
    let mut ids: Vec<String> = stdout
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(id, _)| id.trim().to_string())
        .filter(|id| !id.is_empty() && !id.contains(' '))
        .collect();
    ids.dedup();
    ids
}

fn expand_home(path: &str, home: Option<&Path>) -> PathBuf {
    match (path.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

fn first_line(text: &str) -> Option<String> {
    strip_ansi(text)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| truncate(l, 80))
}

/// The error for a CLI that exited unsuccessfully: the tail of what it said,
/// as `auth` when that looks like a login problem.
pub fn failure_error(kind: CliKind, output: &Output) -> AiError {
    let said = if output.stderr.trim().is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    let said = strip_ansi(said);
    let tail: Vec<&str> = said
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let tail = tail[tail.len().saturating_sub(3)..].join(" ");
    let lower = tail.to_ascii_lowercase();
    let auth = [
        "log in",
        "login",
        "logged in",
        "authenticat",
        "api key",
        "unauthorized",
    ]
    .iter()
    .any(|w| lower.contains(w));
    let status = match output.code {
        Some(code) => format!("exited with status {code}"),
        None => "was killed".to_string(),
    };
    let message = if tail.is_empty() {
        format!("`{}` {status}", kind.binary())
    } else {
        format!("`{}` {status}: {}", kind.binary(), truncate(&tail, 400))
    };
    AiError::new(
        if auth {
            ErrorKind::Auth
        } else {
            ErrorKind::Other
        },
        message,
    )
}

/// Removes ANSI escape sequences (CSI, OSC and two-byte escapes).
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                // Parameters and intermediates, then one final byte.
                for c in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                // Until BEL or ST (ESC \).
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Midterm's own pick: today's requests.
    const LOW: Resolved = Resolved {
        level: Some(Effort::Low),
        explicit: false,
        provider_default: false,
    };

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn claude_flags() {
        let args = strings(&claude_args("sonnet", "be terse", Some(Effort::Low)));
        assert!(args.windows(2).any(|w| w == ["--effort", "low"]));
        assert_eq!(args[0], "-p");
        let tools = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[tools + 1], "");
        assert!(
            args.windows(2)
                .any(|w| w == ["--system-prompt", "be terse"])
        );
        assert!(args.windows(2).any(|w| w == ["--model", "sonnet"]));
        assert!(
            args.windows(2)
                .any(|w| w == ["--permission-mode", "dontAsk"])
        );
        assert!(args.contains(&"--safe-mode".to_string()));
        let args = strings(&claude_args(" ", "", None));
        assert!(!args.contains(&"--model".to_string()));
        assert!(!args.contains(&"--effort".to_string()));
        let args = strings(&claude_args("", "", Some(Effort::Xhigh)));
        assert!(args.windows(2).any(|w| w == ["--effort", "xhigh"]));
        // Claude Code's own system prompt is never used.
        assert!(
            args.windows(2)
                .any(|w| w == ["--system-prompt", DEFAULT_SYSTEM])
        );
    }

    #[test]
    fn codex_flags() {
        let args = strings(&codex_args(
            "gpt-x",
            Path::new("/tmp/d"),
            Path::new("/tmp/d/o.txt"),
            Path::new("/tmp/d/i.md"),
            Some(Effort::High),
        ));
        assert!(
            args.windows(2)
                .any(|w| w == ["-c", "model_reasoning_effort=\"high\""])
        );
        assert!(
            args.windows(2)
                .any(|w| w == ["-c", "model_instructions_file=\"/tmp/d/i.md\""])
        );
        assert!(
            args.windows(2)
                .any(|w| w == ["-c", "project_doc_max_bytes=0"])
        );
        assert!(
            args.windows(2)
                .any(|w| w == ["-c", "include_environment_context=false"])
        );
        assert_eq!(args[0], "exec");
        assert!(args.contains(&"--ignore-user-config".to_string()));
        assert!(args.windows(2).any(|w| w == ["-c", "mcp_servers={}"]));
        assert!(args.windows(2).any(|w| w == ["--sandbox", "read-only"]));
        assert!(args.windows(2).any(|w| w == ["-o", "/tmp/d/o.txt"]));
        assert!(args.windows(2).any(|w| w == ["-C", "/tmp/d"]));
        assert!(args.windows(2).any(|w| w == ["-m", "gpt-x"]));
        assert_eq!(args.last().unwrap(), "-");
        assert!(
            !strings(&codex_args(
                "",
                Path::new("/a"),
                Path::new("/a/o"),
                Path::new("/a/i"),
                None
            ))
            .iter()
            .any(|a| a == "-m" || a.starts_with("model_reasoning_effort"))
        );
    }

    #[test]
    fn agy_flags() {
        let args = strings(&agy_args("", "hi", Some(Effort::Low)));
        assert!(args.windows(2).any(|w| w == ["--effort", "low"]));
        assert_eq!(args[args.len() - 2..], ["-p", "hi"]);
        let args = strings(&agy_args("gemini-x-low", "hi", None));
        assert!(args.windows(2).any(|w| w == ["--model", "gemini-x-low"]));
        assert!(!args.contains(&"--effort".to_string()));
        assert!(!args.contains(&"--dangerously-skip-permissions".to_string()));
    }

    #[test]
    fn outdated_versions() {
        assert_eq!(parse_version("2.1.329 (Claude Code)"), Some([2, 1, 329]));
        assert_eq!(parse_version("codex-cli 0.170.0"), Some([0, 170, 0]));
        assert!(outdated_note(CliKind::ClaudeCode, Some("2.1.168 (Claude Code)")).is_some());
        assert!(outdated_note(CliKind::ClaudeCode, Some("2.1.169 (Claude Code)")).is_none());
        assert!(outdated_note(CliKind::ClaudeCode, Some("garbled")).is_none());
        assert!(outdated_note(CliKind::Codex, Some("codex-cli 0.1.0")).is_none());
    }

    #[test]
    fn cli_levels() {
        use super::effort::cli_level;
        assert_eq!(
            cli_level(CliKind::Antigravity, "gemini-x-low", Some(Effort::High)),
            None
        );
        assert_eq!(
            cli_level(CliKind::Antigravity, "gemini-x", Some(Effort::High)),
            Some(Effort::High)
        );
        assert_eq!(cli_level(CliKind::Codex, "", None), None);
        let out = |stderr: &str| Output {
            success: false,
            code: Some(1),
            stdout: String::new(),
            stderr: stderr.into(),
        };
        assert!(mentions_effort(&out(
            "error: unknown variant `max` for model_reasoning_effort"
        )));
        assert!(!mentions_effort(&out("not logged in")));
    }

    #[test]
    fn toml_strings() {
        assert_eq!(toml_string(r#"/a "b"\c"#), r#""/a \"b\"\\c""#);
        assert_eq!(toml_string("a\nb"), r#""a\u000Ab""#);
    }

    #[test]
    fn combines_prompts() {
        assert_eq!(combined_prompt("sys\n", "p"), "sys\n\np");
        assert_eq!(combined_prompt("  ", "p"), "p");
    }

    #[test]
    fn parses_agy_models() {
        let out = "Fetching available models...\ngemini-a-high\tGemini A (High)\ngemini-a-low\tGemini A (Low)\n\n";
        assert_eq!(parse_agy_models(out), vec!["gemini-a-high", "gemini-a-low"]);
    }

    #[test]
    fn strips_ansi() {
        assert_eq!(strip_ansi("\x1b[1;32mok\x1b[0m"), "ok");
        assert_eq!(strip_ansi("\x1b]133;A\x07ls\x1b]7;file://h/\x1b\\"), "ls");
        assert_eq!(strip_ansi("plain é"), "plain é");
    }

    #[test]
    fn failure_errors() {
        let out = Output {
            success: false,
            code: Some(1),
            stdout: String::new(),
            stderr: "warn\nInvalid API key · Please run /login\n".into(),
        };
        let e = failure_error(CliKind::ClaudeCode, &out);
        assert_eq!(e.kind, ErrorKind::Auth);
        assert!(e.message.starts_with("`claude` exited with status 1: "));
        let out = Output {
            success: false,
            code: Some(2),
            stdout: "model x not recognized".into(),
            stderr: " ".into(),
        };
        let e = failure_error(CliKind::Antigravity, &out);
        assert_eq!(e.kind, ErrorKind::Other);
        assert!(e.message.contains("model x not recognized"));
    }

    #[test]
    fn expands_home() {
        assert_eq!(
            expand_home("~/bin/x", Some(Path::new("/h"))),
            PathBuf::from("/h/bin/x")
        );
        assert_eq!(
            expand_home("/abs", Some(Path::new("/h"))),
            PathBuf::from("/abs")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_a_fake_cli() {
        // A stand-in `claude` that echoes its stdin, checks its flags and
        // that it runs in an empty directory.
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("claude");
        std::fs::write(
            &fake,
            "#!/bin/sh\n[ \"$1\" = -p ] || exit 9\n[ -z \"$(ls -A)\" ] || exit 8\nprintf 'echo '; cat\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let discovery = Discovery::with_path_var("/usr/bin:/bin");
        let fake = fake.to_string_lossy().into_owned();
        let text = discovery
            .complete(CliKind::ClaudeCode, Some(&fake), "", "sys", "hello", &LOW)
            .await
            .unwrap()
            .text;
        assert_eq!(text, "echo hello");

        let status = discovery
            .status(CliKind::ClaudeCode, Some("/nonexistent/claude"))
            .await;
        assert!(!status.found);
        let e = discovery
            .complete(
                CliKind::ClaudeCode,
                Some("/nonexistent/claude"),
                "",
                "",
                "x",
                &LOW,
            )
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::NotFound);
    }

    /// Manual check against the CLIs installed on this machine:
    /// `cargo test live_clis -- --ignored --nocapture`. Spends a little quota.
    #[tokio::test]
    #[ignore = "runs the real CLIs on this machine"]
    async fn live_clis() {
        let discovery = Discovery::default();
        println!("PATH: {}", discovery.path_var().await);
        for kind in [CliKind::ClaudeCode, CliKind::Codex, CliKind::Antigravity] {
            println!("{:?}: {:?}", kind, discovery.status(kind, None).await);
        }
        let medium = Resolved {
            level: Some(Effort::Medium),
            explicit: true,
            provider_default: false,
        };
        for kind in [CliKind::ClaudeCode, CliKind::Codex, CliKind::Antigravity] {
            for resolved in [&LOW, &medium] {
                let reply = discovery
                    .complete(
                        kind,
                        None,
                        "",
                        "Answer with one shell command only.",
                        "List files, long format.",
                        resolved,
                    )
                    .await;
                println!("{kind:?} {:?} reply: {reply:?}", resolved.level);
            }
        }
        println!(
            "agy models: {:?}",
            discovery.models(CliKind::Antigravity, None).await
        );
    }
}
