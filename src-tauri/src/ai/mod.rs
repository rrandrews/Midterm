//! AI providers for next-command suggestions. The webview never talks to a
//! provider and never sees a key: it calls the commands in `commands.rs`,
//! and this module makes the HTTP request or runs the CLI. See `docs/ai.md`.

mod anthropic;
mod cli;
pub mod commands;
pub mod effort;
mod error;
mod http;
pub(crate) mod keys;
mod openai;
mod process;
mod provider;
mod shell_path;
#[cfg(test)]
mod stub;

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::oneshot;

use effort::{AnthropicCaps, Effort, EffortSetting, Resolved};
pub use error::{AiError, ErrorKind};
pub use provider::{Backend, ProviderConfig, ProviderId};

/// What one completion asks for, whichever adapter sends it.
pub struct Completion<'a> {
    pub model: &'a str,
    pub system: &'a str,
    pub prompt: &'a str,
    /// The whole output budget, thinking included.
    pub max_tokens: u32,
    /// The reasoning effort to send; `None` sends no effort field.
    pub effort: Option<Effort>,
    /// Total time allowed for the request.
    pub timeout: Duration,
}

/// A completion's text, and whether the provider rejected the effort field
/// (the request was then sent again without it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub text: String,
    pub effort_dropped: bool,
}

/// The reply budget when the caller gives none.
const DEFAULT_REPLY_TOKENS: u32 = 512;
const MAX_REPLY_TOKENS: u32 = 32_000;

/// The reply budget for a requested `reply` tokens.
pub fn reply_budget(reply: Option<u32>) -> u32 {
    reply
        .unwrap_or(DEFAULT_REPLY_TOKENS)
        .clamp(16, MAX_REPLY_TOKENS)
}

/// The `max_tokens` sent for a reply budget of `reply` tokens: room for the
/// model's reasoning is added (see [`effort::headroom`]).
pub fn output_budget(reply: Option<u32>, resolved: &Resolved) -> u32 {
    reply_budget(reply) + effort::headroom(resolved)
}

/// What Settings → AI shows for the effort picker.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EffortOptions {
    /// Offered levels, lowest first; "Provider default" is always offered too.
    pub levels: Vec<Effort>,
    /// What would be sent for the stored setting (`None`: nothing).
    pub effective: Option<Effort>,
    pub note: Option<String>,
}

/// Remembers effort fields a provider rejected, until restart, so later
/// requests do not pay for a failed attempt first. Keyed by provider and
/// base URL, model and level: rejecting `xhigh` says nothing about `low`.
#[derive(Default)]
struct Rejections(Mutex<HashSet<(String, String, Effort)>>);

impl Rejections {
    fn key(provider: &ProviderConfig, model: &str, level: Effort) -> (String, String, Effort) {
        let endpoint = format!(
            "{}|{}",
            provider.id.as_str(),
            provider.base_url.as_deref().unwrap_or("")
        );
        (endpoint, model.to_string(), level)
    }

    fn contains(&self, provider: &ProviderConfig, model: &str, level: Effort) -> bool {
        self.0
            .lock()
            .unwrap()
            .contains(&Self::key(provider, model, level))
    }

    fn insert(&self, provider: &ProviderConfig, model: &str, level: Effort) {
        self.0
            .lock()
            .unwrap()
            .insert(Self::key(provider, model, level));
    }
}

/// How many cancels of not-yet-started requests are remembered.
const EARLY_CANCELS: usize = 64;
/// How many started request ids are remembered, so a late cancel for one
/// is ignored instead of being kept as an early cancel.
const STARTED_IDS: usize = 256;

#[derive(Default)]
struct Requests {
    next: u64,
    /// Request id → (generation, cancel sender).
    running: HashMap<String, (u64, oneshot::Sender<()>)>,
    /// Ids cancelled before their request registered (the two commands race).
    early: VecDeque<String>,
    /// Ids of recently started requests.
    started: VecDeque<String>,
}

