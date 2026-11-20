//! Tauri commands for AI providers. Arguments arrive camelCase (Tauri's
//! default); errors are [`AiError`] (`{ kind, message }`).
//!
//! There is deliberately no command that returns a stored key.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use super::acp::{AcpEvent, AcpReply};
use super::agent::{AgentEvent, AgentMessage, AgentTurn, ToolDef};
use super::cli::CliStatus;
use super::error::{AiError, truncate};
use super::keys;
use super::provider::{ProviderConfig, Target};
use super::{AiManager, EffortOptions, Gate, Stop};

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
    // Closed by `ai_cancel` under the gate's lock: no delta after it.
    let gate = Arc::new(Gate::default());
    let open = gate.clone();
    let emit = move |text: &str| {
        open.pass(|| {
            // The webview may have gone away; the result still settles.
            let _ = on_event.send(StreamEvent::Delta {
                text: text.to_string(),
            });
        });
    };
    let work = manager.stream(&target, &system, &prompt, max_tokens, &emit);
    let streamed = manager
        .cancellable_gated(&request_id, Some(gate), work)
        .await?;
    Ok(StreamReply {
        text: streamed.text,
        stop: streamed.stop,
        effort_dropped: streamed.effort_dropped,
    })
}

/// One agent model turn (see `agent.rs`): `messages` is the conversation
/// so far (assistant turns as the `raw` a previous turn returned), `tools`
/// what the model may call. Reply text and tool-call announcements go to
/// `onEvent` as they stream; the result is authoritative. API providers
/// only. Errors and `ai_cancel(requestId)` work as for `ai_stream`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ai_agent_turn(
    manager: State<'_, AiManager>,
    request_id: String,
    target: Target,
    system: String,
    tools: Vec<ToolDef>,
    messages: Vec<AgentMessage>,
    max_tokens: Option<u32>,
    on_event: tauri::ipc::Channel<AgentEvent>,
) -> Result<AgentTurn, AiError> {
    // Closed by `ai_cancel` under the gate's lock: no event after it.
    let gate = Arc::new(Gate::default());
    let open = gate.clone();
    let emit = move |event: AgentEvent| {
        open.pass(|| {
            // The webview may have gone away; the result still settles.
            let _ = on_event.send(event);
        });
    };
    let work = manager.agent_turn(&target, &system, &tools, &messages, max_tokens, &emit);
    manager
        .cancellable_gated(&request_id, Some(gate), work)
        .await
}

/// One prompt of an agent conversation with a CLI profile, over ACP (see
/// `acp/`). The first prompt for `conversationId` starts the session;
/// `system` and `tools` are only used then. Reply text, Midterm tool calls
/// (answer each with `ai_acp_tool_result`) and foreign tool calls go to
/// `onEvent`. Errors and `ai_cancel(requestId)` work as for `ai_stream`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ai_acp_prompt(
    window: tauri::Window,
    manager: State<'_, AiManager>,
    request_id: String,
    conversation_id: String,
    target: Target,
    system: String,
    tools: Vec<ToolDef>,
    text: String,
    on_event: tauri::ipc::Channel<AcpEvent>,
) -> Result<AcpReply, AiError> {
    // Closed by `ai_cancel` under the gate's lock: no event after it.
    let gate = Arc::new(Gate::default());
    let open = gate.clone();
    let emit = Arc::new(move |event: AcpEvent| {
        open.pass(|| {
            // The webview may have gone away; the result still settles.
            let _ = on_event.send(event);
        });
    });
    let work = manager.acp_prompt(
        window.label(),
        &conversation_id,
        &target,
        &system,
        &tools,
        &text,
        emit,
    );
    let stop = manager
        .cancellable_gated(&request_id, Some(gate), work)
        .await?;
    Ok(AcpReply { stop })
}

/// The result of a `toolCall` event. Results for calls that already ended
/// (the prompt finished or was cancelled) are ignored.
#[tauri::command]
pub fn ai_acp_tool_result(
    manager: State<'_, AiManager>,
    conversation_id: String,
    call_id: String,
    content: String,
    is_error: bool,
) {
    manager
        .acp
        .tool_result(&conversation_id, &call_id, content, is_error);
}

/// Ends a conversation's ACP session and its process. No session: no-op.
#[tauri::command]
pub async fn ai_acp_close(
    manager: State<'_, AiManager>,
    conversation_id: String,
) -> Result<(), AiError> {
    manager.acp.close(&conversation_id).await;
    Ok(())
}

/// Cancels a running `ai_suggest`, `ai_stream`, `ai_agent_turn` or
/// `ai_acp_prompt`. Unknown or finished ids are ignored.
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
