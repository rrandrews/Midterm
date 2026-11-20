//! Anthropic Messages API over raw HTTP (there is no official Rust SDK).
//!
//! One `POST {base}/messages`, non-streaming ([`complete`]) or streaming
//! ([`stream`]):
//!
//! - headers `x-api-key` and `anthropic-version: 2026-10-21` (the current
//!   API version; the request uses nothing it changed);
//! - no `temperature`/`top_p`/`top_k` (current models reject them);
//! - reasoning as a [`Shape`] (see `effort.rs` for how it is chosen):
//!   `output_config: { effort }`, with `thinking: { type: "adaptive" }`
//!   when the user picked the level and the model supports it; or
//!   `thinking: { type: "enabled", budget_tokens }` on models that only have
//!   budget thinking; or neither. When no level was picked, today's request
//!   is sent: effort `low` and no `thinking` field (models that think by
//!   default keep adaptive thinking, older ones run without it). A rejected
//!   field is dropped and the request retried once;
//! - `max_tokens` includes thinking, so callers pass the answer budget plus
//!   headroom (see `mod.rs`).
//!
//! The model's capabilities (effort levels, thinking types, output cap) come
//! from `GET {base}/models/{id}` ([`capabilities`]).
//!
//! A `stop_reason` of `refusal` is a `refused` error, carrying
//! `stop_details.explanation` when present.

use serde_json::{Value, json};

use super::effort::{AnthropicCaps, Effort};
use super::error::{AiError, ErrorKind};
use super::extra;
use super::http;
use super::sse::SseEvent;
use super::stream::{self, Flow, Stop, StreamState, Streamed, Text};
use super::{Completion, Reply};

pub const API_VERSION: &str = "2026-10-21";

const EFFORT_WORDS: &[&str] = &["effort", "output_config", "thinking", "budget_tokens"];

/// Pages of models fetched at most (1000 each).
const MAX_MODEL_PAGES: usize = 10;

/// The smallest thinking budget the API takes.
const MIN_BUDGET: u32 = 1024;

/// How a request asks for reasoning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// Neither `output_config.effort` nor `thinking`.
    Plain,
    /// `output_config.effort`, plus adaptive thinking when `adaptive`.
    Effort { level: Effort, adaptive: bool },
    /// `thinking: { type: "enabled", budget_tokens }`.
    Budget { budget: u32 },
}

/// Thinking budgets for models without effort, by level.
fn budget_for(level: Effort) -> Option<u32> {
    match level {
        Effort::None => None,
        Effort::Minimal | Effort::Low => Some(1024),
        Effort::Medium => Some(4096),
        _ => Some(16_384),
    }
}

/// The budget and `max_tokens` for a budget-thinking request: the reply
/// budget plus the thinking budget, within the model's output cap. The API
/// wants `1024 <= budget < max_tokens`; if the cap leaves no room for that,
/// there is no thinking (`None`).
pub fn budget_plan(level: Effort, reply: u32, max_output: Option<u32>) -> Option<(u32, u32)> {
    let wanted = budget_for(level)?;
    let cap = max_output.unwrap_or(u32::MAX);
    let max_tokens = reply.saturating_add(wanted).min(cap);
    let budget = wanted.min(max_tokens.saturating_sub(reply.max(1)));
    (budget >= MIN_BUDGET && budget < max_tokens).then_some((budget, max_tokens))
}

/// The request shape for `level` on a model with `caps` (unknown when the
/// lookup failed), and the `max_tokens` to send. `explicit` is whether the
/// user picked the level; `reply` is the reply budget and `max_tokens` what
/// is sent when no thinking budget applies (reply plus headroom).
pub fn plan(
    level: Option<Effort>,
    explicit: bool,
    caps: Option<&AnthropicCaps>,
    reply: u32,
    max_tokens: u32,
) -> (Shape, u32) {
    // Every shape stays within the model's output cap; a budget plan already
    // does (and keeps `budget < max_tokens`).
    let cap = caps.and_then(|c| c.max_output).unwrap_or(u32::MAX);
    let max_tokens = max_tokens.min(cap);
    let Some(level) = level else {
        return (Shape::Plain, max_tokens);
    };
    match caps {
        // Unknown capabilities: effort only, as before.
        None => (
            Shape::Effort {
                level,
                adaptive: false,
            },
            max_tokens,
        ),
        Some(caps) if !caps.effort.is_empty() => (
            Shape::Effort {
                level,
                adaptive: explicit && caps.adaptive,
            },
            max_tokens,
        ),
        Some(caps) if caps.budget => match budget_plan(level, reply, caps.max_output) {
            Some((budget, max_tokens)) => (Shape::Budget { budget }, max_tokens),
            None => (Shape::Plain, max_tokens),
        },
        Some(_) => (Shape::Plain, max_tokens),
    }
}