/// Removes `key` from an error message, in case a provider or gateway
/// echoed it back: messages reach the webview. HTTP error bodies are
/// already redacted before truncation (`http.rs`); this catches the rest.
fn redact(mut error: AiError, key: Option<&str>) -> AiError {
    error.message = error::redact(&error.message, key);
    error
}

/// The key a request uses, from the keychain lookup's outcome. Missing is
/// `noKey` unless the provider's key is optional (`custom`). For such a
/// provider a failed lookup (no Secret Service, a denied prompt) is logged
/// and the request goes out without a key: a keyless local server must not
/// need a working credential store.
fn resolve_key(
    provider: ProviderId,
    lookup: Result<Option<String>, AiError>,
) -> Result<Option<String>, AiError> {
    let key = match lookup {
        Ok(key) => key,
        Err(e) if provider.key_optional() => {
            eprintln!(
                "ai: key lookup for {} failed, continuing without a key: {}",
                provider.as_str(),
                e.message
            );
            None
        }
        Err(e) => return Err(e),
    };
    let key = key.filter(|k| !k.trim().is_empty());
    if key.is_none() && !provider.key_optional() {
        return Err(AiError::new(
            ErrorKind::NoKey,
            format!("no API key is set for {}", provider.as_str()),
        ));
    }
    Ok(key)
}

/// Tauri state for the AI commands.
#[derive(Default)]
pub struct AiManager {
    http: OnceLock<reqwest::Client>,
    requests: Mutex<Requests>,
    discovery: cli::Discovery,
    /// Anthropic model capabilities by base URL and model id; `None` when
    /// the lookup failed (it is not retried until restart).
    anthropic_caps: Mutex<HashMap<(String, String), Option<AnthropicCaps>>>,
    rejections: Rejections,
}

impl AiManager {
    fn http(&self) -> Result<&reqwest::Client, AiError> {
        if let Some(client) = self.http.get() {
            return Ok(client);
        }
        let client = http::build_client()?;
        Ok(self.http.get_or_init(|| client))
    }

    /// Runs `work` until it finishes or [`cancel`](Self::cancel) is called
    /// with `id`. Dropping `work` aborts an HTTP request or kills a CLI.
    pub async fn cancellable<T>(
        &self,
        id: &str,
        work: impl Future<Output = Result<T, AiError>>,
    ) -> Result<T, AiError> {
        let (tx, rx) = oneshot::channel();
        let generation = {
            let mut requests = self.requests.lock().unwrap();
            if let Some(at) = requests.early.iter().position(|e| e == id) {
                requests.early.remove(at);
                return Err(AiError::cancelled());
            }
            requests.next += 1;
            let generation = requests.next;
            if !requests.started.iter().any(|s| s == id) {
                if requests.started.len() == STARTED_IDS {
                    requests.started.pop_front();
                }
                requests.started.push_back(id.to_string());
            }
            // A reused id replaces (and so cancels) the older request.
            requests.running.insert(id.to_string(), (generation, tx));
            generation
        };
        let mut rx = rx;
        let result = tokio::select! {
            biased;
            _ = &mut rx => Err(AiError::cancelled()),
            result = work => result,
        };
        // Finalize under the registry lock. `cancel` and a newer request
        // with the same id both take our entry out of `running` under that
        // lock, so whether it is still ours decides, atomically, between
        // delivering the result and `cancelled`: a cancel that lands at any
        // point before this, even after the result was ready, still wins.
        let mut requests = self.requests.lock().unwrap();
        let ours = requests
            .running
            .get(id)
            .is_some_and(|(g, _)| *g == generation);
        if ours {
            requests.running.remove(id);
            result
        } else {
            Err(AiError::cancelled())
        }
    }

