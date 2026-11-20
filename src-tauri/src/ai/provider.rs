//! Provider ids, their configuration from the webview, and what each one
//! is: an OpenAI-compatible API, the Anthropic API, or a local CLI.

use serde::{Deserialize, Serialize};

use super::effort::EffortSetting;
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

/// What a request goes to: a model profile as the webview resolved it for a
/// feature. `extra` is the profile's extra request JSON (API providers only;
/// see `extra.rs`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub provider: ProviderConfig,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: Option<EffortSetting>,
    #[serde(default)]
    pub extra: Option<serde_json::Map<String, serde_json::Value>>,
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
    /// The base URL to use. Only `custom` takes one from the webview: the
    /// other providers always use their default, so a stored key can only
    /// go to its provider. The URL must be `https://`, or `http://` to a
    /// loopback host (a local server), and have no query or fragment
    /// (paths are appended to it).
    pub fn base_url(&self) -> Result<String, AiError> {
        let chosen = match self.id.default_base_url() {
            Some(default) => default,
            None => self
                .base_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AiError::other("set a base URL for this provider"))?,
        };
        let parsed = reqwest::Url::parse(chosen)
            .map_err(|e| AiError::other(format!("invalid base URL {chosen:?}: {e}")))?;
        let loopback = parsed
            .host_str()
            .map(|h| h.trim_start_matches('[').trim_end_matches(']'))
            .is_some_and(|h| {
                h.eq_ignore_ascii_case("localhost")
                    || h.parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            });
        match parsed.scheme() {
            "https" => {}
            "http" if loopback => {}
            _ => {
                return Err(AiError::other(format!(
                    "the base URL must use https:// (http:// only for localhost); got {chosen:?}"
                )));
            }
        }
        if parsed.query().is_some() || parsed.fragment().is_some() {
            return Err(AiError::other(format!(
                "the base URL cannot have a query or fragment (got {chosen:?})"
            )));
        }
        Ok(chosen.trim_end_matches('/').to_string())
    }

    /// The keychain account this provider's key is stored under: the
    /// provider id, except for `custom`, whose key is bound to its endpoint
    /// as `custom:<base URL>` (normalized exactly as requests use it). A key
    /// saved for one custom URL is then never sent to another: changing the
    /// URL finds no key. CLI providers take no key.
    pub fn key_account(&self) -> Result<String, AiError> {
        if !self.id.uses_key() {
            return Err(AiError::other(format!(
                "{} does not use an API key",
                self.id.as_str()
            )));
        }
        Ok(match self.id {
            ProviderId::Custom => format!("custom:{}", self.base_url()?),
            id => id.as_str().to_string(),
        })
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
    fn parses_targets() {
        let t: Target = serde_json::from_value(serde_json::json!({
            "provider": { "id": "openrouter" },
            "model": "openai/gpt-4o",
            "effort": "high",
            "extra": { "provider": { "order": ["x"] } }
        }))
        .unwrap();
        assert_eq!(t.provider.id, ProviderId::Openrouter);
        assert_eq!(t.model, "openai/gpt-4o");
        assert_eq!(t.effort, Some(EffortSetting::High));
        assert_eq!(t.extra.unwrap()["provider"]["order"][0], "x");
        // Only the provider is required.
        let t: Target =
            serde_json::from_value(serde_json::json!({ "provider": { "id": "codex" } })).unwrap();
        assert_eq!(t.model, "");
        assert!(t.effort.is_none() && t.extra.is_none());
        // Extra must be an object.
        assert!(
            serde_json::from_value::<Target>(serde_json::json!({
                "provider": { "id": "openai" }, "extra": [1]
            }))
            .is_err()
        );
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
        // Only `custom` takes an override, so keys stay with their provider.
        let c = config(serde_json::json!({ "id": "openai", "baseUrl": "https://evil.example/v1" }));
        assert_eq!(c.base_url().unwrap(), "https://api.openai.com/v1");
        let c =
            config(serde_json::json!({ "id": "custom", "baseUrl": " http://localhost:1234/v1/ " }));
        assert_eq!(c.base_url().unwrap(), "http://localhost:1234/v1");
        let c = config(serde_json::json!({ "id": "custom", "baseUrl": "http://127.0.0.1:8080" }));
        assert_eq!(c.base_url().unwrap(), "http://127.0.0.1:8080");
        let c = config(serde_json::json!({ "id": "custom", "baseUrl": "http://[::1]:9/v1" }));
        assert_eq!(c.base_url().unwrap(), "http://[::1]:9/v1");
        let c = config(serde_json::json!({ "id": "custom", "baseUrl": "https://gw.example/v1" }));
        assert_eq!(c.base_url().unwrap(), "https://gw.example/v1");
        for bad in [
            serde_json::Value::Null,
            "".into(),
            "file:///etc".into(),
            "http://gw.example/v1".into(),
            "https://gw.example/v1?tenant=a".into(),
            "https://gw.example/v1#x".into(),
        ] {
            let c = config(serde_json::json!({ "id": "custom", "baseUrl": bad }));
            assert!(c.base_url().is_err(), "{:?} accepted", c.base_url);
        }
    }

    #[test]
    fn keys() {
        assert!(ProviderId::Anthropic.uses_key());
        assert!(!ProviderId::Codex.uses_key());
        assert!(ProviderId::Custom.key_optional());
        assert!(!ProviderId::Openai.key_optional());
    }

    #[test]
    fn key_accounts() {
        let account = |json| config(json).key_account();
        assert_eq!(
            account(serde_json::json!({ "id": "openai" })).unwrap(),
            "openai"
        );
        // Other providers ignore `baseUrl`.
        assert_eq!(
            account(serde_json::json!({ "id": "anthropic", "baseUrl": "https://x.example" }))
                .unwrap(),
            "anthropic"
        );
        // `custom` is bound to its normalized base URL.
        assert_eq!(
            account(serde_json::json!({ "id": "custom", "baseUrl": " https://gw.example/v1/ " }))
                .unwrap(),
            "custom:https://gw.example/v1"
        );
        assert_ne!(
            account(serde_json::json!({ "id": "custom", "baseUrl": "https://gw.example/v1" })),
            account(serde_json::json!({ "id": "custom", "baseUrl": "https://other.example/v1" }))
        );
        assert!(account(serde_json::json!({ "id": "custom" })).is_err());
        assert!(
            account(serde_json::json!({ "id": "custom", "baseUrl": "http://gw.example" })).is_err()
        );
        assert!(account(serde_json::json!({ "id": "codex" })).is_err());
    }
}
