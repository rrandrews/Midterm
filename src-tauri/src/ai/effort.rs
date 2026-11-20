//! Reasoning effort: which levels each provider and model offers, what is
//! sent when the user has not chosen one, and how a level is clamped to
//! what the model takes. The request fields themselves are written by the
//! adapters (`openai.rs`, `anthropic.rs`, `cli.rs`). See `docs/ai.md`.
//!
//! Model families are matched by id prefix: the providers have no API that
//! lists effort levels (Anthropic's capabilities aside), so the few families
//! whose ladder differs are listed here. Unknown ids get the provider's full
//! ladder, and a rejected field is retried without it.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::provider::{CliKind, ProviderId};

/// One effort level, lowest first. `None` turns reasoning off where a
/// provider allows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::None => "none",
            Effort::Minimal => "minimal",
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::Xhigh => "xhigh",
            Effort::Max => "max",
        }
    }

    pub fn parse(word: &str) -> Option<Effort> {
        Some(match word {
            "none" => Effort::None,
            "minimal" => Effort::Minimal,
            "low" => Effort::Low,
            "medium" => Effort::Medium,
            "high" => Effort::High,
            "xhigh" => Effort::Xhigh,
            "max" => Effort::Max,
            _ => return None,
        })
    }
}

/// The stored setting: `default` sends nothing (the provider decides), a
/// level asks for that level. No setting at all is Midterm's own pick
/// ([`builtin`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EffortSetting {
    Default,
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl EffortSetting {
    pub fn level(self) -> Option<Effort> {
        match self {
            EffortSetting::Default => None,
            EffortSetting::None => Some(Effort::None),
            EffortSetting::Minimal => Some(Effort::Minimal),
            EffortSetting::Low => Some(Effort::Low),
            EffortSetting::Medium => Some(Effort::Medium),
            EffortSetting::High => Some(Effort::High),
            EffortSetting::Xhigh => Some(Effort::Xhigh),
            EffortSetting::Max => Some(Effort::Max),
        }
    }
}

use Effort::{High, Low, Max, Medium, Minimal, Xhigh};

const FULL: &[Effort] = &[Effort::None, Minimal, Low, Medium, High, Xhigh, Max];
const LOW_TO_MAX: &[Effort] = &[Low, Medium, High, Xhigh, Max];
const NONE_LOW_TO_MAX: &[Effort] = &[Effort::None, Low, Medium, High, Xhigh, Max];
const LOW_MEDIUM_HIGH: &[Effort] = &[Low, Medium, High];

/// OpenAI families whose ladder is not the full one; first match wins.
const OPENAI: &[(&str, &[Effort])] = &[
    ("gpt-6.2", LOW_TO_MAX),
    ("gpt-6.1-sol", LOW_TO_MAX),
    ("gpt-6-astra", LOW_TO_MAX),
    ("gpt-6", NONE_LOW_TO_MAX),
];

/// Gemini families (Gemini's OpenAI-compatible endpoint maps
/// `reasoning_effort` to its thinking level or budget); first match wins.
const GEMINI: &[(&str, &[Effort])] = &[
    ("gemini-4-neon", &[Low, Medium, High, Xhigh]),
    ("gemini-4-hydrogen", &[Low, Medium, High, Xhigh]),
    ("gemini-4-", LOW_MEDIUM_HIGH),
    ("gemini-3.8-flash", LOW_MEDIUM_HIGH),
    ("gemini-3-pro", &[Low, High]),
    ("gemini-3.1-pro", LOW_MEDIUM_HIGH),
    ("gemini-3", &[Minimal, Low, Medium, High]),
    ("gemini-2.5-pro", LOW_MEDIUM_HIGH),
    ("gemini-2.5-", &[Effort::None, Low, Medium, High]),
];

