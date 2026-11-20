//! OpenAI-compatible chat completions: OpenAI, DeepSeek, OpenRouter,
//! Gemini's OpenAI-compatible endpoint and any custom base URL.
//!
//! One `POST {base}/chat/completions` with a system and a user message,
//! non-streaming ([`complete`]) or streaming ([`stream`]). No sampling
//! parameters. The reasoning effort chosen in `effort.rs` is sent where
//! there is one (see [`build_body`]); a model that rejects the field gets
//! the request again without it.

use serde_json::{Map, Value, json};

use super::effort::Effort;
use super::error::{AiError, ErrorKind};
use super::extra;
use super::http;
use super::provider::Flavor;
use super::sse::SseEvent;
use super::stream::{self, Flow, Stop, StreamState, Streamed, Text};
use super::{Completion, Reply};

/// Words in a 400/422 response that mean the effort field was the problem.
const EFFORT_WORDS: &[&str] = &["reasoning", "effort", "thinking"];

/// The request body. Differences by provider:
///
/// - token limit: OpenAI wants `max_completion_tokens` (its reasoning models
///   reject `max_tokens`); the others take `max_tokens`.
/// - effort (`req.effort`, only when `with_effort`): `reasoning_effort` for
///   OpenAI, Gemini and custom servers; OpenRouter's normalized
///   `reasoning: { effort, exclude: true }`; DeepSeek takes
///   `reasoning_effort`, and `thinking: { type: "disabled" }` for off.
pub fn build_body(flavor: Flavor, req: &Completion, with_effort: bool, stream: bool) -> Value {
    let mut messages = Vec::new();
    if !req.system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": req.system }));
    }
    messages.push(json!({ "role": "user", "content": req.prompt }));

    let mut body = Map::new();
    body.insert("model".into(), json!(req.model));
    body.insert("messages".into(), Value::Array(messages));
    body.insert("stream".into(), json!(stream));
    let tokens_field = match flavor {
        Flavor::OpenAi => "max_completion_tokens",
        _ => "max_tokens",
    };
    body.insert(tokens_field.into(), json!(req.max_tokens));
    if let Some(level) = req.effort.filter(|_| with_effort) {
        match flavor {
            Flavor::DeepSeek if level == Effort::None => {
                body.insert("thinking".into(), json!({ "type": "disabled" }));
            }
            Flavor::OpenRouter => {
                body.insert(
                    "reasoning".into(),
                    json!({ "effort": level.as_str(), "exclude": true }),
                );
            }
            _ => {
                body.insert("reasoning_effort".into(), json!(level.as_str()));
            }
        }
    }
    if let Some(extra) = req.extra {
        extra::merge(&mut body, extra);
    }
    Value::Object(body)
}

/// The reply text of a chat completion, or why there is none.
pub fn parse_reply(response: &Value) -> Result<String, AiError> {
    let Some(choice) = response.pointer("/choices/0") else {
        return Err(AiError::other("the response has no choices"));
    };
    let message = &choice["message"];
    if let Some(refusal) = message["refusal"].as_str().filter(|r| !r.trim().is_empty()) {
        return Err(AiError::new(ErrorKind::Refused, refusal.trim()));
    }
    let finish = choice["finish_reason"].as_str().unwrap_or("");
    if finish == "content_filter" {
        return Err(AiError::new(
            ErrorKind::Refused,
            "the provider's content filter withheld the reply",
        ));
    }
    let text = strip_think(&content_text(&message["content"]))
        .trim()
        .to_string();
    if text.is_empty() {
        let message = if finish == "length" {
            "the token limit ran out before any reply text (reasoning may have used it up)"
        } else {
            "the model returned an empty reply"
        };
        return Err(AiError::new(ErrorKind::Empty, message));
    }
    Ok(text)
}

/// `content` is a string in the OpenAI shape; some compatible servers send
/// an array of `{ type: "text", text }` parts.
fn content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Removes a leading `<think>…</think>` block, which some reasoning models
/// served through compatible endpoints put in the content. An unclosed
/// block means no answer was reached.
pub fn strip_think(text: &str) -> &str {
    let trimmed = text.trim_start();
    let Some(rest) = trimmed.strip_prefix("<think>") else {
        return text;
    };
    match rest.find("</think>") {
        Some(end) => &rest[end + "</think>".len()..],
        None => "",
    }
}

/// Words in a model id that mark a model whose output is not text (or that
/// is not a chat model at all). Matched against whole id segments.
const NON_TEXT_WORDS: &[&str] = &[
    "tts",
    "stt",
    "asr",
    "speech",
    "whisper",
    "transcribe",
    "transcription",
    "audio",
    "realtime",
    "live",
    "image",
    "images",
    "imagen",
    "video",
    "sora",
    "veo",
    "lyria",
    "embedding",
    "embeddings",
    "embed",
    "rerank",
    "reranker",
    "moderation",
    "aqa",
];

