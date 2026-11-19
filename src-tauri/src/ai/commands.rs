//! Tauri commands for AI providers. Arguments arrive camelCase (Tauri's
//! default); errors are [`AiError`] (`{ kind, message }`).
//!
//! There is deliberately no command that returns a stored key.

use serde::Serialize;
use tauri::State;

use super::AiManager;
use super::cli::CliStatus;
use super::error::{AiError, truncate};
use super::keys;
use super::provider::{ProviderConfig, ProviderId};

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
/// added. Cancel with `ai_cancel(requestId)`.
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
) -> Result<Suggestion, AiError> {
    let work = manager.complete(&provider, &model, &system, &prompt, max_tokens);
    let text = manager.cancellable(&request_id, work).await?;
    Ok(Suggestion { text })
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

/// Sends a tiny request. Failures are reported in the result, not as errors.
#[tauri::command]
pub async fn ai_test(
    manager: State<'_, AiManager>,
    provider: ProviderConfig,
    model: String,
) -> Result<TestResult, AiError> {
    let result = manager
        .complete(
            &provider,
            &model,
            "You are a connectivity check. Reply with the single word OK.",
            "Reply with OK.",
            Some(16),
        )
        .await;
    Ok(match result {
        Ok(text) => TestResult {
            ok: true,
            message: format!("Replied: {}", truncate(&text, 80)),
        },
        Err(e) => TestResult {
            ok: false,
            message: e.message,
        },
    })
}

#[tauri::command]
pub async fn ai_key_set(provider: ProviderId, key: String) -> Result<(), AiError> {
    blocking(move || keys::set(provider, &key)).await
}

#[tauri::command]
pub async fn ai_key_delete(provider: ProviderId) -> Result<(), AiError> {
    blocking(move || keys::delete(provider)).await
}

#[tauri::command]
pub async fn ai_key_status(provider: ProviderId) -> Result<bool, AiError> {
    blocking(move || keys::is_set(provider)).await
}

/// Whether a CLI provider's executable is found, where, and its version.
#[tauri::command]
pub async fn ai_cli_status(
    manager: State<'_, AiManager>,
    provider: ProviderConfig,
) -> Result<CliStatus, AiError> {
    manager.cli_status(&provider).await
}