fn by_prefix(
    table: &[(&str, &'static [Effort])],
    model: &str,
    fallback: &'static [Effort],
) -> Vec<Effort> {
    let model = model.trim().to_ascii_lowercase();
    // OpenRouter-style ids carry a vendor prefix (`google/gemini-…`).
    let model = model.rsplit('/').next().unwrap_or(&model);
    table
        .iter()
        .find(|(prefix, _)| model.starts_with(prefix))
        .map_or(fallback, |(_, levels)| levels)
        .to_vec()
}

/// What an Anthropic model supports, from `GET /v1/models/{id}`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AnthropicCaps {
    /// The effort levels it takes (`output_config.effort`); empty if none.
    pub effort: Vec<Effort>,
    /// `thinking: {type: "adaptive"}`.
    pub adaptive: bool,
    /// `thinking: {type: "enabled", budget_tokens}`.
    pub budget: bool,
    /// The model's output cap (`max_tokens`).
    pub max_output: Option<u32>,
}

/// Antigravity model ids carry their effort (`gemini-…-low`).
pub fn agy_model_sets_effort(model: &str) -> bool {
    let model = model.trim();
    model
        .rsplit_once('-')
        .is_some_and(|(_, tail)| Effort::parse(tail).is_some())
}

/// The levels offered for `provider` and `model`, lowest first. Empty means
/// only "Provider default" (nothing is sent). `caps` is only used for
/// Anthropic; unknown capabilities offer the effort ladder.
pub fn levels(provider: ProviderId, model: &str, caps: Option<&AnthropicCaps>) -> Vec<Effort> {
    match provider {
        ProviderId::Openai => by_prefix(OPENAI, model, FULL),
        ProviderId::Gemini => by_prefix(GEMINI, model, LOW_MEDIUM_HIGH),
        ProviderId::Deepseek => vec![Effort::None, Low, High, Max],
        ProviderId::Openrouter => FULL.to_vec(),
        ProviderId::Custom => vec![Effort::None, Low, Medium, High],
        ProviderId::Anthropic => match caps {
            None => LOW_TO_MAX.to_vec(),
            Some(caps) if !caps.effort.is_empty() => caps.effort.clone(),
            Some(caps) if caps.budget => vec![Effort::None, Low, Medium, High],
            Some(_) => Vec::new(),
        },
        ProviderId::ClaudeCode | ProviderId::Codex => LOW_TO_MAX.to_vec(),
        ProviderId::Antigravity if agy_model_sets_effort(model) => Vec::new(),
        ProviderId::Antigravity => LOW_TO_MAX.to_vec(),
    }
}

/// What is sent when the user has chosen nothing: today's requests. Low
/// everywhere; nothing for a custom server (its support is unknown) or for
/// an Antigravity model chosen by id (the id carries its effort); off for
/// an Anthropic model that only has budget thinking.
pub fn builtin(provider: ProviderId, model: &str, caps: Option<&AnthropicCaps>) -> Option<Effort> {
    match provider {
        ProviderId::Custom => None,
        ProviderId::Antigravity if !model.trim().is_empty() => None,
        ProviderId::Anthropic if caps.is_some_and(|c| c.effort.is_empty()) => {
            caps.filter(|c| c.budget).map(|_| Effort::None)
        }
        _ => Some(Low),
    }
}

/// `requested` if offered, else the nearest offered level below it, else
/// the lowest above. Nothing when nothing is offered.
pub fn clamp(requested: Effort, levels: &[Effort]) -> Option<Effort> {
    if levels.contains(&requested) {
        return Some(requested);
    }
    levels
        .iter()
        .copied()
        .filter(|&l| l < requested)
        .max()
        .or_else(|| levels.iter().copied().filter(|&l| l > requested).min())
}

/// What one request sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resolved {
    /// The level to send; `None` sends no effort field.
    pub level: Option<Effort>,
    /// The user chose this level (not Midterm's pick).
    pub explicit: bool,
    /// The user chose "Provider default": nothing is sent, and the provider
    /// may think a lot.
    pub provider_default: bool,
}

/// Resolves the stored setting against what the model offers.
pub fn resolve(
    provider: ProviderId,
    model: &str,
    caps: Option<&AnthropicCaps>,
    setting: Option<EffortSetting>,
) -> Resolved {
    let offered = levels(provider, model, caps);
    match setting {
        Some(EffortSetting::Default) => Resolved {
            level: None,
            explicit: false,
            provider_default: true,
        },
        Some(setting) => Resolved {
            level: setting.level().and_then(|l| clamp(l, &offered)),
            explicit: true,
            provider_default: false,
        },
        None => Resolved {
            level: builtin(provider, model, caps).and_then(|l| clamp(l, &offered)),
            explicit: false,
            provider_default: false,
        },
    }
}