pub fn build_body(req: &Completion, shape: Shape, stream: bool) -> Value {
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "messages": [{ "role": "user", "content": req.prompt }],
    });
    if stream {
        body["stream"] = json!(true);
    }
    if !req.system.trim().is_empty() {
        body["system"] = json!(req.system);
    }
    match shape {
        Shape::Plain => {}
        Shape::Effort { level, adaptive } => {
            body["output_config"] = json!({ "effort": level.as_str() });
            if adaptive {
                body["thinking"] = json!({ "type": "adaptive" });
            }
        }
        Shape::Budget { budget } => {
            body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget });
        }
    }
    extra::apply(&mut body, req.extra);
    body
}

/// Reads the capabilities object of `GET /v1/models/{id}`.
pub fn parse_caps(model: &Value) -> AnthropicCaps {
    let caps = &model["capabilities"];
    let supported = |v: &Value| v["supported"].as_bool().unwrap_or(false);
    let mut effort: Vec<Effort> = caps["effort"]
        .as_object()
        .map(|levels| {
            levels
                .iter()
                .filter(|(_, v)| supported(v))
                .filter_map(|(name, _)| Effort::parse(name))
                .collect()
        })
        .unwrap_or_default();
    if !supported(&caps["effort"]) {
        effort.clear();
    }
    effort.sort();
    effort.dedup();
    AnthropicCaps {
        effort,
        adaptive: supported(&caps["thinking"]["types"]["adaptive"]),
        budget: supported(&caps["thinking"]["types"]["enabled"]),
        max_output: model["max_tokens"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok()),
    }
}

/// The capabilities of `model`.
pub async fn capabilities(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    model: &str,
) -> Result<AnthropicCaps, AiError> {
    let mut url = reqwest::Url::parse(&format!("{base_url}/models/"))
        .map_err(|e| AiError::other(format!("invalid base URL: {e}")))?;
    url.path_segments_mut()
        .map_err(|_| AiError::other("invalid base URL"))?
        .pop_if_empty()
        .push(model);
    let response = http::send(
        request(client.get(url), key),
        Some(key),
        http::REQUEST_TIMEOUT,
    )
    .await
    .map_err(|f| f.into_error(Some(key)))?;
    Ok(parse_caps(&response))
}

