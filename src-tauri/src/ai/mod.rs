//! AI providers for next-command suggestions. The webview never talks to a
//! provider and never sees a key: it calls the commands in `commands.rs`,
//! and this module makes the HTTP request or runs the CLI. See `docs/ai.md`.

mod anthropic;
mod cli;
pub mod commands;
mod error;
mod http;
mod keys;
mod openai;
mod process;
mod provider;
mod shell_path;
#[cfg(test)]
mod stub;

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::{Mutex, OnceLock};

use tokio::sync::oneshot;

pub use error::{AiError, ErrorKind};
pub use provider::{Backend, ProviderConfig, ProviderId};

/// What one completion asks for, whichever adapter sends it.
pub struct Completion<'a> {
    pub model: &'a str,
    pub system: &'a str,
    pub prompt: &'a str,
    /// The whole output budget, thinking included.
    pub max_tokens: u32,
}

/// The reply budget when the caller gives none.
const DEFAULT_REPLY_TOKENS: u32 = 512;
const MAX_REPLY_TOKENS: u32 = 32_000;
/// Added to the reply budget for the model's reasoning: on current models
/// `max_tokens` covers thinking too, and too small a limit ends in an empty
/// reply.
const THINKING_HEADROOM: u32 = 4096;

/// The `max_tokens` sent for a reply budget of `reply` tokens.
pub fn output_budget(reply: Option<u32>) -> u32 {
    reply
        .unwrap_or(DEFAULT_REPLY_TOKENS)
        .clamp(16, MAX_REPLY_TOKENS)
        + THINKING_HEADROOM
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
/// echoed it back: messages reach the webview.
fn redact(mut error: AiError, key: Option<&str>) -> AiError {
    if let Some(key) = key.map(str::trim).filter(|k| k.len() >= 4) {
        error.message = error.message.replace(key, "[redacted]");
    }
    error
}

/// Tauri state for the AI commands.
#[derive(Default)]
pub struct AiManager {
    http: OnceLock<reqwest::Client>,
    requests: Mutex<Requests>,
    discovery: cli::Discovery,
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
        // A cancel (or a newer request with the same id) that landed while
        // the result was being produced still wins: a cancelled request
        // never delivers a result.
        let result = match rx.try_recv() {
            Err(oneshot::error::TryRecvError::Empty) => result,
            _ => Err(AiError::cancelled()),
        };
        let mut requests = self.requests.lock().unwrap();
        if requests
            .running
            .get(id)
            .is_some_and(|(g, _)| *g == generation)
        {
            requests.running.remove(id);
        }
        result
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

    /// The stored key for an HTTP provider. Missing is `noKey`, except for
    /// `custom`, where it is optional.
    async fn key(&self, provider: ProviderId) -> Result<Option<String>, AiError> {
        let key = tauri::async_runtime::spawn_blocking(move || keys::get(provider))
            .await
            .map_err(|e| AiError::other(format!("keychain task failed: {e}")))??;
        let key = key.filter(|k| !k.trim().is_empty());
        if key.is_none() && !provider.key_optional() {
            return Err(AiError::new(
                ErrorKind::NoKey,
                format!("no API key is set for {}", provider.as_str()),
            ));
        }
        Ok(key)
    }

    /// One completion from `provider`.
    pub async fn complete(
        &self,
        provider: &ProviderConfig,
        model: &str,
        system: &str,
        prompt: &str,
        reply_tokens: Option<u32>,
    ) -> Result<String, AiError> {
        let backend = provider.id.backend();
        if !matches!(backend, Backend::Cli(_)) && model.trim().is_empty() {
            return Err(AiError::other("choose a model"));
        }
        let req = Completion {
            model: model.trim(),
            system,
            prompt,
            max_tokens: output_budget(reply_tokens),
        };
        match backend {
            Backend::OpenAiCompatible(flavor) => {
                let base = provider.base_url()?;
                let key = self.key(provider.id).await?;
                openai::complete(self.http()?, flavor, &base, key.as_deref(), &req)
                    .await
                    .map_err(|e| redact(e, key.as_deref()))
            }
            Backend::Anthropic => {
                let base = provider.base_url()?;
                let key = self.key(provider.id).await?.unwrap_or_default();
                anthropic::complete(self.http()?, &base, &key, &req)
                    .await
                    .map_err(|e| redact(e, Some(&key)))
            }
            Backend::Cli(kind) => {
                self.discovery
                    .complete(kind, provider.cli_path(), model, system, prompt)
                    .await
            }
        }
    }

    pub async fn models(&self, provider: &ProviderConfig) -> Result<Vec<String>, AiError> {
        match provider.id.backend() {
            Backend::OpenAiCompatible(_) => {
                let base = provider.base_url()?;
                let key = self.key(provider.id).await?;
                openai::models(self.http()?, &base, key.as_deref())
                    .await
                    .map_err(|e| redact(e, key.as_deref()))
            }
            Backend::Anthropic => {
                let base = provider.base_url()?;
                let key = self.key(provider.id).await?.unwrap_or_default();
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

    #[test]
    fn budgets_leave_room_for_thinking() {
        assert_eq!(
            output_budget(None),
            DEFAULT_REPLY_TOKENS + THINKING_HEADROOM
        );
        assert_eq!(output_budget(Some(0)), 16 + THINKING_HEADROOM);
        assert_eq!(
            output_budget(Some(u32::MAX)),
            MAX_REPLY_TOKENS + THINKING_HEADROOM
        );
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
            .cancellable("c1", manager.complete(&config, "", "", "p", None))
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
            .complete(&config, " ", "", "p", None)
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Other);
    }
}