/// Output tokens added to the reply budget for reasoning: on current
/// models `max_tokens` covers thinking too, and too small a limit ends in
/// an empty reply.
pub fn headroom(resolved: &Resolved) -> u32 {
    match resolved.level {
        Some(Medium) => 8192,
        Some(High) => 16_384,
        Some(Xhigh | Max) => 32_768,
        Some(_) => 4096,
        // Many providers default to high.
        None if resolved.provider_default => 16_384,
        None => 4096,
    }
}

/// How much longer than the base timeout a request may take.
pub fn time_scale(resolved: &Resolved) -> u32 {
    match resolved.level {
        Some(High) => 2,
        Some(Xhigh | Max) => 3,
        Some(_) => 1,
        None if resolved.provider_default => 2,
        None => 1,
    }
}

pub fn scaled(base: Duration, resolved: &Resolved) -> Duration {
    base * time_scale(resolved)
}

/// A note shown under the picker, when the options need one.
pub fn note(provider: ProviderId, model: &str, caps_failed: bool) -> Option<String> {
    match provider {
        ProviderId::Antigravity if agy_model_sets_effort(model) => {
            Some("This model id sets its own effort.".into())
        }
        ProviderId::Anthropic if caps_failed => {
            Some("Could not read the model’s capabilities; all levels are shown.".into())
        }
        ProviderId::Custom => {
            Some("Sent as reasoning_effort; dropped if the server rejects it.".into())
        }
        _ => None,
    }
}

