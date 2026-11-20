//! What differs per agent (MID-85): the adapter and its version bounds, the
//! process environment, the `session/new` extras, which tool calls are
//! Midterm's, the permission mode, and how prompt text is escaped. Only
//! Claude Code has a spec so far; Codex (MID-90) slots in as another
//! [`AgentSpec`].
//!
//! The Claude Code recipe was verified live in the MID-82 spike
//! (claude-agent-acp 0.109.0, Claude Code 2.1.329); see `docs/ai.md`.

use std::ffi::OsString;
use std::path::Path;

use agent_client_protocol::v1::schema::{
    SessionConfigKind, SessionConfigOption, SessionConfigSelectOptions,
};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::ai::agent::ToolDef;
use crate::ai::effort::{self, EffortSetting};
use crate::ai::error::AiError;
use crate::ai::provider::{CliKind, ProviderId};

/// The name of the MCP server Midterm serves its tools as.
pub const SERVER_NAME: &str = "midterm";
/// How Claude Code names Midterm's tools: `mcp__<server>__<tool>`.
pub const TOOL_PREFIX: &str = "mcp__midterm__";

/// One agent's ACP adapter and session recipe.
#[derive(Debug)]
pub struct AgentSpec {
    pub kind: CliKind,
    /// The adapter's executable name on PATH.
    pub adapter: &'static str,
    /// The npm package that installs it.
    pub package: &'static str,
    /// The oldest adapter version with what the recipe needs.
    pub min_adapter: [u32; 3],
    /// The newest adapter `major.minor` that was tested; newer ones warn.
    pub tested_adapter: [u32; 2],
    /// The oldest CLI version the recipe works with.
    pub min_cli: Option<[u32; 3]>,
    /// The oldest Node.js major version the adapter runs on.
    pub min_node: Option<u32>,
}

/// Claude Code over `claude-agent-acp`. 0.108.0 brought what the recipe
/// uses (changelog); Claude Code 2.1.326 is the first with
/// `mcpServersDelivery: "initialize"`, which keeps MCP configs (and the
/// adapter's bridge token) off the CLI's argv.
pub const CLAUDE_CODE: AgentSpec = AgentSpec {
    kind: CliKind::ClaudeCode,
    adapter: "claude-agent-acp",
    package: "@agentclientprotocol/claude-agent-acp",
    min_adapter: [0, 108, 0],
    tested_adapter: [0, 109],
    min_cli: Some([2, 1, 326]),
    min_node: Some(22),
};

/// The agent spec for a CLI, if the agent supports it over ACP yet.
pub fn spec(kind: CliKind) -> Option<&'static AgentSpec> {
    match kind {
        CliKind::ClaudeCode => Some(&CLAUDE_CODE),
        CliKind::Codex | CliKind::Antigravity => None,
    }
}

/// The error for a CLI the agent cannot drive yet.
pub fn unsupported(kind: CliKind) -> AiError {
    AiError::other(format!(
        "The agent doesn't support {} yet. Choose a Claude Code or API model for Agent in Settings → AI.",
        label(kind)
    ))
}

pub fn label(kind: CliKind) -> &'static str {
    match kind {
        CliKind::ClaudeCode => "Claude Code",
        CliKind::Codex => "Codex",
        CliKind::Antigravity => "Antigravity",
    }
}

fn dotted(v: [u32; 3]) -> String {
    format!("{}.{}.{}", v[0], v[1], v[2])
}

impl AgentSpec {
    pub fn install_hint(&self) -> String {
        format!("npm install -g {}", self.package)
    }

    /// Environment variables set for the adapter (besides PATH), given the
    /// resolved CLI executable.
    pub fn env(&self, cli: &Path) -> Vec<(OsString, OsString)> {
        match self.kind {
            CliKind::ClaudeCode => vec![
                ("CLAUDE_CODE_EXECUTABLE".into(), cli.into()),
                ("CLAUDE_CODE_DISABLE_AUTO_MEMORY".into(), "1".into()),
            ],
            _ => Vec::new(),
        }
    }