    pub fn cancel(&self, id: &str) {
        let mut requests = self.requests.lock().unwrap();
        if let Some((_, tx)) = requests.running.remove(id) {
            let _ = tx.send(());
        } else if !requests.started.iter().any(|s| s == id)
            && !requests.early.iter().any(|e| e == id)
        {
            // Not started yet: remember it. (A late cancel for a request that
            // already finished is ignored.)
            if requests.early.len() == EARLY_CANCELS {
                requests.early.pop_front();
            }
            requests.early.push_back(id.to_string());
        }
    }

    /// The stored key for an HTTP provider (see [`resolve_key`]). A
    /// `custom` key is looked up under its base URL, so it only ever goes to
    /// the endpoint it was saved for.
    async fn key(&self, provider: &ProviderConfig) -> Result<Option<String>, AiError> {
        let account = provider.key_account()?;
        let lookup = tauri::async_runtime::spawn_blocking(move || keys::get(&account))
            .await
            .map_err(|e| AiError::other(format!("keychain task failed: {e}")))
            .and_then(|r| r);
        resolve_key(provider.id, lookup)
    }

    /// The capabilities of an Anthropic model, looked up once per launch.
    /// `None` when the lookup failed (callers then send today's request).
    /// A failure that may go away (no key yet, network, timeout) is not
    /// remembered; any other (an unknown model, a gateway without the
    /// endpoint) is, until restart.
    async fn anthropic_caps(
        &self,
        base: &str,
        key: &str,
        model: &str,
    ) -> Result<Option<AnthropicCaps>, AiError> {
        let cache_key = (base.to_string(), model.to_string());
        if let Some(caps) = self.anthropic_caps.lock().unwrap().get(&cache_key) {
            return Ok(caps.clone());
        }
        let caps = match anthropic::capabilities(self.http()?, base, key, model).await {
            Ok(caps) => Some(caps),
            Err(e) => {
                eprintln!(
                    "ai: capabilities of {model} unavailable: {}",
                    error::redact(&e.message, Some(key))
                );
                let transient = matches!(
                    e.kind,
                    ErrorKind::Auth | ErrorKind::NoKey | ErrorKind::Network | ErrorKind::Timeout
                );
                if transient {
                    return Ok(None);
                }
                None
            }
        };
        self.anthropic_caps
            .lock()
            .unwrap()
            .insert(cache_key, caps.clone());
        Ok(caps)
    }

    /// The stored effort setting resolved for `model`, minus a level the
    /// provider is known to reject.
    fn resolve(
        &self,
        provider: &ProviderConfig,
        model: &str,
        caps: Option<&AnthropicCaps>,
        setting: Option<EffortSetting>,
    ) -> Resolved {
        let mut resolved = effort::resolve(provider.id, model, caps, setting);
        if resolved
            .level
            .is_some_and(|level| self.rejections.contains(provider, model, level))
        {
            resolved.level = None;
        }
        resolved
    }

    fn note_reply(
        &self,
        provider: &ProviderConfig,
        model: &str,
        resolved: &Resolved,
        reply: &Reply,
    ) {
        if let (true, Some(level)) = (reply.effort_dropped, resolved.level) {
            self.rejections.insert(provider, model, level);
        }
    }