/// The CLI's effort flag value, if it takes one at this level.
pub fn cli_level(kind: CliKind, model: &str, level: Option<Effort>) -> Option<Effort> {
    let level = level?;
    match kind {
        CliKind::Antigravity if agy_model_sets_effort(model) => None,
        _ => Some(level),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_by_provider_and_model() {
        assert_eq!(levels(ProviderId::Openai, "gpt-6.2-mini", None), LOW_TO_MAX);
        assert_eq!(
            levels(ProviderId::Openai, "gpt-6-turbo", None),
            NONE_LOW_TO_MAX
        );
        assert_eq!(levels(ProviderId::Openai, "o9", None), FULL);
        assert_eq!(
            levels(ProviderId::Gemini, "gemini-3-pro-preview", None),
            vec![Low, High]
        );
        assert_eq!(
            levels(ProviderId::Gemini, "gemini-3-flash", None),
            vec![Minimal, Low, Medium, High]
        );
        assert_eq!(
            levels(ProviderId::Gemini, "gemini-2.5-flash", None),
            vec![Effort::None, Low, Medium, High]
        );
        assert_eq!(
            levels(ProviderId::Gemini, "something-else", None),
            LOW_MEDIUM_HIGH
        );
        assert_eq!(
            levels(ProviderId::Openrouter, "google/gemini-3-pro", None),
            FULL
        );
        assert_eq!(
            levels(ProviderId::Deepseek, "deepseek-v4", None),
            vec![Effort::None, Low, High, Max]
        );
        assert_eq!(
            levels(ProviderId::Custom, "x", None),
            vec![Effort::None, Low, Medium, High]
        );
        assert_eq!(levels(ProviderId::Codex, "", None), LOW_TO_MAX);
        assert!(levels(ProviderId::Antigravity, "gemini-4-pro-high", None).is_empty());
        assert_eq!(levels(ProviderId::Antigravity, "", None), LOW_TO_MAX);
    }

    #[test]
    fn anthropic_levels_follow_capabilities() {
        assert_eq!(levels(ProviderId::Anthropic, "m", None), LOW_TO_MAX);
        let caps = AnthropicCaps {
            effort: vec![Low, Medium, High, Max],
            adaptive: true,
            ..Default::default()
        };
        assert_eq!(
            levels(ProviderId::Anthropic, "m", Some(&caps)),
            vec![Low, Medium, High, Max]
        );
        let budget = AnthropicCaps {
            budget: true,
            ..Default::default()
        };
        assert_eq!(
            levels(ProviderId::Anthropic, "m", Some(&budget)),
            vec![Effort::None, Low, Medium, High]
        );
        assert!(levels(ProviderId::Anthropic, "m", Some(&AnthropicCaps::default())).is_empty());
    }

    #[test]
    fn builtin_reproduces_todays_requests() {
        assert_eq!(builtin(ProviderId::Openai, "m", None), Some(Low));
        assert_eq!(builtin(ProviderId::Custom, "m", None), None);
        assert_eq!(builtin(ProviderId::Antigravity, "", None), Some(Low));
        assert_eq!(builtin(ProviderId::Antigravity, "gemini-x", None), None);
        assert_eq!(builtin(ProviderId::Anthropic, "m", None), Some(Low));
        let budget = AnthropicCaps {
            budget: true,
            ..Default::default()
        };
        assert_eq!(
            builtin(ProviderId::Anthropic, "m", Some(&budget)),
            Some(Effort::None)
        );
        assert_eq!(
            builtin(ProviderId::Anthropic, "m", Some(&AnthropicCaps::default())),
            None
        );
    }

    #[test]
    fn clamps() {
        assert_eq!(clamp(High, &[Low, Medium, High]), Some(High));
        assert_eq!(clamp(Max, &[Low, Medium, High]), Some(High));
        assert_eq!(clamp(Medium, &[Low, High]), Some(Low));
        assert_eq!(clamp(Effort::None, &[Low, High]), Some(Low));
        assert_eq!(clamp(Minimal, &[Effort::None, Low]), Some(Effort::None));
        assert_eq!(clamp(Low, &[]), None);
    }

    #[test]
    fn resolves_settings() {
        let r = resolve(
            ProviderId::Gemini,
            "gemini-3-pro",
            None,
            Some(EffortSetting::Medium),
        );
        assert_eq!(r.level, Some(Low));
        assert!(r.explicit);
        let r = resolve(
            ProviderId::Openai,
            "gpt-6.2",
            None,
            Some(EffortSetting::Default),
        );
        assert_eq!(r.level, None);
        assert!(r.provider_default);
        let r = resolve(ProviderId::Openai, "gpt-6.2", None, None);
        assert_eq!(r.level, Some(Low));
        assert!(!r.explicit);
        let r = resolve(ProviderId::Custom, "x", None, None);
        assert_eq!(r.level, None);
        assert!(!r.provider_default);
    }

    #[test]
    fn headroom_and_time_scale() {
        let at = |level, provider_default| Resolved {
            level,
            explicit: true,
            provider_default,
        };
        assert_eq!(headroom(&at(Some(Low), false)), 4096);
        assert_eq!(headroom(&at(Some(Medium), false)), 8192);
        assert_eq!(headroom(&at(Some(High), false)), 16_384);
        assert_eq!(headroom(&at(Some(Max), false)), 32_768);
        assert_eq!(headroom(&at(None, true)), 16_384);
        assert_eq!(headroom(&at(None, false)), 4096);
        assert_eq!(time_scale(&at(Some(Medium), false)), 1);
        assert_eq!(time_scale(&at(Some(High), false)), 2);
        assert_eq!(time_scale(&at(Some(Xhigh), false)), 3);
        assert_eq!(time_scale(&at(None, true)), 2);
    }

    #[test]
    fn agy_suffixes() {
        assert!(agy_model_sets_effort("gemini-4-pro-low"));
        assert!(agy_model_sets_effort("gemini-4-pro-xhigh"));
        assert!(!agy_model_sets_effort("gemini-4-pro"));
        assert!(!agy_model_sets_effort(""));
    }

    #[test]
    fn settings_parse() {
        let s: EffortSetting = serde_json::from_str("\"xhigh\"").unwrap();
        assert_eq!(s.level(), Some(Xhigh));
        let s: EffortSetting = serde_json::from_str("\"default\"").unwrap();
        assert_eq!(s.level(), None);
        assert!(serde_json::from_str::<EffortSetting>("\"ultra\"").is_err());
    }
}