/// Whether a model id looks like a text-to-text chat model, for listings
/// that say nothing about modalities. `vision`, `instruct`, `search` and
/// `computer-use` models stay: their output is text.
pub fn is_text_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    if id.contains("dall-e") || id.contains("stable-diffusion") {
        return false;
    }
    !id.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|segment| NON_TEXT_WORDS.contains(&segment))
}

/// Whether a `GET /models` entry is a text-to-text model: from
/// `architecture.output_modalities`/`input_modalities` (OpenRouter), else
/// the legacy `architecture.modality` string (`"text+image->text"`), else
/// the id ([`is_text_model`]).
fn keeps_entry(entry: &Value, id: &str) -> bool {
    let arch = &entry["architecture"];
    if let Some(outputs) = arch["output_modalities"].as_array() {
        let text_out = outputs.len() == 1 && outputs[0] == "text";
        let text_in = match &arch["input_modalities"] {
            Value::Null => true,
            Value::Array(inputs) => inputs.iter().any(|m| m == "text"),
            _ => false,
        };
        return text_out && text_in;
    }
    if let Some((input, output)) = arch["modality"].as_str().and_then(|m| m.split_once("->")) {
        return output.trim() == "text" && input.split('+').any(|m| m.trim() == "text");
    }
    is_text_model(id)
}

/// Text-to-text model ids from `GET {base}/models` (`{ data: [{ id }] }`),
/// sorted. A `models/` prefix (Gemini's native id form) is dropped. Image,
/// audio, embedding and similar models are left out (see [`keeps_entry`]);
/// any id can still be typed in Settings.
pub fn parse_models(response: &Value) -> Vec<String> {
    let mut ids: Vec<String> = response["data"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|m| Some((m, m["id"].as_str()?)))
                .map(|(m, id)| (m, id.strip_prefix("models/").unwrap_or(id)))
                .filter(|(m, id)| keeps_entry(m, id))
                .map(|(_, id)| id.to_string())
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    ids
}

fn authorize(request: reqwest::RequestBuilder, key: Option<&str>) -> reqwest::RequestBuilder {
    match key {
        Some(key) => request.bearer_auth(key),
        None => request,
    }
}

pub async fn complete(
    client: &reqwest::Client,
    flavor: Flavor,
    base_url: &str,
    key: Option<&str>,
    req: &Completion<'_>,
) -> Result<Reply, AiError> {
    let url = format!("{base_url}/chat/completions");
    let send = |with_effort: bool| {
        let body = build_body(flavor, req, with_effort, false);
        http::send(
            authorize(client.post(&url), key).json(&body),
            key,
            req.timeout,
        )
    };
    let (response, effort_dropped) =
        http::retry_without_effort(req.effort.is_some(), EFFORT_WORDS, send).await;
    let response = response.map_err(|f| f.into_error(key))?;
    Ok(Reply {
        text: parse_reply(&response)?,
        effort_dropped,
    })
}

/// [`complete`], streamed: `emit` gets the reply text as it arrives (one
/// call per network chunk). `req.timeout` limits the wait for the headers
/// and for each chunk. A server that ignores `stream` and answers with JSON
/// is read whole and emitted once.
pub async fn stream(
    client: &reqwest::Client,
    flavor: Flavor,
    base_url: &str,
    key: Option<&str>,
    req: &Completion<'_>,
    emit: &(dyn Fn(&str) + Send + Sync),
) -> Result<Streamed, AiError> {
    let url = format!("{base_url}/chat/completions");
    let send = |with_effort: bool| {
        let body = build_body(flavor, req, with_effort, true);
        http::open_stream(authorize(client.post(&url), key).json(&body), req.timeout)
    };
    let (response, effort_dropped) =
        http::retry_without_effort(req.effort.is_some(), EFFORT_WORDS, send).await;
    let mut response = response.map_err(|f| f.into_error(key))?;
    if !http::is_event_stream(&response) {
        let body = http::read_body(&mut response, req.timeout).await?;
        let body = String::from_utf8_lossy(&body);
        let json: Value = serde_json::from_str(&body).map_err(|_| http::not_json(&body, key))?;
        let text = parse_reply(&json)?;
        let stop = match json
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
        {
            Some("length") => Stop::Length,
            _ => Stop::End,
        };
        emit(&text);
        return Ok(Streamed {
            text,
            stop,
            effort_dropped,
        });
    }
    let mut state = ChatStream::new(key);
    stream::read(&mut response, req.timeout, &mut state, emit).await?;
    let (text, stop) = state.finish()?;
    Ok(Streamed {
        text,
        stop,
        effort_dropped,
    })
}

/// Holds streamed text back while it could still be a leading
/// `<think>…</think>` block (see [`strip_think`]), and swallows the block.
#[derive(Default)]
pub struct ThinkFilter {
    state: Think,
    held: String,
}