/// The `refused` error for a `stop_reason` of `refusal`.
fn refusal(stop_details: &Value) -> AiError {
    let explanation = stop_details["explanation"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("the model declined to answer");
    AiError::new(ErrorKind::Refused, explanation.trim())
}

const EMPTY_AT_LIMIT: &str =
    "the token limit ran out before any reply text (thinking may have used it up)";

pub fn parse_reply(response: &Value) -> Result<String, AiError> {
    let stop = response["stop_reason"].as_str().unwrap_or("");
    if stop == "refusal" {
        return Err(refusal(&response["stop_details"]));
    }
    let Some(blocks) = response["content"].as_array() else {
        return Err(AiError::other("the response has no content"));
    };
    let text = blocks
        .iter()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("");
    let text = text.trim();
    if text.is_empty() {
        let message = if stop == "max_tokens" {
            EMPTY_AT_LIMIT
        } else {
            "the model returned an empty reply"
        };
        return Err(AiError::new(ErrorKind::Empty, message));
    }
    Ok(text.to_string())
}

fn request(builder: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
    builder
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
}

pub async fn complete(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    req: &Completion<'_>,
    shape: Shape,
) -> Result<Reply, AiError> {
    let url = format!("{base_url}/messages");
    let send = |with_effort: bool| {
        let body = build_body(req, if with_effort { shape } else { Shape::Plain }, false);
        http::send(
            request(client.post(&url), key).json(&body),
            Some(key),
            req.timeout,
        )
    };
    let (response, effort_dropped) =
        http::retry_without_effort(shape != Shape::Plain, EFFORT_WORDS, send).await;
    let response = response.map_err(|f| f.into_error(Some(key)))?;
    Ok(Reply {
        text: parse_reply(&response)?,
        effort_dropped,
    })
}

/// [`complete`], streamed: `emit` gets the reply text as it arrives (one
/// call per network chunk). `req.timeout` limits the wait for the headers
/// and for each chunk.
pub async fn stream(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    req: &Completion<'_>,
    shape: Shape,
    emit: &(dyn Fn(&str) + Send + Sync),
) -> Result<Streamed, AiError> {
    let url = format!("{base_url}/messages");
    let send = |with_effort: bool| {
        let body = build_body(req, if with_effort { shape } else { Shape::Plain }, true);
        http::open_stream(request(client.post(&url), key).json(&body), req.timeout)
    };
    let (response, effort_dropped) =
        http::retry_without_effort(shape != Shape::Plain, EFFORT_WORDS, send).await;
    let mut response = response.map_err(|f| f.into_error(Some(key)))?;
    let mut state = MessageStream::new(Some(key));
    stream::read(&mut response, req.timeout, &mut state, emit).await?;
    let (text, stop) = state.finish()?;
    Ok(Streamed {
        text,
        stop,
        effort_dropped,
    })
}

/// The state of a streamed message.
pub struct MessageStream<'k> {
    key: Option<&'k str>,
    text: Text,
    stop_reason: Option<String>,
    stop_details: Value,
    /// `message_stop` arrived.
    stopped: bool,
}

impl<'k> MessageStream<'k> {
    /// `key` is redacted from errors the provider reports in the stream.
    pub fn new(key: Option<&'k str>) -> Self {
        Self {
            key,
            text: Text::default(),
            stop_reason: None,
            stop_details: Value::Null,
            stopped: false,
        }
    }

    /// The reply text and why it ended, or why there is none.
    pub fn finish(self) -> Result<(String, Stop), AiError> {
        let stop = self.stop_reason.as_deref().unwrap_or("");
        if stop == "refusal" {
            return Err(refusal(&self.stop_details));
        }
        if self.stop_reason.is_none() && !self.stopped {
            return Err(stream::cut_short());
        }
        if self.text.is_empty() {
            let message = if stop == "max_tokens" {
                EMPTY_AT_LIMIT
            } else {
                "the model returned an empty reply"
            };
            return Err(AiError::new(ErrorKind::Empty, message));
        }
        let stop = if stop == "max_tokens" {
            Stop::Length
        } else {
            Stop::End
        };
        Ok((self.text.finish(), stop))
    }
}

impl StreamState for MessageStream<'_> {
    fn event(&mut self, event: &SseEvent) -> Result<Flow, AiError> {
        let Ok(data) = serde_json::from_str::<Value>(&event.data) else {
            return Ok(Flow::Continue);
        };
        let kind = data["type"].as_str().unwrap_or(&event.event);
        match kind {
            "content_block_delta" if data["delta"]["type"] == "text_delta" => {
                if let Some(text) = data["delta"]["text"].as_str() {
                    self.text.push(text);
                }
            }
            "message_delta" => {
                if let Some(stop) = data["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(stop.to_string());
                }
                let details = &data["delta"]["stop_details"];
                if !details.is_null() {
                    self.stop_details = details.clone();
                }
            }
            "message_stop" => {
                self.stopped = true;
                return Ok(Flow::Done);
            }
            "error" => {
                let message = data["error"]["message"].as_str().unwrap_or("");
                return Err(stream::provider_error(message, self.key));
            }
            // thinking_delta, signature_delta, ping, block starts and stops,
            // and events added later.
            _ => {}
        }
        Ok(Flow::Continue)
    }

    fn take_text(&mut self) -> String {
        self.text.take()
    }
}