    /// Environment variables removed: Claude Code refuses to start inside
    /// another session when the first two are inherited, and the effort
    /// variable would outrank the `effort` config option.
    pub fn env_remove(&self) -> Vec<&'static str> {
        match self.kind {
            CliKind::ClaudeCode => vec![
                "CLAUDECODE",
                "CLAUDE_CODE_ENTRYPOINT",
                "CLAUDE_CODE_EFFORT_LEVEL",
            ],
            _ => Vec::new(),
        }
    }

    /// `_meta` on `session/new`. For Claude Code, Agent SDK options that win
    /// over the adapter's defaults: no built-in tools, no settings or
    /// CLAUDE.md files, no session file, only Midterm's MCP server (sent in
    /// the SDK's initialize message, not on the argv), never skip
    /// permissions, and Midterm's tools pre-allowed.
    pub fn session_meta(&self, tools: &[ToolDef]) -> Map<String, Value> {
        let mut meta = Map::new();
        if self.kind == CliKind::ClaudeCode {
            let allowed: Vec<String> = tools
                .iter()
                .map(|t| format!("{TOOL_PREFIX}{}", t.name))
                .collect();
            meta.insert(
                "claudeCode".into(),
                json!({
                    "options": {
                        "tools": [],
                        "settingSources": [],
                        "persistSession": false,
                        "strictMcpConfig": true,
                        "allowDangerouslySkipPermissions": false,
                        "mcpServersDelivery": "initialize",
                        "allowedTools": allowed,
                    }
                }),
            );
        }
        meta
    }

    /// Whether a tool call (a `tool_call` update or a permission request's
    /// `toolCall`, as JSON) is one of Midterm's tools. Claude Code names the
    /// SDK tool in `_meta.claudeCode.toolName`; the ACP `name` is the
    /// fallback.
    pub fn is_ours(&self, tool_call: &Value) -> bool {
        let sdk_name = tool_call
            .pointer("/_meta/claudeCode/toolName")
            .and_then(Value::as_str);
        let name = sdk_name.or_else(|| tool_call.get("name").and_then(Value::as_str));
        name.is_some_and(|n| n.starts_with(TOOL_PREFIX))
    }

    /// The permission mode set after `session/new` (Claude Code starts in
    /// `auto` or the user's default mode).
    pub fn mode(&self) -> Option<&'static str> {
        match self.kind {
            CliKind::ClaudeCode => Some("default"),
            _ => None,
        }
    }

    /// The prompt text as sent. Claude Code runs a message that starts with
    /// `/` as a slash command (its skills and commands stay listed), so a
    /// leading space is added; verified live that `" /context"` reaches the
    /// model as text while `"/context"` runs the command.
    pub fn prompt_text(&self, text: &str) -> String {
        match self.kind {
            CliKind::ClaudeCode if text.starts_with('/') => format!(" {text}"),
            _ => text.to_string(),
        }
    }

    /// The sign-in hint for an `auth` error.
    pub fn sign_in_hint(&self) -> &'static str {
        match self.kind {
            CliKind::ClaudeCode => "Sign in by running `claude` in a terminal.",
            CliKind::Codex => "Sign in with `codex login`.",
            CliKind::Antigravity => "Sign in with `agy acp --login`.",
        }
    }
}

/* ---- Config options ---- */