#[derive(Default, PartialEq, Eq)]
enum Think {
    /// No text other than whitespace yet.
    #[default]
    Start,
    /// Inside a leading `<think>` block.
    Inside,
    /// Past it (or there was none): text passes through.
    Passing,
}

const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";

impl ThinkFilter {
    /// The text to pass on after `text` arrived.
    pub fn push(&mut self, text: &str) -> String {
        match self.state {
            Think::Passing => text.to_string(),
            Think::Start => {
                self.held.push_str(text);
                let trimmed = self.held.trim_start();
                if let Some(rest) = trimmed.strip_prefix(THINK_OPEN) {
                    self.held = rest.to_string();
                    self.state = Think::Inside;
                    self.inside()
                } else if trimmed.is_empty() || THINK_OPEN.starts_with(trimmed) {
                    String::new()
                } else {
                    self.state = Think::Passing;
                    std::mem::take(&mut self.held)
                }
            }
            Think::Inside => {
                self.held.push_str(text);
                self.inside()
            }
        }
    }

    fn inside(&mut self) -> String {
        if let Some(end) = self.held.find(THINK_CLOSE) {
            self.state = Think::Passing;
            let rest = self.held[end + THINK_CLOSE.len()..].to_string();
            self.held.clear();
            return rest;
        }
        // Keep only a tail that could hold the start of `</think>`.
        let keep = THINK_CLOSE.len() - 1;
        if self.held.len() > keep * 4 {
            let mut cut = self.held.len() - keep;
            while !self.held.is_char_boundary(cut) {
                cut -= 1;
            }
            self.held.drain(..cut);
        }
        String::new()
    }

    /// The end of the reply: text held as a possible `<think>` start is
    /// passed on; an unclosed block means no answer was reached.
    pub fn finish(&mut self) -> String {
        match self.state {
            Think::Start => std::mem::take(&mut self.held),
            _ => String::new(),
        }
    }
}

/// The state of a streamed chat completion.
pub struct ChatStream<'k> {
    key: Option<&'k str>,
    think: ThinkFilter,
    text: Text,
    refusal: String,
    finish: Option<String>,
    /// `[DONE]` arrived.
    done: bool,
}

impl<'k> ChatStream<'k> {
    /// `key` is redacted from errors the provider reports in the stream.
    pub fn new(key: Option<&'k str>) -> Self {
        Self {
            key,
            think: ThinkFilter::default(),
            text: Text::default(),
            refusal: String::new(),
            finish: None,
            done: false,
        }
    }

    /// The reply text and why it ended, or why there is none.
    pub fn finish(mut self) -> Result<(String, Stop), AiError> {
        let rest = self.think.finish();
        self.text.push(&rest);
        if !self.refusal.trim().is_empty() {
            return Err(AiError::new(ErrorKind::Refused, self.refusal.trim()));
        }
        let finish = self.finish.as_deref().unwrap_or("");
        if finish == "content_filter" {
            return Err(AiError::new(
                ErrorKind::Refused,
                "the provider's content filter withheld the reply",
            ));
        }
        // Complete once there is a finish reason or `[DONE]` (some servers
        // omit one of them).
        if self.finish.is_none() && !self.done {
            return Err(stream::cut_short());
        }
        if self.text.is_empty() {
            let message = if finish == "length" {
                "the token limit ran out before any reply text (reasoning may have used it up)"
            } else {
                "the model returned an empty reply"
            };
            return Err(AiError::new(ErrorKind::Empty, message));
        }
        let stop = if finish == "length" {
            Stop::Length
        } else {
            Stop::End
        };
        Ok((self.text.finish(), stop))
    }
}

impl StreamState for ChatStream<'_> {
    fn event(&mut self, event: &SseEvent) -> Result<Flow, AiError> {
        let data = event.data.trim();
        if data == "[DONE]" {
            self.done = true;
            return Ok(Flow::Done);
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            // Keep-alives and other non-JSON lines.
            return Ok(Flow::Continue);
        };
        if let Some(error) = chunk.get("error").filter(|e| !e.is_null()) {
            let message = error["message"]
                .as_str()
                .or_else(|| error.as_str())
                .unwrap_or("");
            return Err(stream::provider_error(message, self.key));
        }
        // Chunks with no choices (usage, keep-alives) carry nothing here.
        let Some(choice) = chunk.pointer("/choices/0") else {
            return Ok(Flow::Continue);
        };
        let delta = &choice["delta"];
        if let Some(refusal) = delta["refusal"].as_str() {
            self.refusal.push_str(refusal);
        }
        // `reasoning_content` and `reasoning` are not reply text.
        let content = content_text(&delta["content"]);
        if !content.is_empty() {
            let passed = self.think.push(&content);
            self.text.push(&passed);
        }
        if let Some(finish) = choice["finish_reason"].as_str() {
            self.finish = Some(finish.to_string());
        }
        Ok(Flow::Continue)
    }

    fn take_text(&mut self) -> String {
        self.text.take()
    }
}