    /// One completion from `provider`, at the reasoning effort `setting`
    /// (`None`: Midterm's pick, see [`effort::builtin`]).
    pub async fn complete(
        &self,
        provider: &ProviderConfig,
        model: &str,
        system: &str,
        prompt: &str,
        reply_tokens: Option<u32>,
        setting: Option<EffortSetting>,
    ) -> Result<Reply, AiError> {
        let backend = provider.id.backend();
        let model = model.trim();
        if !matches!(backend, Backend::Cli(_)) && model.is_empty() {
            return Err(AiError::other("choose a model"));
        }
        let completion = |resolved: &Resolved| Completion {
            model,
            system,
            prompt,
            max_tokens: output_budget(reply_tokens, resolved),
            effort: resolved.level,
            timeout: effort::scaled(http::REQUEST_TIMEOUT, resolved),
        };
        match backend {
            Backend::OpenAiCompatible(flavor) => {
                let base = provider.base_url()?;
                let key = self.key(provider).await?;
                let resolved = self.resolve(provider, model, None, setting);
                let reply = openai::complete(
                    self.http()?,
                    flavor,
                    &base,
                    key.as_deref(),
                    &completion(&resolved),
                )
                .await
                .map_err(|e| redact(e, key.as_deref()))?;
                self.note_reply(provider, model, &resolved, &reply);
                Ok(reply)
            }
            Backend::Anthropic => {
                let base = provider.base_url()?;
                let key = self.key(provider).await?.unwrap_or_default();
                let caps = self.anthropic_caps(&base, &key, model).await?;
                let resolved = self.resolve(provider, model, caps.as_ref(), setting);
                let mut req = completion(&resolved);
                let (shape, max_tokens) = anthropic::plan(
                    resolved.level,
                    resolved.explicit,
                    caps.as_ref(),
                    reply_budget(reply_tokens),
                    req.max_tokens,
                );
                req.max_tokens = max_tokens;
                let reply = anthropic::complete(self.http()?, &base, &key, &req, shape)
                    .await
                    .map_err(|e| redact(e, Some(&key)))?;
                self.note_reply(provider, model, &resolved, &reply);
                Ok(reply)
            }
            Backend::Cli(kind) => {
                let resolved = self.resolve(provider, model, None, setting);
                let reply = self
                    .discovery
                    .complete(kind, provider.cli_path(), model, system, prompt, &resolved)
                    .await?;
                self.note_reply(provider, model, &resolved, &reply);
                Ok(reply)
            }
        }
    }

    /// The effort levels Settings → AI offers for `provider` and `model`,
    /// and what the stored `setting` would send.
    pub async fn effort_options(
        &self,
        provider: &ProviderConfig,
        model: &str,
        setting: Option<EffortSetting>,
    ) -> Result<EffortOptions, AiError> {
        let model = model.trim();
        let mut caps = None;
        let mut caps_failed = false;
        if provider.id.backend() == Backend::Anthropic && !model.is_empty() {
            let base = provider.base_url()?;
            let key = self.key(provider).await?.unwrap_or_default();
            caps = self.anthropic_caps(&base, &key, model).await?;
            caps_failed = caps.is_none();
        }
        let resolved = self.resolve(provider, model, caps.as_ref(), setting);
        Ok(EffortOptions {
            levels: effort::levels(provider.id, model, caps.as_ref()),
            effective: resolved.level,
            note: effort::note(provider.id, model, caps_failed),
        })
    }

    pub async fn models(&self, provider: &ProviderConfig) -> Result<Vec<String>, AiError> {
        match provider.id.backend() {
            Backend::OpenAiCompatible(_) => {
                let base = provider.base_url()?;
                let key = self.key(provider).await?;
                openai::models(self.http()?, &base, key.as_deref())
                    .await
                    .map_err(|e| redact(e, key.as_deref()))
            }
            Backend::Anthropic => {
                let base = provider.base_url()?;
                let key = self.key(provider).await?.unwrap_or_default();
                anthropic::models(self.http()?, &base, &key)
                    .await
                    .map_err(|e| redact(e, Some(&key)))
            }
            Backend::Cli(kind) => self.discovery.models(kind, provider.cli_path()).await,
        }
    }

