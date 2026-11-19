//! Anthropic Messages API over raw HTTP (there is no official Rust SDK).
//!
//! One non-streaming `POST {base}/messages`:
//!
//! - headers `x-api-key` and `anthropic-version: 2026-10-21` (the current
//!   API version; the request uses nothing it changed);
//! - no `temperature`/`top_p`/`top_k` (current models reject them) and no
//!   `thinking` field: models that think by default keep adaptive thinking,
//!   older ones run without it;
//! - `output_config: { effort: "low" }`, dropped and retried once if the
//!   model rejects it (older models have no effort parameter);
//! - `max_tokens` includes thinking, so callers pass the answer budget plus
//!   headroom (see `mod.rs`).
//!
//! A `stop_reason` of `refusal` is a `refused` error, carrying
//! `stop_details.explanation` when present.

use serde_json::{Value, json};

use super::Completion;
use super::error::{AiError, ErrorKind};
use super::http::{self, Failure};

pub const API_VERSION: &str = "2026-10-21";

const EFFORT_WORDS: &[&str] = &["effort", "output_config"];

/// Pages of models fetched at most (1000 each).
const MAX_MODEL_PAGES: usize = 10;

pub fn build_body(req: &Completion, with_effort: bool) -> Value {
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "messages": [{ "role": "user", "content": req.prompt }],
    });
    if !req.system.trim().is_empty() {
        body["system"] = json!(req.system);
    }
    if with_effort {
        body["output_config"] = json!({ "effort": "low" });
    }
    body
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
) -> Result<String, AiError> {
    let url = format!("{base_url}/messages");
    let send = |with_effort: bool| {
        let body = build_body(req, with_effort);
        http::send(request(client.post(&url), key).json(&body))
    };
    let response = match send(true).await {
        Err(f) if f.is_bad_request_about(EFFORT_WORDS) => send(false).await,
        other => other,
    }
    .map_err(Failure::into_error)?;
    parse_reply(&response)
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
        let page = http::send(request(client.get(url), key))
            .await
            .map_err(Failure::into_error)?;
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
        }
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
        let b = build_body(&req(), true);
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
        let b = build_body(&r, false);
        assert!(b.get("system").is_none());
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
        let text = complete(&stub::client(), &server.url, "sk-ant", &req())
            .await
            .unwrap();
        assert_eq!(text, "ls");
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
        assert_eq!(
            complete(&stub::client(), &server.url, "k", &req())
                .await
                .unwrap(),
            "ok"
        );
        let sent = server.requests();
        assert!(sent[0].json().get("output_config").is_some());
        assert!(sent[1].json().get("output_config").is_none());
    }

    #[tokio::test]
    async fn refusal_and_http_errors() {
        let refused = json!({ "content": [], "stop_reason": "refusal", "stop_details": { "explanation": "no" } });
        let server = stub::serve(vec![Canned::json(200, refused)]).await;
        let e = complete(&stub::client(), &server.url, "k", &req())
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Refused);

        let server = stub::serve(vec![Canned::json(200, reply("", "max_tokens"))]).await;
        let e = complete(&stub::client(), &server.url, "k", &req())
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Empty);

        let server = stub::serve(vec![Canned::json(401, json!({ "type": "error", "error": { "type": "authentication_error", "message": "invalid x-api-key" } }))]).await;
        let e = complete(&stub::client(), &server.url, "k", &req())
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Auth);
        assert_eq!(e.message, "HTTP 401: invalid x-api-key");

        let server = stub::serve(vec![Canned::json(529, json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } }))]).await;
        let e = complete(&stub::client(), &server.url, "k", &req())
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