/// Model ids from `GET {base}/models`, following `has_more`/`last_id`.
pub async fn models(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
) -> Result<Vec<String>, AiError> {
    let mut ids = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_MODEL_PAGES {
        let mut url = reqwest::Url::parse(&format!("{base_url}/models"))
            .map_err(|e| AiError::other(format!("invalid base URL: {e}")))?;
        url.query_pairs_mut().append_pair("limit", "1000");
        if let Some(after) = &after {
            url.query_pairs_mut().append_pair("after_id", after);
        }
        let page = http::send(
            request(client.get(url), key),
            Some(key),
            http::REQUEST_TIMEOUT,
        )
        .await
        .map_err(|f| f.into_error(Some(key)))?;
        if let Some(models) = page["data"].as_array() {
            ids.extend(
                models
                    .iter()
                    .filter_map(|m| m["id"].as_str())
                    .map(String::from),
            );
        }
        match (page["has_more"].as_bool(), page["last_id"].as_str()) {
            (Some(true), Some(last)) => after = Some(last.to_string()),
            _ => break,
        }
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::stub::{self, Canned};

    fn req() -> Completion<'static> {
        Completion {
            model: "claude-x",
            system: "sys",
            prompt: "hello",
            max_tokens: 4200,
            effort: Some(Effort::Low),
            timeout: http::REQUEST_TIMEOUT,
            extra: None,
        }
    }

    /// Today's shape: effort low, no thinking field.
    const LOW: Shape = Shape::Effort {
        level: Effort::Low,
        adaptive: false,
    };

    fn caps(json: Value) -> AnthropicCaps {
        parse_caps(&json)
    }

    #[test]
    fn parses_capabilities() {
        let c = caps(json!({
            "id": "claude-opus-5-5", "max_tokens": 128000,
            "capabilities": {
                "thinking": { "supported": true, "types": { "enabled": { "supported": false }, "adaptive": { "supported": true } } },
                "effort": { "supported": true, "low": { "supported": true }, "medium": { "supported": true },
                            "high": { "supported": true }, "xhigh": { "supported": true }, "max": { "supported": true } },
            },
        }));
        assert_eq!(
            c.effort,
            vec![
                Effort::Low,
                Effort::Medium,
                Effort::High,
                Effort::Xhigh,
                Effort::Max
            ]
        );
        assert!(c.adaptive && !c.budget);
        assert_eq!(c.max_output, Some(128_000));
        let c = caps(json!({
            "max_tokens": 64000,
            "capabilities": {
                "thinking": { "supported": true, "types": { "enabled": { "supported": true }, "adaptive": { "supported": false } } },
                "effort": { "supported": false, "low": { "supported": false } },
            },
        }));
        assert!(c.effort.is_empty() && c.budget && !c.adaptive);
        assert_eq!(caps(json!({})), AnthropicCaps::default());
    }

    #[test]
    fn plans_stay_within_the_output_cap() {
        let capped = |effort: Vec<Effort>, budget| AnthropicCaps {
            effort,
            adaptive: true,
            budget,
            max_output: Some(8192),
        };
        // Provider default: nothing sent, headroom 16384 on a 512 reply.
        assert_eq!(
            plan(
                None,
                false,
                Some(&capped(vec![Effort::High], false)),
                512,
                16_896
            ),
            (Shape::Plain, 8192)
        );
        // An effort shape.
        let (shape, max_tokens) = plan(
            Some(Effort::Max),
            true,
            Some(&capped(vec![Effort::Max], false)),
            512,
            33_280,
        );
        assert!(matches!(shape, Shape::Effort { .. }));
        assert_eq!(max_tokens, 8192);
        // A model without effort or thinking.
        assert_eq!(
            plan(
                Some(Effort::Low),
                false,
                Some(&capped(vec![], false)),
                512,
                16_896
            )
            .1,
            8192
        );
        // Budget thinking keeps its invariant within the cap.
        let (shape, max_tokens) = plan(
            Some(Effort::High),
            true,
            Some(&capped(vec![], true)),
            512,
            16_896,
        );
        let Shape::Budget { budget } = shape else {
            panic!("expected budget thinking, got {shape:?}");
        };
        assert!(budget >= MIN_BUDGET && budget < max_tokens && max_tokens <= 8192);
        // No known cap: unchanged.
        assert_eq!(plan(None, false, None, 512, 16_896), (Shape::Plain, 16_896));
    }

    #[test]
    fn plans_shapes() {
        let effort_model = AnthropicCaps {
            effort: vec![Effort::Low, Effort::High],
            adaptive: true,
            ..Default::default()
        };
        // Midterm's pick: today's request.
        assert_eq!(
            plan(Some(Effort::Low), false, Some(&effort_model), 512, 4608),
            (LOW, 4608)
        );
        // Picked by the user: adaptive thinking too.
        assert_eq!(
            plan(Some(Effort::High), true, Some(&effort_model), 512, 16896).0,
            Shape::Effort {
                level: Effort::High,
                adaptive: true
            }
        );
        // Unknown capabilities: effort only.
        assert_eq!(
            plan(Some(Effort::High), true, None, 512, 1).0,
            Shape::Effort {
                level: Effort::High,
                adaptive: false
            }
        );
        assert_eq!(plan(None, true, None, 512, 99), (Shape::Plain, 99));
        let budget_model = AnthropicCaps {
            budget: true,
            max_output: Some(64_000),
            ..Default::default()
        };
        assert_eq!(
            plan(Some(Effort::Medium), true, Some(&budget_model), 512, 8704),
            (Shape::Budget { budget: 4096 }, 4608)
        );
        assert_eq!(
            plan(Some(Effort::None), false, Some(&budget_model), 512, 4608),
            (Shape::Plain, 4608)
        );
    }

    #[test]
    fn budget_plans_keep_the_api_invariant() {
        for level in [Effort::Low, Effort::Medium, Effort::High, Effort::Max] {
            for reply in [16, 512, 32_000] {
                for cap in [None, Some(2048), Some(8192), Some(64_000)] {
                    if let Some((budget, max_tokens)) = budget_plan(level, reply, cap) {
                        assert!(budget >= MIN_BUDGET, "{level:?} {reply} {cap:?}");
                        assert!(budget < max_tokens, "{level:?} {reply} {cap:?}");
                        assert!(max_tokens <= cap.unwrap_or(u32::MAX));
                    }
                }
            }
        }
        assert_eq!(budget_plan(Effort::High, 512, None), Some((16_384, 16_896)));
        // The cap leaves too little for a budget.
        assert_eq!(budget_plan(Effort::Low, 1500, Some(2048)), None);
        assert_eq!(budget_plan(Effort::None, 512, None), None);
    }

    fn reply(text: &str, stop: &str) -> Value {
        json!({
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-x",
            "content": [{ "type": "thinking", "thinking": "", "signature": "s" }, { "type": "text", "text": text }],
            "stop_reason": stop, "stop_details": null,
        })
    }

    #[test]
    fn body_shape() {
        let b = build_body(&req(), LOW, false);
        assert_eq!(b["model"], "claude-x");
        assert_eq!(b["max_tokens"], 4200);
        assert_eq!(b["system"], "sys");
        assert_eq!(
            b["messages"],
            json!([{ "role": "user", "content": "hello" }])
        );
        assert_eq!(b["output_config"]["effort"], "low");
        for absent in ["temperature", "top_p", "top_k", "thinking"] {
            assert!(b.get(absent).is_none(), "{absent} must not be sent");
        }
        let mut r = req();
        r.system = "";
        let b = build_body(&r, Shape::Plain, false);
        assert!(b.get("system").is_none());
        assert!(b.get("output_config").is_none());
        assert!(b.get("thinking").is_none());
        let b = build_body(
            &req(),
            Shape::Effort {
                level: Effort::Xhigh,
                adaptive: true,
            },
            false,
        );
        assert_eq!(b["output_config"]["effort"], "xhigh");
        assert_eq!(b["thinking"], json!({ "type": "adaptive" }));
        let b = build_body(&req(), Shape::Budget { budget: 2048 }, false);
        assert_eq!(
            b["thinking"],
            json!({ "type": "enabled", "budget_tokens": 2048 })
        );
        assert!(b.get("output_config").is_none());
    }

    #[test]
    fn extra_is_merged_last() {
        let extra = json!({
            "metadata": { "user_id": "u1" },
            "output_config": { "effort": "high" },
            "max_tokens": 9000,
            "top_k": 5
        });
        let mut r = req();
        r.extra = Some(extra.as_object().unwrap());
        let b = build_body(&r, LOW, false);
        assert_eq!(b["metadata"]["user_id"], "u1");
        assert_eq!(b["output_config"]["effort"], "high");
        assert_eq!(b["max_tokens"], 9000);
        assert_eq!(b["top_k"], 5);
        assert_eq!(b["model"], "claude-x");
        let extra = json!({ "system": null });
        r.extra = Some(extra.as_object().unwrap());
        // `check` rejects protected keys before a request is built; merge
        // itself is mechanical.
        assert!(build_body(&r, Shape::Plain, false).get("system").is_none());
    }

    #[test]
    fn parses_replies() {
        assert_eq!(
            parse_reply(&reply(" git push \n", "end_turn")).unwrap(),
            "git push"
        );
        let e = parse_reply(&reply("", "max_tokens")).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Empty);
        assert!(e.message.contains("token limit"));
        assert_eq!(
            parse_reply(&reply("", "end_turn")).unwrap_err().kind,
            ErrorKind::Empty
        );
        let refused = json!({
            "content": [], "stop_reason": "refusal",
            "stop_details": { "type": "refusal", "category": "cyber", "explanation": "Not this one." },
        });
        let e = parse_reply(&refused).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Refused);
        assert_eq!(e.message, "Not this one.");
        let refused = json!({ "content": [], "stop_reason": "refusal", "stop_details": null });
        assert_eq!(parse_reply(&refused).unwrap_err().kind, ErrorKind::Refused);
    }

    #[tokio::test]
    async fn completes_against_stub() {
        let server = stub::serve(vec![Canned::json(200, reply("ls", "end_turn"))]).await;
        let reply = complete(&stub::client(), &server.url, "sk-ant", &req(), LOW)
            .await
            .unwrap();
        assert_eq!(reply.text, "ls");
        assert!(!reply.effort_dropped);
        let sent = &server.requests()[0];
        assert_eq!(sent.path, "/messages");
        assert_eq!(sent.header("x-api-key"), Some("sk-ant"));
        assert_eq!(sent.header("anthropic-version"), Some(API_VERSION));
        assert_eq!(sent.header("authorization"), None);
    }

    #[tokio::test]
    async fn retries_without_effort_when_rejected() {
        let server = stub::serve(vec![
            Canned::json(400, json!({ "type": "error", "error": { "type": "invalid_request_error", "message": "output_config.effort: not supported by this model" } })),
            Canned::json(200, reply("ok", "end_turn")),
        ])
        .await;
        let reply = complete(&stub::client(), &server.url, "k", &req(), LOW)
            .await
            .unwrap();
        assert_eq!(reply.text, "ok");
        assert!(reply.effort_dropped);
        let sent = server.requests();
        assert!(sent[0].json().get("output_config").is_some());
        assert!(sent[1].json().get("output_config").is_none());

        // A rejected thinking field: the retry sends neither.
        let server = stub::serve(vec![
            Canned::json(400, json!({ "type": "error", "error": { "type": "invalid_request_error", "message": "thinking.type.adaptive is not supported" } })),
            Canned::json(200, reply_json("ok")),
        ])
        .await;
        let shape = Shape::Effort {
            level: Effort::High,
            adaptive: true,
        };
        complete(&stub::client(), &server.url, "k", &req(), shape)
            .await
            .unwrap();
        let sent = server.requests();
        assert!(sent[0].json().get("thinking").is_some());
        assert!(sent[1].json().get("thinking").is_none());
        assert!(sent[1].json().get("output_config").is_none());
    }

    #[tokio::test]
    async fn retry_without_effort_keeps_extra() {
        let server = stub::serve(vec![
            Canned::json(400, json!({ "type": "error", "error": { "type": "invalid_request_error", "message": "output_config.effort: not supported by this model" } })),
            Canned::json(200, reply("ok", "end_turn")),
        ])
        .await;
        let extra = json!({ "metadata": { "user_id": "u1" } });
        let mut r = req();
        r.extra = Some(extra.as_object().unwrap());
        complete(&stub::client(), &server.url, "k", &r, LOW)
            .await
            .unwrap();
        let sent = server.requests();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].json()["metadata"]["user_id"], "u1");
        assert_eq!(sent[1].json()["metadata"]["user_id"], "u1");
        assert!(sent[1].json().get("output_config").is_none());
    }

    fn reply_json(text: &str) -> Value {
        reply(text, "end_turn")
    }

    #[tokio::test]
    async fn reads_capabilities() {
        let server = stub::serve(vec![Canned::json(
            200,
            json!({ "id": "claude-x", "max_tokens": 1000, "capabilities": { "effort": { "supported": true, "low": { "supported": true } } } }),
        )])
        .await;
        let c = capabilities(&stub::client(), &server.url, "k", "claude-x")
            .await
            .unwrap();
        assert_eq!(c.effort, vec![Effort::Low]);
        assert_eq!(server.requests()[0].path, "/models/claude-x");
    }

    #[tokio::test]
    async fn refusal_and_http_errors() {
        let refused = json!({ "content": [], "stop_reason": "refusal", "stop_details": { "explanation": "no" } });
        let server = stub::serve(vec![Canned::json(200, refused)]).await;
        let e = complete(&stub::client(), &server.url, "k", &req(), LOW)
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Refused);

        let server = stub::serve(vec![Canned::json(200, reply("", "max_tokens"))]).await;
        let e = complete(&stub::client(), &server.url, "k", &req(), LOW)
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Empty);

        let server = stub::serve(vec![Canned::json(401, json!({ "type": "error", "error": { "type": "authentication_error", "message": "invalid x-api-key" } }))]).await;
        let e = complete(&stub::client(), &server.url, "sk-ant-test", &req(), LOW)
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Auth);
        assert_eq!(e.message, "HTTP 401: invalid x-api-key");

        let server = stub::serve(vec![Canned::json(529, json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } }))]).await;
        let e = complete(&stub::client(), &server.url, "k", &req(), LOW)
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Http);
    }

    #[tokio::test]
    async fn lists_models_across_pages() {
        let server = stub::serve(vec![
            Canned::json(
                200,
                json!({ "data": [{ "id": "b" }], "has_more": true, "last_id": "b" }),
            ),
            Canned::json(
                200,
                json!({ "data": [{ "id": "a" }], "has_more": false, "last_id": "a" }),
            ),
        ])
        .await;
        let ids = models(&stub::client(), &server.url, "k").await.unwrap();
        assert_eq!(ids, vec!["a", "b"]);
        let sent = server.requests();
        assert_eq!(sent[0].path, "/models?limit=1000");
        assert_eq!(sent[1].path, "/models?limit=1000&after_id=b");
    }

    /* ---- Streaming ---- */

    fn frame(event: &str, data: Value) -> String {
        format!("event: {event}\ndata: {data}\n\n")
    }

    fn text_delta(index: u32, text: &str) -> String {
        frame(
            "content_block_delta",
            json!({ "type": "content_block_delta", "index": index, "delta": { "type": "text_delta", "text": text } }),
        )
    }

    fn message_delta(stop: &str, details: Value) -> String {
        frame(
            "message_delta",
            json!({ "type": "message_delta", "delta": { "stop_reason": stop, "stop_sequence": null, "stop_details": details }, "usage": { "output_tokens": 5 } }),
        )
    }

    fn message_stop() -> String {
        frame("message_stop", json!({ "type": "message_stop" }))
    }

    fn run(frames: &[String]) -> (Vec<String>, Result<(String, Stop), AiError>) {
        let mut parser = crate::ai::sse::SseParser::new();
        let mut state = MessageStream::new(Some("sk-ant-secret"));
        let mut deltas = Vec::new();
        for f in frames {
            for event in parser.push(f.as_bytes()) {
                match state.event(&event) {
                    Err(e) => return (deltas, Err(e)),
                    Ok(Flow::Done) => break,
                    Ok(Flow::Continue) => {}
                }
            }
            let text = state.take_text();
            if !text.is_empty() {
                deltas.push(text);
            }
        }
        (deltas, state.finish())
    }

    fn start() -> Vec<String> {
        vec![
            frame(
                "message_start",
                json!({ "type": "message_start", "message": { "id": "msg_1", "content": [], "stop_reason": null } }),
            ),
            frame(
                "content_block_start",
                json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
            ),
            frame(
                "content_block_delta",
                json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "Let me think" } }),
            ),
            frame(
                "content_block_delta",
                json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "sig" } }),
            ),
            frame(
                "content_block_stop",
                json!({ "type": "content_block_stop", "index": 0 }),
            ),
            frame("ping", json!({ "type": "ping" })),
        ]
    }

    #[test]
    fn stream_joins_text_blocks_and_ignores_thinking() {
        let mut frames = start();
        frames.extend([
            text_delta(1, "\n First"),
            frame(
                "content_block_stop",
                json!({ "type": "content_block_stop", "index": 1 }),
            ),
            text_delta(2, " second\n"),
            frame("future_event", json!({ "type": "future_event" })),
            message_delta("end_turn", Value::Null),
            message_stop(),
        ]);
        let (deltas, out) = run(&frames);
        assert_eq!(deltas, vec!["First", " second\n"]);
        assert_eq!(out.unwrap(), ("First second".into(), Stop::End));
    }

    #[test]
    fn stream_cut_short_is_an_error() {
        let mut frames = start();
        frames.push(text_delta(1, "half"));
        let (deltas, out) = run(&frames);
        assert_eq!(deltas, vec!["half"]);
        assert_eq!(out.unwrap_err().kind, ErrorKind::Network);
        assert_eq!(run(&[text_delta(0, "a"), message_stop()]).1.unwrap().0, "a");
    }

    #[test]
    fn stream_error_event() {
        let (deltas, out) = run(&[
            text_delta(0, "a"),
            frame(
                "error",
                json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } }),
            ),
        ]);
        assert_eq!(deltas, vec!["a"]);
        let e = out.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Http);
        assert!(e.message.contains("Overloaded"), "{}", e.message);
    }

    #[test]
    fn stream_refusal_and_max_tokens() {
        let (_, out) = run(&[
            text_delta(0, "Sure"),
            message_delta(
                "refusal",
                json!({ "type": "refusal", "explanation": "Not this one." }),
            ),
            message_stop(),
        ]);
        let e = out.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Refused);
        assert_eq!(e.message, "Not this one.");
        let (_, out) = run(&[message_delta("refusal", Value::Null)]);
        assert_eq!(out.unwrap_err().kind, ErrorKind::Refused);

        let (_, out) = run(&[
            text_delta(0, "cut"),
            message_delta("max_tokens", Value::Null),
        ]);
        assert_eq!(out.unwrap(), ("cut".into(), Stop::Length));
        let mut frames = start();
        frames.push(message_delta("max_tokens", Value::Null));
        let e = run(&frames).1.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Empty);
        assert!(e.message.contains("token limit"));
        let e = run(&[message_stop()]).1.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Empty);
    }

    #[tokio::test]
    async fn streams_against_stub() {
        let mut frames = start();
        frames.extend([
            text_delta(1, "ls"),
            text_delta(1, " -la"),
            message_delta("end_turn", Value::Null),
            message_stop(),
        ]);
        let server = stub::serve(vec![Canned::sse(
            frames,
            std::time::Duration::from_millis(5),
        )])
        .await;
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink = seen.clone();
        let emit = move |t: &str| sink.lock().unwrap().push(t.to_string());
        let out = stream(&stub::client(), &server.url, "sk-ant", &req(), LOW, &emit)
            .await
            .unwrap();
        assert_eq!(out.text, "ls -la");
        // TCP may merge writes into one chunk: compare the joined text.
        assert_eq!(seen.lock().unwrap().concat(), "ls -la");
        let sent = &server.requests()[0];
        assert_eq!(sent.json()["stream"], true);
        assert_eq!(sent.header("x-api-key"), Some("sk-ant"));
    }

    #[tokio::test]
    async fn stream_retries_without_effort_before_streaming() {
        let server = stub::serve(vec![
            Canned::json(400, json!({ "type": "error", "error": { "type": "invalid_request_error", "message": "output_config.effort: not supported by this model" } })),
            Canned::sse(vec![text_delta(0, "ok"), message_stop()], std::time::Duration::ZERO),
        ])
        .await;
        let out = stream(&stub::client(), &server.url, "k", &req(), LOW, &|_| {})
            .await
            .unwrap();
        assert!(out.effort_dropped);
        let sent = server.requests();
        assert!(sent[0].json().get("output_config").is_some());
        assert!(sent[1].json().get("output_config").is_none());
        assert_eq!(sent[1].json()["stream"], true);
    }
}