    pub async fn cli_status(&self, provider: &ProviderConfig) -> Result<cli::CliStatus, AiError> {
        match provider.id.backend() {
            Backend::Cli(kind) => Ok(self.discovery.status(kind, provider.cli_path()).await),
            _ => Err(AiError::other(format!(
                "{} is not a CLI provider",
                provider.id.as_str()
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;

    use super::provider::Flavor;
    use super::stub::{self, Canned};
    use super::*;

    fn at(level: Option<Effort>) -> Resolved {
        Resolved {
            level,
            explicit: true,
            provider_default: false,
        }
    }

    #[test]
    fn budgets_leave_room_for_thinking() {
        let low = at(Some(Effort::Low));
        assert_eq!(output_budget(None, &low), DEFAULT_REPLY_TOKENS + 4096);
        assert_eq!(output_budget(Some(0), &low), 16 + 4096);
        assert_eq!(output_budget(Some(u32::MAX), &low), MAX_REPLY_TOKENS + 4096);
        assert_eq!(
            output_budget(None, &at(Some(Effort::Max))),
            DEFAULT_REPLY_TOKENS + 32_768
        );
    }

    #[tokio::test]
    async fn rejected_levels_are_remembered_per_level() {
        let server = stub::serve(vec![
            Canned::json(
                400,
                json!({ "error": { "message": "reasoning_effort 'xhigh' is not supported" } }),
            ),
            Canned::json(
                200,
                json!({ "choices": [{ "message": { "content": "a" }, "finish_reason": "stop" }] }),
            ),
            Canned::json(
                200,
                json!({ "choices": [{ "message": { "content": "b" }, "finish_reason": "stop" }] }),
            ),
            Canned::json(
                200,
                json!({ "choices": [{ "message": { "content": "c" }, "finish_reason": "stop" }] }),
            ),
        ])
        .await;
        let manager = AiManager::default();
        let config = ProviderConfig {
            id: ProviderId::Custom,
            base_url: Some(server.url.clone()),
            cli_path: None,
        };
        // Custom keys are optional; a broken keychain must not matter here.
        let ask = |setting| manager.complete(&config, "m", "", "p", None, Some(setting));
        let first = ask(EffortSetting::High).await.unwrap();
        assert!(first.effort_dropped);
        assert_eq!(ask(EffortSetting::High).await.unwrap().text, "b");
        assert_eq!(ask(EffortSetting::Low).await.unwrap().text, "c");
        let sent = server.requests();
        assert_eq!(sent.len(), 4);
        assert_eq!(sent[0].json()["reasoning_effort"], "high");
        assert!(sent[1].json().get("reasoning_effort").is_none());
        // Remembered: no failed attempt first.
        assert!(sent[2].json().get("reasoning_effort").is_none());
        // Another level is still tried.
        assert_eq!(sent[3].json()["reasoning_effort"], "low");
    }

    #[tokio::test]
    async fn cancel_aborts_an_http_request() {
        let reply =
            json!({ "choices": [{ "message": { "content": "late" }, "finish_reason": "stop" }] });
        let server = stub::serve(vec![
            Canned::json(200, reply).delayed(Duration::from_secs(5)),
        ])
        .await;
        let manager = Arc::new(AiManager::default());
        let req = Completion {
            model: "m",
            system: "",
            prompt: "p",
            max_tokens: 10,
            effort: None,
            timeout: http::REQUEST_TIMEOUT,
        };
        let client = stub::client();
        let canceller = manager.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            canceller.cancel("r1");
        });
        let started = std::time::Instant::now();
        let result = manager
            .cancellable(
                "r1",
                openai::complete(&client, Flavor::Custom, &server.url, None, &req),
            )
            .await;
        assert_eq!(result.unwrap_err().kind, ErrorKind::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(manager.requests.lock().unwrap().running.is_empty());
    }

    #[test]
    fn redacts_keys() {
        let e = AiError::other("HTTP 401: bad key sk-secret-123 given");
        assert_eq!(
            redact(e, Some("sk-secret-123")).message,
            "HTTP 401: bad key [redacted] given"
        );
        let e = AiError::other("ab");
        assert_eq!(redact(e, Some("")).message, "ab");
        // Short keys too: the setter accepts them.
        let e = AiError::other("key x7 rejected");
        assert_eq!(redact(e, Some("x7")).message, "key [redacted] rejected");
    }

    #[test]
    fn optional_keys_survive_a_broken_credential_store() {
        let broken = || Err(AiError::other("keychain: no Secret Service"));
        // `custom` goes out without a key.
        assert_eq!(resolve_key(ProviderId::Custom, broken()).unwrap(), None);
        assert_eq!(resolve_key(ProviderId::Custom, Ok(None)).unwrap(), None);
        assert_eq!(
            resolve_key(ProviderId::Custom, Ok(Some("k".into()))).unwrap(),
            Some("k".into())
        );
        // A provider that needs a key reports the failure, or `noKey`.
        let e = resolve_key(ProviderId::Openai, broken()).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Other);
        let e = resolve_key(ProviderId::Openai, Ok(Some("  ".into()))).unwrap_err();
        assert_eq!(e.kind, ErrorKind::NoKey);
    }

    #[tokio::test]
    async fn replacement_wins_over_a_ready_result() {
        // A newer request with the same id registers after the older one's
        // work finished but before it finalized: the older one must not
        // deliver its result, and must leave the newer entry alone.
        let manager = AiManager::default();
        let (tx, _rx) = oneshot::channel();
        let r = manager
            .cancellable("same", async {
                let mut requests = manager.requests.lock().unwrap();
                requests.next += 1;
                let generation = requests.next;
                requests.running.insert("same".into(), (generation, tx));
                Ok(1)
            })
            .await;
        assert_eq!(r.unwrap_err().kind, ErrorKind::Cancelled);
        let requests = manager.requests.lock().unwrap();
        assert_eq!(requests.running.get("same").map(|(g, _)| *g), Some(2));
    }

    #[tokio::test]
    async fn late_cancels_do_not_poison_reused_ids() {
        let manager = AiManager::default();
        assert_eq!(
            manager.cancellable("done", async { Ok(1) }).await.unwrap(),
            1
        );
        manager.cancel("done");
        manager.cancel("done");
        assert_eq!(
            manager.cancellable("done", async { Ok(2) }).await.unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn cancel_wins_over_a_ready_result() {
        let manager = AiManager::default();
        let r = manager
            .cancellable("both", async {
                manager.cancel("both");
                Ok(1)
            })
            .await;
        assert_eq!(r.unwrap_err().kind, ErrorKind::Cancelled);
    }

    #[tokio::test]
    async fn cancel_before_start_and_after_finish() {
        let manager = AiManager::default();
        manager.cancel("early");
        let r = manager.cancellable("early", async { Ok(1) }).await;
        assert_eq!(r.unwrap_err().kind, ErrorKind::Cancelled);
        // The early cancel is used up.
        assert_eq!(
            manager.cancellable("early", async { Ok(2) }).await.unwrap(),
            2
        );
        for i in 0..(EARLY_CANCELS + 10) {
            manager.cancel(&format!("x{i}"));
        }
        assert_eq!(manager.requests.lock().unwrap().early.len(), EARLY_CANCELS);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_kills_a_cli() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("survived");
        let fake = dir.path().join("agy");
        std::fs::write(
            &fake,
            // The work is in a background subshell: killing only the
            // script would leave it running.
            format!(
                "#!/bin/sh\n(sleep 2; touch '{}') &\nwait\n",
                marker.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let manager = Arc::new(AiManager {
            discovery: cli::Discovery::with_path_var("/usr/bin:/bin"),
            ..AiManager::default()
        });
        let canceller = manager.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            canceller.cancel("c1");
        });
        let config = ProviderConfig {
            id: ProviderId::Antigravity,
            base_url: None,
            cli_path: Some(fake.to_string_lossy().into_owned()),
        };
        let result = manager
            .cancellable("c1", manager.complete(&config, "", "", "p", None, None))
            .await;
        assert_eq!(result.unwrap_err().kind, ErrorKind::Cancelled);
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(!marker.exists(), "the CLI's process group was not killed");
    }

    #[tokio::test]
    async fn api_providers_need_a_model() {
        let manager = AiManager::default();
        let config = ProviderConfig {
            id: ProviderId::Openai,
            base_url: None,
            cli_path: None,
        };
        let e = manager
            .complete(&config, " ", "", "p", None, None)
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Other);
    }
}
