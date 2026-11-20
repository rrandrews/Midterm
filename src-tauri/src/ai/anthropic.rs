//! Anthropic Messages API over raw HTTP (there is no official Rust SDK).
//!
//! One non-streaming `POST {base}/messages`:
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
use super::http;
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
            None => (
                Shape::Plain,
                max_tokens.min(caps.max_output.unwrap_or(u32::MAX)),
            ),
        },
        Some(_) => (Shape::Plain, max_tokens),
    }
}

pub fn build_body(req: &Completion, shape: Shape) -> Value {
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "messages": [{ "role": "user", "content": req.prompt }],
    });
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

pub fn parse_reply(response: &Value) -> Result<String, AiError> {
    let stop = response["stop_reason"].as_str().unwrap_or("");
    if stop == "refusal" {
        let explanation = response
            .pointer("/stop_details/explanation")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("the model declined to answer");
        return Err(AiError::new(ErrorKind::Refused, explanation.trim()));
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
            "the token limit ran out before any reply text (thinking may have used it up)"
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
    let send = |shape: Shape| {
        let body = build_body(req, shape);
        http::send(
            request(client.post(&url), key).json(&body),
            Some(key),
            req.timeout,
        )
    };
    let mut effort_dropped = false;
    let response = match send(shape).await {
        Err(f) if shape != Shape::Plain && f.is_bad_request_about(EFFORT_WORDS) => {
            effort_dropped = true;
            send(Shape::Plain).await
        }
        other => other,
    }
    .map_err(|f| f.into_error(Some(key)))?;
    Ok(Reply {
        text: parse_reply(&response)?,
        effort_dropped,
    })
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
        let b = build_body(&req(), LOW);
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
        let b = build_body(&r, Shape::Plain);
        assert!(b.get("system").is_none());
        assert!(b.get("output_config").is_none());
        assert!(b.get("thinking").is_none());
        let b = build_body(
            &req(),
            Shape::Effort {
                level: Effort::Xhigh,
                adaptive: true,
            },
        );
        assert_eq!(b["output_config"]["effort"], "xhigh");
        assert_eq!(b["thinking"], json!({ "type": "adaptive" }));
        let b = build_body(&req(), Shape::Budget { budget: 2048 });
        assert_eq!(
            b["thinking"],
            json!({ "type": "enabled", "budget_tokens": 2048 })
        );
        assert!(b.get("output_config").is_none());
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
}