/// The values a select option offers (grouped ones flattened).
pub fn values(option: &SessionConfigOption) -> Vec<String> {
    match &option.kind {
        SessionConfigKind::Select(select) => match &select.options {
            SessionConfigSelectOptions::Ungrouped(options) => {
                options.iter().map(|o| o.value.to_string()).collect()
            }
            SessionConfigSelectOptions::Grouped(groups) => groups
                .iter()
                .flat_map(|g| g.options.iter().map(|o| o.value.to_string()))
                .collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn current(option: &SessionConfigOption) -> Option<String> {
    match &option.kind {
        SessionConfigKind::Select(select) => Some(select.current_value.to_string()),
        _ => None,
    }
}

/// The select option of `category` (by category, else by id).
fn find<'a>(options: &'a [SessionConfigOption], category: &str) -> Option<&'a SessionConfigOption> {
    let is_select = |o: &&SessionConfigOption| matches!(o.kind, SessionConfigKind::Select(_));
    let category_of = |o: &SessionConfigOption| {
        o.category
            .as_ref()
            .and_then(|c| serde_json::to_value(c).ok())
            .and_then(|v| v.as_str().map(str::to_string))
    };
    options
        .iter()
        .filter(is_select)
        .find(|o| category_of(o).as_deref() == Some(category))
        .or_else(|| {
            options
                .iter()
                .filter(is_select)
                .find(|o| o.id.to_string() == category)
        })
}

/// A `session/set_config_option` to send: option id and value.
pub type Pick = (String, String);

/// Sets `option` to `value` unless it already has it.
fn pick(option: &SessionConfigOption, value: String) -> Option<Pick> {
    (current(option).as_deref() != Some(value.as_str())).then(|| (option.id.to_string(), value))
}

/// The permission mode, when the agent offers it.
pub fn pick_mode(options: &[SessionConfigOption], mode: &str) -> Option<Pick> {
    let option = find(options, "mode")?;
    values(option)
        .contains(&mode.to_string())
        .then(|| pick(option, mode.to_string()))?
}

/// The profile's model, matched against the `model` option's values: exactly,
/// then ignoring case (aliases such as `sonnet` are values). An empty model
/// leaves the agent's default; a model the agent does not offer is an error
/// listing what it does offer.
pub fn pick_model(options: &[SessionConfigOption], model: &str) -> Result<Option<Pick>, AiError> {
    let model = model.trim();
    if model.is_empty() {
        return Ok(None);
    }
    let Some(option) = find(options, "model") else {
        eprintln!("ai acp: the agent has no model option; {model:?} not set");
        return Ok(None);
    };
    let offered = values(option);
    let found = offered
        .iter()
        .find(|v| v.as_str() == model)
        .or_else(|| offered.iter().find(|v| v.eq_ignore_ascii_case(model)));
    match found {
        Some(value) => Ok(pick(option, value.clone())),
        None => Err(AiError::other(format!(
            "The agent does not offer the model {model:?}. It offers: {}.",
            offered.join(", ")
        ))),
    }
}

/// The effort level for `setting` (see `docs/ai.md`): Midterm's pick when
/// unset, nothing for `default`, else the level clamped to what the
/// `thought_level` option offers.
pub fn pick_effort(
    options: &[SessionConfigOption],
    kind: CliKind,
    model: &str,
    setting: Option<EffortSetting>,
) -> Option<Pick> {
    let option = find(options, "thought_level")?;
    let provider = match kind {
        CliKind::ClaudeCode => ProviderId::ClaudeCode,
        CliKind::Codex => ProviderId::Codex,
        CliKind::Antigravity => ProviderId::Antigravity,
    };
    let level = effort::resolve(provider, model, None, setting).level?;
    let offered: Vec<effort::Effort> = values(option)
        .iter()
        .filter_map(|v| effort::Effort::parse(v))
        .collect();
    let level = effort::clamp(level, &offered)?;
    pick(option, level.as_str().to_string())
}

/* ---- Status ---- */

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub path: String,
    pub version: String,
}

/// Whether the agent can run over ACP with this CLI (`ai_cli_status.agent`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<AdapterInfo>,
    /// Why it is not ready (with the fix).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    /// A warning that does not block (an untested adapter version).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// What the status checks found.
pub struct Found<'a> {
    /// The CLI's `--version` line, if the CLI was found.
    pub cli: Option<Option<&'a str>>,
    /// The adapter's path and `--version` line, if found.
    pub adapter: Option<(String, Option<String>)>,
    /// `node --version`, if node was found.
    pub node: Option<String>,
}

