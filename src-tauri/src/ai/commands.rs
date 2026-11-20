//! Tauri commands for AI providers. Arguments arrive camelCase (Tauri's
//! default); errors are [`AiError`] (`{ kind, message }`).
//!
//! There is deliberately no command that returns a stored key.

use serde::Serialize;
use tauri::State;

use super::cli::CliStatus;
use super::error::{AiError, truncate};
use super::keys;
use super::provider::{ProviderConfig, Target};
use super::{AiManager, EffortOptions, Stop};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, AiError> + Send + 'static,
) -> Result<T, AiError> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| AiError::other(format!("background task failed: {e}")))?
}

/// One completion from `target`. `maxTokens` is the reply budget; room for
/// thinking is added. `target.effort` is the profile's reasoning effort
/// setting (absent: Midterm's pick). Cancel with `ai_cancel(requestId)`.
#[tauri::command]
pub async fn ai_suggest(
    manager: State<'_, AiManager>,
    request_id: String,
    target: Target,
    system: String,
    prompt: String,
    max_tokens: Option<u32>,
) -> Result<Suggestion, AiError> {
    let work = manager.complete(&target, &system, &prompt, max_tokens);
    let reply = manager.cancellable(&request_id, work).await?;
    Ok(Suggestion { text: reply.text })
}

/// A message on `ai_stream`'s channel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum StreamEvent {
    /// More reply text: append it.
    Delta { text: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamReply {
    /// The whole reply. Authoritative: channel messages and the command's
    /// response are not ordered against each other.
    pub text: String,
    pub stop: Stop,
    pub effort_dropped: bool,
}

/// One completion from `target`, streamed: reply text goes to `onEvent` as
/// it arrives (one delta per network chunk; CLIs send the whole reply once)
/// and the full text is the result. Errors and `ai_cancel(requestId)` work
/// as for `ai_suggest`.
#[tauri::command]
pub async fn ai_stream(
    manager: State<'_, AiManager>,
    request_id: String,
    target: Target,
    system: String,
    prompt: String,
    max_tokens: Option<u32>,
    on_event: tauri::ipc::Channel<StreamEvent>,
) -> Result<StreamReply, AiError> {
    let emit = move |text: &str| {
        // The webview may have gone away; the result still settles.
        let _ = on_event.send(StreamEvent::Delta {
            text: text.to_string(),
        });
    };
    let work = manager.stream(&target, &system, &prompt, max_tokens, &emit);
    let streamed = manager.cancellable(&request_id, work).await?;
    Ok(StreamReply {
        text: streamed.text,
        stop: streamed.stop,
        effort_dropped: streamed.effort_dropped,
    })
}

/// Cancels a running `ai_suggest` or `ai_stream`. Unknown or finished ids
/// are ignored.
#[tauri::command]
pub fn ai_cancel(manager: State<'_, AiManager>, request_id: String) {
    manager.cancel(&request_id);
}

/// The provider's live model list, text-to-text models only for
/// OpenAI-compatible providers; `[]` for CLIs that cannot list theirs.
#[tauri::command]
pub async fn ai_models(
    manager: State<'_, AiManager>,
    provider: ProviderConfig,
) -> Result<Vec<String>, AiError> {
    manager.models(&provider).await
}

/// The reasoning effort levels offered for `target`'s provider and model,
/// and what its effort setting would send. `target.extra` is ignored.
#[tauri::command]
pub async fn ai_effort_options(
    manager: State<'_, AiManager>,
    target: Target,
) -> Result<EffortOptions, AiError> {
    manager.effort_options(&target).await
}

/// Sends a tiny request. Failures are reported in the result, not as errors.
#[tauri::command]
pub async fn ai_test(manager: State<'_, AiManager>, target: Target) -> Result<TestResult, AiError> {
    // Bad extra JSON fails before the effort lookup reads a key.
    if let Err(e) = AiManager::checked_extra(&target) {
        return Ok(TestResult {
            ok: false,
            message: e.message,
        });
    }
    let options = manager.effort_options(&target).await.ok();
    let result = manager
        .complete(
            &target,
            "You are a connectivity check. Reply with the single word OK.",
            "Reply with OK.",
            Some(16),
        )
        .await;
    Ok(match result {
        Ok(reply) => {
            let effort = match options.and_then(|o| o.effective) {
                _ if reply.effort_dropped => {
                    " (the effort setting was rejected and left out)".to_string()
                }
                Some(level) => format!(" at {} effort", level.as_str()),
                None => String::new(),
            };
            TestResult {
                ok: true,
                message: format!("Replied{effort}: {}", truncate(&reply.text, 80)),
            }
        }
        Err(e) => TestResult {
            ok: false,
            message: e.message,
        },
    })
}

/// Stores the key for `provider`. A `custom` key is bound to its `baseUrl`
/// (required here); other providers ignore `baseUrl`.
#[tauri::command]
pub async fn ai_key_set(provider: ProviderConfig, key: String) -> Result<(), AiError> {
    let account = provider.key_account()?;
    blocking(move || keys::set(&account, &key)).await
}

#[tauri::command]
pub async fn ai_key_delete(provider: ProviderConfig) -> Result<(), AiError> {
    let account = provider.key_account()?;
    blocking(move || keys::delete(&account)).await
}

#[tauri::command]
pub async fn ai_key_status(provider: ProviderConfig) -> Result<bool, AiError> {
    let account = provider.key_account()?;
    blocking(move || keys::is_set(&account)).await
}

/// Whether a CLI provider's executable is found, where, and its version.
#[tauri::command]
pub async fn ai_cli_status(
    manager: State<'_, AiManager>,
    provider: ProviderConfig,
) -> Result<CliStatus, AiError> {
    manager.cli_status(&provider).await
}