pub async fn models(
    client: &reqwest::Client,
    base_url: &str,
    key: Option<&str>,
) -> Result<Vec<String>, AiError> {
    let url = format!("{base_url}/models");
    let response = http::send(authorize(client.get(&url), key), key, http::REQUEST_TIMEOUT)
        .await
        .map_err(|f| f.into_error(key))?;
    Ok(parse_models(&response))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::stub::{self, Canned};

    fn req() -> Completion<'static> {
        Completion {
            model: "m-1",
            system: "sys",
            prompt: "hello",
            max_tokens: 100,
            effort: Some(Effort::Low),
            timeout: http::REQUEST_TIMEOUT,
            extra: None,
        }
    }

    fn reply(content: Value, finish: &str) -> Value {
        json!({ "choices": [{ "index": 0, "message": { "role": "assistant", "content": content }, "finish_reason": finish }] })
    }

    #[test]
    fn body_shapes_by_flavor() {
        let b = build_body(Flavor::OpenAi, &req(), true, false);
        assert_eq!(b["max_completion_tokens"], 100);
        assert!(b.get("max_tokens").is_none());
        assert_eq!(b["reasoning_effort"], "low");
        assert_eq!(
            b["messages"][0],
            json!({ "role": "system", "content": "sys" })
        );
        assert_eq!(
            b["messages"][1],
            json!({ "role": "user", "content": "hello" })
        );
        for sampling in ["temperature", "top_p", "top_k"] {
            assert!(b.get(sampling).is_none());
        }

        let b = build_body(Flavor::OpenRouter, &req(), true, false);
        assert_eq!(b["max_tokens"], 100);
        assert_eq!(b["reasoning"]["effort"], "low");
        assert!(b.get("reasoning_effort").is_none());

        let b = build_body(Flavor::Gemini, &req(), true, false);
        assert_eq!(b["reasoning_effort"], "low");
        let b = build_body(Flavor::DeepSeek, &req(), false, false);
        assert!(b.get("reasoning_effort").is_none());
        let b = build_body(Flavor::Custom, &req(), true, false);
        assert_eq!(b["reasoning_effort"], "low");
        let mut r = req();
        r.effort = None;
        let b = build_body(Flavor::Custom, &r, true, false);
        assert!(b.get("reasoning_effort").is_none());
        assert!(b.get("reasoning").is_none());

        // Other levels, and off.
        let mut r = req();
        r.effort = Some(Effort::Xhigh);
        assert_eq!(
            build_body(Flavor::OpenAi, &r, true, false)["reasoning_effort"],
            "xhigh"
        );
        assert_eq!(
            build_body(Flavor::OpenRouter, &r, true, false)["reasoning"]["effort"],
            "xhigh"
        );
        r.effort = Some(Effort::None);
        let b = build_body(Flavor::DeepSeek, &r, true, false);
        assert_eq!(b["thinking"], json!({ "type": "disabled" }));
        assert!(b.get("reasoning_effort").is_none());
        assert_eq!(
            build_body(Flavor::OpenAi, &r, true, false)["reasoning_effort"],
            "none"
        );

        let mut r = req();
        r.system = "  ";
        let b = build_body(Flavor::Custom, &r, false, false);
        assert_eq!(b["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn extra_is_merged_last() {
        let extra = json!({
            "max_completion_tokens": 50,
            "reasoning_effort": null,
            "provider": { "order": ["a"] },
            "stop": ["x"]
        });
        let extra = extra.as_object().unwrap();
        let mut r = req();
        r.extra = Some(extra);
        let b = build_body(Flavor::OpenAi, &r, true, false);
        assert_eq!(b["max_completion_tokens"], 50);
        assert!(b.get("reasoning_effort").is_none());
        assert_eq!(b["provider"]["order"][0], "a");
        assert_eq!(b["stop"], json!(["x"]));
        assert_eq!(b["model"], "m-1");

        let extra = json!({ "reasoning": { "exclude": false, "max_tokens": 10 } });
        r.extra = Some(extra.as_object().unwrap());
        let b = build_body(Flavor::OpenRouter, &r, true, false);
        assert_eq!(
            b["reasoning"],
            json!({ "effort": "low", "exclude": false, "max_tokens": 10 })
        );
    }

    #[test]
    fn parses_replies() {
        assert_eq!(
            parse_reply(&reply(json!(" ls -la\n"), "stop")).unwrap(),
            "ls -la"
        );
        assert_eq!(
            parse_reply(&reply(
                json!([{ "type": "text", "text": "git " }, { "type": "text", "text": "status" }]),
                "stop"
            ))
            .unwrap(),
            "git status"
        );
        assert_eq!(
            parse_reply(&reply(json!("<think>hmm</think>\nmake"), "stop")).unwrap(),
            "make"
        );
        let e = parse_reply(&reply(json!("<think>still going"), "length")).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Empty);
        let e = parse_reply(&reply(Value::Null, "stop")).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Empty);
        let e = parse_reply(&reply(json!(""), "content_filter")).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Refused);
        let refusal = json!({ "choices": [{ "message": { "content": null, "refusal": "I can't help" }, "finish_reason": "stop" }] });
        let e = parse_reply(&refusal).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Refused);
        assert_eq!(e.message, "I can't help");
        assert_eq!(parse_reply(&json!({})).unwrap_err().kind, ErrorKind::Other);
    }

    #[test]
    fn filters_non_text_model_ids() {
        for id in [
            "gpt-4o-audio-preview",
            "gpt-realtime",
            "gpt-4o-mini-tts",
            "whisper-1",
            "dall-e-3",
            "gpt-image-1",
            "text-embedding-3-small",
            "omni-moderation-latest",
            "sora-2",
            "imagen-4.0-generate-001",
            "veo-3.1-generate-preview",
            "aqa",
            "gemini-2.5-flash-image",
            "gemini-live-2.5-flash-preview",
            "nomic-embed-text",
            "gpt-4o-transcribe",
            "stable-diffusion-xl",
            "Models/Gemini-Embedding-001",
        ] {
            assert!(!is_text_model(id), "{id} should be dropped");
        }
        for id in [
            "gpt-4o",
            "o3-mini",
            "gpt-4o-search-preview",
            "gemini-2.5-flash-lite",
            "deepseek-reasoner",
            "llama-3.2-11b-vision-preview",
            "mistral-7b-instruct",
            "openai/gpt-4o",
            "computer-use-preview",
            "claude-sonnet-4-5",
        ] {
            assert!(is_text_model(id), "{id} should be kept");
        }
    }

    #[test]
    fn filters_models_by_modalities() {
        let v = json!({ "data": [
            { "id": "a/vision", "architecture": { "input_modalities": ["text", "image"], "output_modalities": ["text"] } },
            { "id": "b/painter", "architecture": { "input_modalities": ["text"], "output_modalities": ["image"] } },
            { "id": "c/both", "architecture": { "input_modalities": ["text"], "output_modalities": ["text", "image"] } },
            { "id": "d/no-text-in", "architecture": { "input_modalities": ["audio"], "output_modalities": ["text"] } },
            { "id": "d/odd-input", "architecture": { "input_modalities": "image", "output_modalities": ["text"] } },
            { "id": "e/legacy", "architecture": { "modality": "text+image->text" } },
            { "id": "f/legacy-image", "architecture": { "modality": "text->image" } },
            // Modalities win over the id: this "image" model outputs text.
            { "id": "g/image-describer", "architecture": { "output_modalities": ["text"] } },
            // No modalities: the id decides.
            { "id": "h/gpt-image-1" },
            { "id": "i/plain" }
        ] });
        assert_eq!(
            parse_models(&v),
            vec!["a/vision", "e/legacy", "g/image-describer", "i/plain"]
        );
    }

    #[test]
    fn parses_models() {
        let v = json!({ "object": "list", "data": [{ "id": "b" }, { "id": "models/a" }, { "id": "b" }, { "x": 1 }, { "id": "whisper-1" }] });
        assert_eq!(parse_models(&v), vec!["a", "b"]);
        assert!(parse_models(&json!({})).is_empty());
    }

    #[tokio::test]
    async fn completes_against_stub() {
        let server = stub::serve(vec![Canned::json(200, reply(json!("echo hi"), "stop"))]).await;
        let text = complete(
            &stub::client(),
            Flavor::OpenAi,
            &server.url,
            Some("sk-test"),
            &req(),
        )
        .await
        .unwrap()
        .text;
        assert_eq!(text, "echo hi");
        let sent = &server.requests()[0];
        assert_eq!(sent.method, "POST");
        assert_eq!(sent.path, "/chat/completions");
        assert_eq!(sent.header("authorization"), Some("Bearer sk-test"));
        assert_eq!(sent.json()["model"], "m-1");
    }

    #[tokio::test]
    async fn custom_without_key_sends_no_auth() {
        let server = stub::serve(vec![Canned::json(200, reply(json!("pwd"), "stop"))]).await;
        complete(&stub::client(), Flavor::Custom, &server.url, None, &req())
            .await
            .unwrap();
        assert_eq!(server.requests()[0].header("authorization"), None);
    }

    #[tokio::test]
    async fn retries_without_effort_when_rejected() {
        let server = stub::serve(vec![
            Canned::json(400, json!({ "error": { "message": "Unrecognized request argument supplied: reasoning_effort" } })),
            Canned::json(200, reply(json!("ok"), "stop")),
        ])
        .await;
        let text = complete(
            &stub::client(),
            Flavor::OpenAi,
            &server.url,
            Some("k"),
            &req(),
        )
        .await
        .unwrap()
        .text;
        assert_eq!(text, "ok");
        let sent = server.requests();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].json()["reasoning_effort"], "low");
        assert!(sent[1].json().get("reasoning_effort").is_none());
    }

    #[tokio::test]
    async fn retry_without_effort_keeps_extra() {
        let server = stub::serve(vec![
            Canned::json(
                400,
                json!({ "error": { "message": "reasoning_effort is not supported" } }),
            ),
            Canned::json(200, reply(json!("ok"), "stop")),
        ])
        .await;
        let extra = json!({ "user": "midterm", "metadata": { "a": 1 } });
        let mut r = req();
        r.extra = Some(extra.as_object().unwrap());
        complete(&stub::client(), Flavor::OpenAi, &server.url, Some("k"), &r)
            .await
            .unwrap();
        let sent = server.requests();
        assert_eq!(sent.len(), 2);
        for body in [sent[0].json(), sent[1].json()] {
            assert_eq!(body["user"], "midterm");
            assert_eq!(body["metadata"]["a"], 1);
        }
        assert!(sent[1].json().get("reasoning_effort").is_none());
    }

    #[tokio::test]
    async fn refusal_empty_and_http_errors() {
        let refusal = json!({ "choices": [{ "message": { "content": null, "refusal": "no" }, "finish_reason": "stop" }] });
        let server = stub::serve(vec![Canned::json(200, refusal)]).await;
        let e = complete(
            &stub::client(),
            Flavor::OpenAi,
            &server.url,
            Some("k"),
            &req(),
        )
        .await
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Refused);

        let server = stub::serve(vec![Canned::json(200, reply(json!(""), "length"))]).await;
        let e = complete(
            &stub::client(),
            Flavor::DeepSeek,
            &server.url,
            Some("k"),
            &req(),
        )
        .await
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Empty);

        let server = stub::serve(vec![Canned::json(
            401,
            json!({ "error": { "message": "Incorrect API key" } }),
        )])
        .await;
        let e = complete(
            &stub::client(),
            Flavor::OpenAi,
            &server.url,
            Some("bad"),
            &req(),
        )
        .await
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Auth);
        assert!(e.message.contains("Incorrect API key"));

        let server = stub::serve(vec![Canned::json(
            500,
            json!({ "error": { "message": "boom" } }),
        )])
        .await;
        let e = complete(
            &stub::client(),
            Flavor::Gemini,
            &server.url,
            Some("k"),
            &req(),
        )
        .await
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Http);
        assert_eq!(server.requests().len(), 1, "a 500 is not retried");
    }

    #[tokio::test]
    async fn unreachable_server_is_a_network_error() {
        // Bind and drop to get a port nothing listens on.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let e = complete(
            &stub::client(),
            Flavor::Custom,
            &format!("http://127.0.0.1:{port}"),
            None,
            &req(),
        )
        .await
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Network);
    }

    #[tokio::test]
    async fn lists_models() {
        let server = stub::serve(vec![Canned::json(
            200,
            json!({ "data": [{ "id": "z" }, { "id": "a" }] }),
        )])
        .await;
        let ids = models(&stub::client(), &server.url, Some("k"))
            .await
            .unwrap();
        assert_eq!(ids, vec!["a", "z"]);
        assert_eq!(server.requests()[0].path, "/models");
        assert_eq!(server.requests()[0].method, "GET");
    }

    /* ---- Streaming ---- */

    fn sse_data(v: Value) -> String {
        format!("data: {v}\n\n")
    }

    fn delta(content: &str) -> String {
        sse_data(
            json!({ "choices": [{ "index": 0, "delta": { "content": content }, "finish_reason": null }] }),
        )
    }

    fn finish(reason: &str) -> String {
        sse_data(json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": reason }] }))
    }

    const DONE: &str = "data: [DONE]\n\n";

    /// Feeds frames (each one network chunk) to a fresh state, returning
    /// the per-chunk deltas and the outcome.
    fn run(frames: &[String]) -> (Vec<String>, Result<(String, Stop), AiError>) {
        let mut parser = crate::ai::sse::SseParser::new();
        let mut state = ChatStream::new(Some("sk-secret"));
        let mut deltas = Vec::new();
        for frame in frames {
            for event in parser.push(frame.as_bytes()) {
                if let Err(e) = state.event(&event) {
                    return (deltas, Err(e));
                }
            }
            let text = state.take_text();
            if !text.is_empty() {
                deltas.push(text);
            }
        }
        (deltas, state.finish())
    }

    #[test]
    fn stream_concatenates_deltas() {
        let (deltas, out) = run(&[
            delta("\n  Hello"),
            delta(", wor"),
            delta("ld!\n"),
            finish("stop"),
            DONE.into(),
        ]);
        assert_eq!(deltas, vec!["Hello", ", wor", "ld!\n"]);
        assert_eq!(out.unwrap(), ("Hello, world!".into(), Stop::End));
        // Text parts, and an empty-choices chunk (usage), and reasoning.
        let (deltas, out) = run(&[
            sse_data(
                json!({ "choices": [{ "delta": { "content": [{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }] } }] }),
            ),
            sse_data(json!({ "choices": [], "usage": { "total_tokens": 3 } })),
            sse_data(
                json!({ "choices": [{ "delta": { "reasoning_content": "hmm", "reasoning": "hmm" } }] }),
            ),
            ": keep-alive\n\n".into(),
            delta("c"),
            DONE.into(),
        ]);
        assert_eq!(deltas, vec!["ab", "c"]);
        assert_eq!(out.unwrap().0, "abc");
    }

    #[test]
    fn stream_stops_at_done() {
        let mut state = ChatStream::new(None);
        let ev = |data: &str| SseEvent {
            event: "message".into(),
            data: data.into(),
        };
        assert_eq!(state.event(&ev("[DONE]")).unwrap(), Flow::Done);
    }

    #[test]
    fn stream_swallows_a_think_block_split_across_deltas() {
        let (deltas, out) = run(&[
            delta("  <thi"),
            delta("nk>let me see</th"),
            delta("ink>\n\nls"),
            delta(" -la"),
            finish("stop"),
        ]);
        assert_eq!(deltas, vec!["ls", " -la"]);
        assert_eq!(out.unwrap().0, "ls -la");
        // A prefix of `<think>` that turns out not to be one is passed on.
        let (deltas, out) = run(&[delta("<th"), delta("ings>"), finish("stop")]);
        assert_eq!(deltas, vec!["<things>"]);
        assert_eq!(out.unwrap().0, "<things>");
        // A held prefix at the end of the stream is not lost.
        let (_, out) = run(&[delta("<"), finish("stop")]);
        assert_eq!(out.unwrap().0, "<");
        // An unclosed block: no answer.
        let (deltas, out) = run(&[
            delta("<think>"),
            delta("x".repeat(200).as_str()),
            finish("length"),
        ]);
        assert!(deltas.is_empty());
        let e = out.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Empty);
        assert!(e.message.contains("token limit"));
    }

    #[test]
    fn think_filter_keeps_multibyte_text_intact() {
        let mut f = ThinkFilter::default();
        assert_eq!(f.push("<think>"), "");
        assert_eq!(f.push(&"é".repeat(40)), "");
        assert_eq!(f.push("</thi"), "");
        assert_eq!(f.push("nk>ünï"), "ünï");
        assert_eq!(f.push("x"), "x");
    }

    #[test]
    fn stream_refusal_and_content_filter() {
        let refusal = |r: &str| sse_data(json!({ "choices": [{ "delta": { "refusal": r } }] }));
        let (_, out) = run(&[
            refusal("I can't "),
            refusal("help with that."),
            finish("stop"),
        ]);
        let e = out.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Refused);
        assert_eq!(e.message, "I can't help with that.");
        let (_, out) = run(&[delta("partial"), finish("content_filter")]);
        assert_eq!(out.unwrap_err().kind, ErrorKind::Refused);
    }

    #[test]
    fn stream_length_with_and_without_text() {
        let (_, out) = run(&[delta("cut sh"), finish("length")]);
        assert_eq!(out.unwrap(), ("cut sh".into(), Stop::Length));
        let (_, out) = run(&[delta("  "), finish("length")]);
        let e = out.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Empty);
        assert!(e.message.contains("token limit"));
        let (_, out) = run(&[DONE.into()]);
        let e = out.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Empty);
        assert!(!e.message.contains("token limit"));
    }

    #[test]
    fn stream_cut_short_is_an_error() {
        let (deltas, out) = run(&[delta("half a rep")]);
        assert_eq!(deltas, vec!["half a rep"]);
        assert_eq!(out.unwrap_err().kind, ErrorKind::Network);
        // Either a finish reason or `[DONE]` is enough.
        assert_eq!(run(&[delta("a"), finish("stop")]).1.unwrap().0, "a");
        assert_eq!(run(&[delta("a"), DONE.into()]).1.unwrap().0, "a");
    }

    #[test]
    fn stream_error_chunk() {
        let (deltas, out) = run(&[
            delta("a"),
            sse_data(
                json!({ "error": { "message": "upstream failed for sk-secret", "code": 502 } }),
            ),
            delta("b"),
        ]);
        assert_eq!(deltas, vec!["a"]);
        let e = out.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Http);
        assert!(e.message.contains("upstream failed"), "{}", e.message);
        assert!(!e.message.contains("sk-secret"), "{}", e.message);
    }

    fn collector() -> (
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        impl Fn(&str) + Send + Sync,
    ) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        (seen, move |t: &str| {
            sink.lock().unwrap().push(t.to_string())
        })
    }

    #[tokio::test]
    async fn streams_against_stub() {
        let server = stub::serve(vec![Canned::sse(
            vec![delta("Hel"), delta("lo"), finish("stop"), DONE.into()],
            std::time::Duration::from_millis(20),
        )])
        .await;
        let (seen, emit) = collector();
        let out = stream(
            &stub::client(),
            Flavor::OpenAi,
            &server.url,
            Some("k"),
            &req(),
            &emit,
        )
        .await
        .unwrap();
        assert_eq!(out.text, "Hello");
        assert_eq!(out.stop, Stop::End);
        assert!(!out.effort_dropped);
        // TCP may merge writes into one chunk: compare the joined text.
        assert_eq!(seen.lock().unwrap().concat(), "Hello");
        let sent = server.requests()[0].json();
        assert_eq!(sent["stream"], true);
    }

    #[tokio::test]
    async fn stream_falls_back_to_json() {
        let server = stub::serve(vec![Canned::json(
            200,
            reply(json!(" whole reply "), "stop"),
        )])
        .await;
        let (seen, emit) = collector();
        let out = stream(
            &stub::client(),
            Flavor::Custom,
            &server.url,
            None,
            &req(),
            &emit,
        )
        .await
        .unwrap();
        assert_eq!(out.text, "whole reply");
        assert_eq!(out.stop, Stop::End);
        assert_eq!(*seen.lock().unwrap(), vec!["whole reply"]);
        // A reply cut short by the token limit says so.
        let server = stub::serve(vec![Canned::json(200, reply(json!("cut"), "length"))]).await;
        let out = stream(
            &stub::client(),
            Flavor::Custom,
            &server.url,
            None,
            &req(),
            &|_| {},
        )
        .await
        .unwrap();
        assert_eq!(out.stop, Stop::Length);
        // Not JSON either.
        let mut garbage = Canned::json(200, json!(null));
        garbage.body = "<html>oops</html>".into();
        let server = stub::serve(vec![garbage]).await;
        let e = stream(
            &stub::client(),
            Flavor::Custom,
            &server.url,
            None,
            &req(),
            &|_| {},
        )
        .await
        .unwrap_err();
        assert!(e.message.contains("not JSON"), "{}", e.message);
    }

    #[tokio::test]
    async fn stream_retries_without_effort_before_streaming() {
        let server = stub::serve(vec![
            Canned::json(400, json!({ "error": { "message": "Unrecognized request argument supplied: reasoning_effort" } })),
            Canned::sse(vec![delta("ok"), DONE.into()], std::time::Duration::ZERO),
        ])
        .await;
        let (seen, emit) = collector();
        let out = stream(
            &stub::client(),
            Flavor::OpenAi,
            &server.url,
            Some("k"),
            &req(),
            &emit,
        )
        .await
        .unwrap();
        assert!(out.effort_dropped);
        assert_eq!(*seen.lock().unwrap(), vec!["ok"]);
        let sent = server.requests();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].json()["reasoning_effort"], "low");
        assert!(sent[1].json().get("reasoning_effort").is_none());
        assert_eq!(sent[1].json()["stream"], true);
    }

    #[tokio::test]
    async fn stream_auth_error_before_the_stream() {
        let server = stub::serve(vec![Canned::json(
            401,
            json!({ "error": { "message": "Incorrect API key" } }),
        )])
        .await;
        let (seen, emit) = collector();
        let e = stream(
            &stub::client(),
            Flavor::OpenAi,
            &server.url,
            Some("bad"),
            &req(),
            &emit,
        )
        .await
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Auth);
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn stalled_stream_times_out() {
        let server = stub::serve(vec![Canned::sse(
            vec![delta("first"), delta("never")],
            std::time::Duration::from_secs(5),
        )])
        .await;
        let (seen, emit) = collector();
        let mut r = req();
        r.timeout = std::time::Duration::from_millis(300);
        let started = std::time::Instant::now();
        let e = stream(
            &stub::client(),
            Flavor::Custom,
            &server.url,
            None,
            &r,
            &emit,
        )
        .await
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Timeout);
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
        assert_eq!(*seen.lock().unwrap(), vec!["first"]);
        // Headers that never come time out too.
        let server = stub::serve(vec![
            Canned::sse(vec![DONE.into()], std::time::Duration::ZERO)
                .delayed(std::time::Duration::from_secs(5)),
        ])
        .await;
        let e = stream(
            &stub::client(),
            Flavor::Custom,
            &server.url,
            None,
            &r,
            &emit,
        )
        .await
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Timeout);
    }
}