/// Judges the checks (pure). Problems are listed in the order a user would
/// fix them.
pub fn judge(spec: &AgentSpec, found: Found) -> AgentStatus {
    use crate::ai::cli::parse_version;
    let install = spec.install_hint();
    let mut status = AgentStatus {
        ready: false,
        adapter: None,
        problem: None,
        note: None,
    };
    let Some((path, version)) = found.adapter else {
        status.problem = Some(format!(
            "{} is not on the login shell's PATH. Install it with `{install}`.",
            spec.adapter
        ));
        return status;
    };
    let version = version.unwrap_or_default();
    status.adapter = Some(AdapterInfo {
        path,
        version: version.clone(),
    });
    let problem = match parse_version(&version) {
        None => Some(format!(
            "{} --version failed. Reinstall it with `{install}`.",
            spec.adapter
        )),
        Some(v) if v < spec.min_adapter => Some(format!(
            "{} {} is too old; {} or later is needed. Update it with `{install}`.",
            spec.adapter,
            dotted(v),
            dotted(spec.min_adapter)
        )),
        Some(v) => {
            if [v[0], v[1]] > spec.tested_adapter {
                status.note = Some(format!(
                    "{} {} is newer than the tested {}.{}.x; report problems.",
                    spec.adapter,
                    dotted(v),
                    spec.tested_adapter[0],
                    spec.tested_adapter[1]
                ));
            }
            None
        }
    };
    let problem = problem
        .or_else(|| node_problem(spec, found.node.as_deref()))
        .or_else(|| cli_problem(spec, found.cli));
    status.ready = problem.is_none();
    status.problem = problem;
    status
}

fn node_problem(spec: &AgentSpec, node: Option<&str>) -> Option<String> {
    let min = spec.min_node?;
    let Some(node) = node else {
        return Some(format!(
            "node is not on the login shell's PATH; {} needs Node.js {min} or later.",
            spec.adapter
        ));
    };
    let major = node
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|m| m.parse::<u32>().ok());
    match major {
        Some(major) if major >= min => None,
        _ => Some(format!(
            "{} needs Node.js {min} or later; node --version says {}.",
            spec.adapter,
            node.trim()
        )),
    }
}

fn cli_problem(spec: &AgentSpec, cli: Option<Option<&str>>) -> Option<String> {
    let binary = spec.kind.binary();
    let Some(version) = cli else {
        return Some(format!("{binary} is not on the login shell's PATH."));
    };
    let min = spec.min_cli?;
    let found = crate::ai::cli::parse_version(version?)?;
    (found < min).then(|| {
        format!(
            "{} {} is too old for the agent; {} or later is needed. Update it with `{binary} update`.",
            label(spec.kind),
            dotted(found),
            dotted(min)
        )
    })
}

/// Runs the status checks: the adapter on the login shell's PATH (or the
/// override) and its version, `node --version`, and the CLI's version
/// (from `cli`). Nothing is started beyond `--version` calls.
pub async fn status(
    discovery: &crate::ai::cli::Discovery,
    spec: &AgentSpec,
    cli: &crate::ai::cli::CliStatus,
    acp_path: Option<&str>,
) -> AgentStatus {
    let adapter = discovery.locate_named(spec.adapter, acp_path).await.ok();
    let node = async {
        let path = discovery.locate_named("node", None).await.ok()?;
        discovery.version_line(path).await
    };
    let adapter_version = async {
        match &adapter {
            Some(path) => discovery.version_line(path.clone()).await,
            None => None,
        }
    };
    let (node, adapter_version) = tokio::join!(node, adapter_version);
    judge(
        spec,
        Found {
            cli: cli.found.then_some(cli.version.as_deref()),
            adapter: adapter.map(|p| (p.to_string_lossy().into_owned(), adapter_version)),
            node,
        },
    )
}
