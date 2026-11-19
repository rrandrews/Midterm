//! OpenAI-compatible chat completions: OpenAI, DeepSeek, OpenRouter,
//! Gemini's OpenAI-compatible endpoint and any custom base URL.
//!
//! One non-streaming `POST {base}/chat/completions` with a system and a user
//! message. No sampling parameters. Reasoning effort is asked to be low
//! where the provider takes it (see [`build_body`]); a model that rejects
//! the parameter gets the request again without it.

use serde_json::{Map, Value, json};

use super::Completion;
use super::error::{AiError, ErrorKind};
use super::http;
use super::provider::Flavor;

/// Words in a 400 response that mean the effort parameter was the problem.
const EFFORT_WORDS: &[&str] = &["reasoning", "effort"];

/// The request body. Differences by provider:
///
/// - token limit: OpenAI wants `max_completion_tokens` (its reasoning models
///   reject `max_tokens`); the others take `max_tokens`.
/// - effort: `reasoning_effort: "low"` for OpenAI, DeepSeek and Gemini;
///   OpenRouter's normalized `reasoning: { effort: "low", exclude: true }`;
///   nothing for a custom server, whose support is unknown.
pub fn build_body(flavor: Flavor, req: &Completion, with_effort: bool) -> Value {
    let mut messages = Vec::new();
    if !req.system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": req.system }));
    }
    messages.push(json!({ "role": "user", "content": req.prompt }));

    let mut body = Map::new();
    body.insert("model".into(), json!(req.model));
    body.insert("messages".into(), Value::Array(messages));
    body.insert("stream".into(), json!(false));
    let tokens_field = match flavor {
        Flavor::OpenAi => "max_completion_tokens",
        _ => "max_tokens",
    };
    body.insert(tokens_field.into(), json!(req.max_tokens));
    if with_effort {
        match flavor {
            Flavor::OpenAi | Flavor::DeepSeek | Flavor::Gemini => {
                body.insert("reasoning_effort".into(), json!("low"));
            }
            Flavor::OpenRouter => {
                body.insert(
                    "reasoning".into(),
                    json!({ "effort": "low", "exclude": true }),
                );
            }
            Flavor::Custom => {}
        }
    }
    Value::Object(body)
}

fn sends_effort(flavor: Flavor) -> bool {
    flavor != Flavor::Custom
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

/// Model ids from `GET {base}/models` (`{ data: [{ id }] }`), sorted.
/// A `models/` prefix (Gemini's native id form) is dropped.
pub fn parse_models(response: &Value) -> Vec<String> {
    let mut ids: Vec<String> = response["data"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|m| m["id"].as_str())
                .map(|id| id.strip_prefix("models/").unwrap_or(id).to_string())
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
) -> Result<String, AiError> {
    let url = format!("{base_url}/chat/completions");
    let send = |with_effort: bool| {
        let body = build_body(flavor, req, with_effort);
        http::send(authorize(client.post(&url), key).json(&body), key)
    };
    let with_effort = sends_effort(flavor);
    let response = match send(with_effort).await {
        Err(f) if with_effort && f.is_bad_request_about(EFFORT_WORDS) => send(false).await,
        other => other,
    }
    .map_err(|f| f.into_error(key))?;
    parse_reply(&response)
}

pub async fn models(
    client: &reqwest::Client,
    base_url: &str,
    key: Option<&str>,
) -> Result<Vec<String>, AiError> {
    let url = format!("{base_url}/models");
    let response = http::send(authorize(client.get(&url), key), key)
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
        }
    }

    fn reply(content: Value, finish: &str) -> Value {
        json!({ "choices": [{ "index": 0, "message": { "role": "assistant", "content": content }, "finish_reason": finish }] })
    }

    #[test]
    fn body_shapes_by_flavor() {
        let b = build_body(Flavor::OpenAi, &req(), true);
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

        let b = build_body(Flavor::OpenRouter, &req(), true);
        assert_eq!(b["max_tokens"], 100);
        assert_eq!(b["reasoning"]["effort"], "low");
        assert!(b.get("reasoning_effort").is_none());

        let b = build_body(Flavor::Gemini, &req(), true);
        assert_eq!(b["reasoning_effort"], "low");
        let b = build_body(Flavor::DeepSeek, &req(), false);
        assert!(b.get("reasoning_effort").is_none());
        let b = build_body(Flavor::Custom, &req(), true);
        assert!(b.get("reasoning_effort").is_none());
        assert!(b.get("reasoning").is_none());

        let mut r = req();
        r.system = "  ";
        let b = build_body(Flavor::Custom, &r, false);
        assert_eq!(b["messages"].as_array().unwrap().len(), 1);
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
    fn parses_models() {
        let v = json!({ "object": "list", "data": [{ "id": "b" }, { "id": "models/a" }, { "id": "b" }, { "x": 1 }] });
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
        .unwrap();
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
        .unwrap();
        assert_eq!(text, "ok");
        let sent = server.requests();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].json()["reasoning_effort"], "low");
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
}
