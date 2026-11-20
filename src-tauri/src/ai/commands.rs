//! Tauri commands for AI providers. Arguments arrive camelCase (Tauri's
//! default); errors are [`AiError`] (`{ kind, message }`).
//!
//! There is deliberately no command that returns a stored key.

use serde::Serialize;
use tauri::State;

use super::cli::CliStatus;
use super::effort::EffortSetting;
use super::error::{AiError, truncate};
use super::keys;
use super::provider::ProviderConfig;
use super::{AiManager, EffortOptions};

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

/// One completion. `maxTokens` is the reply budget; room for thinking is
/// added. `effort` is the stored reasoning effort setting (absent: Midterm's
/// pick). Cancel with `ai_cancel(requestId)`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_suggest(
    manager: State<'_, AiManager>,
    request_id: String,
    provider: ProviderConfig,
    model: String,
    system: String,
    prompt: String,
    max_tokens: Option<u32>,
    effort: Option<EffortSetting>,
) -> Result<Suggestion, AiError> {
    let work = manager.complete(&provider, &model, &system, &prompt, max_tokens, effort);
    let reply = manager.cancellable(&request_id, work).await?;
    Ok(Suggestion { text: reply.text })
}

/// Cancels a running `ai_suggest`. Unknown or finished ids are ignored.
#[tauri::command]
pub fn ai_cancel(manager: State<'_, AiManager>, request_id: String) {
    manager.cancel(&request_id);
}

/// The provider's live model list; `[]` for CLIs that cannot list theirs.
#[tauri::command]
pub async fn ai_models(
    manager: State<'_, AiManager>,
    provider: ProviderConfig,
) -> Result<Vec<String>, AiError> {
    manager.models(&provider).await
}

/// The reasoning effort levels offered for `provider` and `model`, and what
/// the stored `effort` setting would send.
#[tauri::command]
pub async fn ai_effort_options(
    manager: State<'_, AiManager>,
    provider: ProviderConfig,
    model: String,
    effort: Option<EffortSetting>,
) -> Result<EffortOptions, AiError> {
    manager.effort_options(&provider, &model, effort).await
}

/// Sends a tiny request. Failures are reported in the result, not as errors.
#[tauri::command]
pub async fn ai_test(
    manager: State<'_, AiManager>,
    provider: ProviderConfig,
    model: String,
    effort: Option<EffortSetting>,
) -> Result<TestResult, AiError> {
    let options = manager.effort_options(&provider, &model, effort).await.ok();
    let result = manager
        .complete(
            &provider,
            &model,
            "You are a connectivity check. Reply with the single word OK.",
            "Reply with OK.",
            Some(16),
            effort,
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
