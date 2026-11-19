//! Provider ids, their configuration from the webview, and what each one
//! is: an OpenAI-compatible API, the Anthropic API, or a local CLI.

use serde::{Deserialize, Serialize};

use super::error::AiError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderId {
    Openai,
    Anthropic,
    Deepseek,
    Openrouter,
    Gemini,
    Custom,
    ClaudeCode,
    Codex,
    Antigravity,
}

/// The settings the webview keeps for a provider. Keys are not here: they
/// live in the keychain (see `keys.rs`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: ProviderId,
    /// Overrides the default base URL; required for `custom`.
    #[serde(default)]
    pub base_url: Option<String>,
    /// Overrides where a CLI provider's executable is.
    #[serde(default)]
    pub cli_path: Option<String>,
}

/// Request-shape differences between OpenAI-compatible providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    OpenAi,
    DeepSeek,
    OpenRouter,
    Gemini,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliKind {
    ClaudeCode,
    Codex,
    Antigravity,
}

impl CliKind {
    /// The executable's name on PATH.
    pub fn binary(self) -> &'static str {
        match self {
            CliKind::ClaudeCode => "claude",
            CliKind::Codex => "codex",
            CliKind::Antigravity => "agy",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    OpenAiCompatible(Flavor),
    Anthropic,
    Cli(CliKind),
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Openai => "openai",
            ProviderId::Anthropic => "anthropic",
            ProviderId::Deepseek => "deepseek",
            ProviderId::Openrouter => "openrouter",
            ProviderId::Gemini => "gemini",
            ProviderId::Custom => "custom",
            ProviderId::ClaudeCode => "claude-code",
            ProviderId::Codex => "codex",
            ProviderId::Antigravity => "antigravity",
        }
    }

    pub fn backend(self) -> Backend {
        match self {
            ProviderId::Openai => Backend::OpenAiCompatible(Flavor::OpenAi),
            ProviderId::Deepseek => Backend::OpenAiCompatible(Flavor::DeepSeek),
            ProviderId::Openrouter => Backend::OpenAiCompatible(Flavor::OpenRouter),
            ProviderId::Gemini => Backend::OpenAiCompatible(Flavor::Gemini),
            ProviderId::Custom => Backend::OpenAiCompatible(Flavor::Custom),
            ProviderId::Anthropic => Backend::Anthropic,
            ProviderId::ClaudeCode => Backend::Cli(CliKind::ClaudeCode),
            ProviderId::Codex => Backend::Cli(CliKind::Codex),
            ProviderId::Antigravity => Backend::Cli(CliKind::Antigravity),
        }
    }

    /// Whether the provider takes an API key (every HTTP provider).
    pub fn uses_key(self) -> bool {
        !matches!(self.backend(), Backend::Cli(_))
    }

    /// Whether a request may go out without a key. Only `custom` (a local
    /// server often needs none).
    pub fn key_optional(self) -> bool {
        self == ProviderId::Custom
    }

    /// The base URL requests are made under, without a trailing slash.
    /// Paths such as `/chat/completions` or `/messages` are appended to it.
    pub fn default_base_url(self) -> Option<&'static str> {
        match self {
            ProviderId::Openai => Some("https://api.openai.com/v1"),
            ProviderId::Anthropic => Some("https://api.anthropic.com/v1"),
            ProviderId::Deepseek => Some("https://api.deepseek.com"),
            ProviderId::Openrouter => Some("https://openrouter.ai/api/v1"),
            ProviderId::Gemini => Some("https://generativelanguage.googleapis.com/v1beta/openai"),
            _ => None,
        }
    }
}

impl ProviderConfig {
    /// The base URL to use: the override if set, else the default. `custom`
    /// has no default. Only `http` and `https` URLs are accepted.
    pub fn base_url(&self) -> Result<String, AiError> {
        let chosen = self
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or(self.id.default_base_url())
            .ok_or_else(|| AiError::other("set a base URL for this provider"))?;
        let parsed = reqwest::Url::parse(chosen)
            .map_err(|e| AiError::other(format!("invalid base URL {chosen:?}: {e}")))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(AiError::other(format!(
                "the base URL must start with http:// or https:// (got {chosen:?})"
            )));
        }
        Ok(chosen.trim_end_matches('/').to_string())
    }

    /// The CLI path override, if any (blank counts as none).
    pub fn cli_path(&self) -> Option<&str> {
        self.cli_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(json: serde_json::Value) -> ProviderConfig {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn parses_ids_and_camel_case_fields() {
        let c = config(serde_json::json!({ "id": "claude-code", "cliPath": "/x/claude" }));
        assert_eq!(c.id, ProviderId::ClaudeCode);
        assert_eq!(c.cli_path(), Some("/x/claude"));
        assert_eq!(c.base_url, None);
        let c = config(serde_json::json!({ "id": "custom", "baseUrl": null }));
        assert_eq!(c.id, ProviderId::Custom);
        for id in [
            "openai",
            "anthropic",
            "deepseek",
            "openrouter",
            "gemini",
            "codex",
            "antigravity",
        ] {
            let c = config(serde_json::json!({ "id": id }));
            assert_eq!(c.id.as_str(), id);
        }
        assert!(
            serde_json::from_value::<ProviderConfig>(serde_json::json!({ "id": "nope" })).is_err()
        );
    }

    #[test]
    fn base_url_defaults_overrides_and_validation() {
        let c = config(serde_json::json!({ "id": "openai" }));
        assert_eq!(c.base_url().unwrap(), "https://api.openai.com/v1");
        let c =
            config(serde_json::json!({ "id": "openai", "baseUrl": " http://localhost:1234/v1/ " }));
        assert_eq!(c.base_url().unwrap(), "http://localhost:1234/v1");
        let c = config(serde_json::json!({ "id": "custom" }));
        assert!(c.base_url().is_err());
        let c = config(serde_json::json!({ "id": "custom", "baseUrl": "file:///etc" }));
        assert!(c.base_url().is_err());
        let c = config(serde_json::json!({ "id": "custom", "baseUrl": "" }));
        assert!(c.base_url().is_err());
    }

    #[test]
    fn keys() {
        assert!(ProviderId::Anthropic.uses_key());
        assert!(!ProviderId::Codex.uses_key());
        assert!(ProviderId::Custom.key_optional());
        assert!(!ProviderId::Openai.key_optional());
    }
}
