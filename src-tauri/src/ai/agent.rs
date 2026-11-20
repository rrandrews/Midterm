//! The agent's model turns (MID-13): the wire types of `ai_agent_turn` and
//! their translation into each API adapter's request.
//!
//! The loop runs in the webview, one call per model turn. Assistant turns
//! come back as `raw`, the provider-native assistant message as JSON text,
//! and are sent back verbatim: the text is spliced into the request body as
//! a [`RawValue`], never parsed into a `Value` and re-encoded, so thinking
//! blocks, signatures and provider extras survive byte for byte.
//!
//! - Anthropic: `tools: [{ name, description, input_schema }]`; a user
//!   message is one text block; all results of a `tool` message go in one
//!   user message of `tool_result` blocks (`is_error` only when true).
//! - OpenAI-compatible: the system message first; `tools: [{ type:
//!   "function", function: { name, description, parameters } }]`; one
//!   `{ role: "tool", tool_call_id, content }` message per result. There is
//!   no error flag in that shape, so `isError` is not sent: the content is
//!   expected to say so.
//!
//! `tools` is left out when the list is empty. There is no `tool_choice`
//! (automatic) and no `eager_input_streaming`. Extra request JSON merges
//! into the rest of the body as usual; it cannot set `messages`, `tools` or
//! `system`.

use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};

use super::Completion;
use super::anthropic::{self, Shape};
use super::error::AiError;
use super::openai;
use super::provider::Flavor;
use super::stream::{self, Stop, StreamState};

/// Why a CLI target is refused: a CLI runs its own tool loop.
pub const CLI_UNSUPPORTED: &str =
    "The agent needs an API model. Choose another model for Agent in Settings → AI.";

/// A tool the model may call.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// A JSON Schema object.
    pub input_schema: Value,
}

/// One message of the conversation so far.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum AgentMessage {
    User {
        text: String,
    },
    /// Exactly the `raw` an earlier turn returned.
    Assistant {
        raw: String,
    },
    /// The results of one turn's tool calls.
    Tool {
        results: Vec<ToolResult>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    /// The tool call's id.
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

/// A message on `ai_agent_turn`'s channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AgentEvent {
    /// More reply text: append it.
    Text { text: String },
    /// The model started a tool call (once per call).
    ToolCall { id: String, name: String },
}

/// A tool call the model made.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// The parsed arguments (an object); null when they were not valid.
    pub input: Value,
    /// The arguments as received, when they were not a JSON object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalid: Option<String>,
}

/// One model turn.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurn {
    /// The reply text, trimmed (a leading `<think>` block removed).
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    /// The provider-native assistant message as JSON text: send it back
    /// unchanged as `{ role: "assistant", raw }`.
    pub raw: String,
    pub stop: Stop,
    pub effort_dropped: bool,
}

/// Parses tool arguments strictly: a JSON object, or empty (no arguments,
/// `{}`). Anything else gives a null input and the text as `invalid`.
pub fn parse_input(text: &str) -> (Value, Option<String>) {
    if text.trim().is_empty() {
        return (json!({}), None);
    }
    match serde_json::from_str::<Value>(text) {
        Ok(value @ Value::Object(_)) => (value, None),
        _ => (Value::Null, Some(text.to_string())),
    }
}

/// A state that also gathers tool calls: the ones whose id and name became
/// known since the last call.
pub trait TurnState: StreamState {
    fn take_calls(&mut self) -> Vec<(String, String)>;
}

/// Reads an SSE body into `state`, emitting each chunk's text and the tool
/// calls it announced.
pub async fn read(
    response: &mut reqwest::Response,
    idle: std::time::Duration,
    state: &mut impl TurnState,
    emit: &(dyn Fn(AgentEvent) + Send + Sync),
) -> Result<(), AiError> {
    stream::read_with(response, idle, state, |state| {
        let text = state.take_text();
        if !text.is_empty() {
            emit(AgentEvent::Text { text });
        }
        for (id, name) in state.take_calls() {
            emit(AgentEvent::ToolCall { id, name });
        }
    })
    .await
}

/* ---- Request bodies ---- */

/// A message in a request body: built here, or an assistant's `raw`.
enum Msg<'a> {
    Json(Value),
    Raw(&'a RawValue),
}

impl Serialize for Msg<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Msg::Json(value) => value.serialize(serializer),
            Msg::Raw(raw) => raw.serialize(serializer),
        }
    }
}

/// A body: `rest` with `messages` added.
struct Body<'a> {
    rest: &'a Map<String, Value>,
    messages: &'a [Msg<'a>],
}

impl Serialize for Body<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        for (key, value) in self.rest {
            if key != "messages" {
                map.serialize_entry(key, value)?;
            }
        }
        map.serialize_entry("messages", self.messages)?;
        map.end()
    }
}

fn splice(rest: &Map<String, Value>, messages: &[Msg<'_>]) -> Result<String, AiError> {
    serde_json::to_string(&Body { rest, messages })
        .map_err(|e| AiError::other(format!("could not build the request: {e}")))
}

/// An assistant's `raw`, checked to be a JSON object.
fn raw_message(raw: &str) -> Result<&RawValue, AiError> {
    let invalid = || AiError::other("an assistant message in the history is not a JSON object");
    let value: &RawValue = serde_json::from_str(raw).map_err(|_| invalid())?;
    if !value.get().starts_with('{') {
        return Err(invalid());
    }
    Ok(value)
}

fn into_object(body: Value) -> Map<String, Value> {
    match body {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn anthropic_messages(messages: &[AgentMessage]) -> Result<Vec<Msg<'_>>, AiError> {
    let mut out = Vec::with_capacity(messages.len());
    for message in messages {
        match message {
            AgentMessage::User { text } => out.push(Msg::Json(json!({
                "role": "user",
                "content": [{ "type": "text", "text": text }],
            }))),
            AgentMessage::Assistant { raw } => out.push(Msg::Raw(raw_message(raw)?)),
            AgentMessage::Tool { results } if results.is_empty() => {}
            AgentMessage::Tool { results } => {
                let blocks: Vec<Value> = results
                    .iter()
                    .map(|r| {
                        let mut block = json!({
                            "type": "tool_result",
                            "tool_use_id": r.id,
                            "content": r.content,
                        });
                        if r.is_error {
                            block["is_error"] = json!(true);
                        }
                        block
                    })
                    .collect();
                out.push(Msg::Json(json!({ "role": "user", "content": blocks })));
            }
        }
    }
    Ok(out)
}

/// The Anthropic request body for an agent turn (streamed).
pub fn anthropic_body(
    req: &Completion,
    shape: Shape,
    tools: &[ToolDef],
    messages: &[AgentMessage],
) -> Result<String, AiError> {
    let mut rest = into_object(anthropic::build_body(req, shape, true));
    rest.remove("messages");
    if !tools.is_empty() {
        let tools: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                })
            })
            .collect();
        rest.insert("tools".into(), Value::Array(tools));
    }
    splice(&rest, &anthropic_messages(messages)?)
}

fn openai_messages<'a>(
    system: &str,
    messages: &'a [AgentMessage],
) -> Result<Vec<Msg<'a>>, AiError> {
    let mut out = Vec::with_capacity(messages.len() + 1);
    if !system.trim().is_empty() {
        out.push(Msg::Json(json!({ "role": "system", "content": system })));
    }
    for message in messages {
        match message {
            AgentMessage::User { text } => {
                out.push(Msg::Json(json!({ "role": "user", "content": text })));
            }
            AgentMessage::Assistant { raw } => out.push(Msg::Raw(raw_message(raw)?)),
            AgentMessage::Tool { results } => {
                out.extend(results.iter().map(|r| {
                    Msg::Json(json!({
                        "role": "tool",
                        "tool_call_id": r.id,
                        "content": r.content,
                    }))
                }));
            }
        }
    }
    Ok(out)
}

/// The OpenAI-compatible request body for an agent turn (streamed).
pub fn openai_body(
    flavor: Flavor,
    req: &Completion,
    with_effort: bool,
    tools: &[ToolDef],
    messages: &[AgentMessage],
) -> Result<String, AiError> {
    let mut rest = into_object(openai::build_body(flavor, req, with_effort, true));
    rest.remove("messages");
    if !tools.is_empty() {
        let tools: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    },
                })
            })
            .collect();
        rest.insert("tools".into(), Value::Array(tools));
    }
    splice(&rest, &openai_messages(req.system, messages)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::effort::Effort;
    use crate::ai::error::ErrorKind;
    use crate::ai::http;
    use crate::ai::stub::{self, Canned};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn req() -> Completion<'static> {
        Completion {
            model: "m-1",
            system: "sys",
            prompt: "",
            max_tokens: 4096,
            effort: Some(Effort::Low),
            timeout: http::REQUEST_TIMEOUT,
            extra: None,
        }
    }

    const LOW: Shape = Shape::Effort {
        level: Effort::Low,
        adaptive: false,
    };

    /// Odd spacing, key order, escapes and a non-ASCII character: any
    /// re-encoding would change it.
    const RAW: &str = r#"{"role":"assistant",  "content":[{"type":"thinking","thinking":"xA\n","signature":"sé"}], "zzz":1.50}"#;

    fn tools() -> Vec<ToolDef> {
        vec![ToolDef {
            name: "term__run".into(),
            description: "[Terminal] Runs a command.".into(),
            input_schema: json!({ "type": "object", "properties": { "cmd": { "type": "string" } } }),
        }]
    }

    fn history() -> Vec<AgentMessage> {
        serde_json::from_value(json!([
            { "role": "user", "text": "list files" },
            { "role": "assistant", "raw": RAW },
            { "role": "tool", "results": [
                { "id": "c1", "content": "{\"ok\":1}" },
                { "id": "c2", "content": "{\"error\":\"no\"}", "isError": true },
            ] },
        ]))
        .unwrap()
    }

    #[test]
    fn anthropic_body_translates_tools_and_messages() {
        let body = anthropic_body(&req(), LOW, &tools(), &history()).unwrap();
        assert!(body.contains(RAW), "raw was re-encoded: {body}");
        let b: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(b["model"], "m-1");
        assert_eq!(b["system"], "sys");
        assert_eq!(b["stream"], true);
        assert_eq!(b["output_config"]["effort"], "low");
        assert_eq!(
            b["tools"],
            json!([{ "name": "term__run", "description": "[Terminal] Runs a command.",
                     "input_schema": { "type": "object", "properties": { "cmd": { "type": "string" } } } }])
        );
        let messages = b["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(
            messages[0],
            json!({ "role": "user", "content": [{ "type": "text", "text": "list files" }] })
        );
        assert_eq!(messages[1]["zzz"], 1.5);
        // One user message for the round's results; `is_error` only when set.
        assert_eq!(
            messages[2],
            json!({ "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "c1", "content": "{\"ok\":1}" },
                { "type": "tool_result", "tool_use_id": "c2", "content": "{\"error\":\"no\"}", "is_error": true },
            ] })
        );
        for absent in ["tool_choice", "eager_input_streaming"] {
            assert!(!body.contains(absent));
        }
        // No tools: no `tools` field at all.
        let b: Value =
            serde_json::from_str(&anthropic_body(&req(), Shape::Plain, &[], &history()).unwrap())
                .unwrap();
        assert!(b.get("tools").is_none());
        assert!(b.get("output_config").is_none());
    }

    #[test]
    fn openai_body_translates_tools_and_messages() {
        let body = openai_body(Flavor::OpenAi, &req(), true, &tools(), &history()).unwrap();
        assert!(body.contains(RAW), "raw was re-encoded: {body}");
        let b: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(b["max_completion_tokens"], 4096);
        assert_eq!(b["reasoning_effort"], "low");
        assert_eq!(b["stream"], true);
        assert_eq!(
            b["tools"][0],
            json!({ "type": "function", "function": { "name": "term__run",
                    "description": "[Terminal] Runs a command.",
                    "parameters": { "type": "object", "properties": { "cmd": { "type": "string" } } } } })
        );
        let messages = b["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 5);
        assert_eq!(messages[0], json!({ "role": "system", "content": "sys" }));
        assert_eq!(
            messages[1],
            json!({ "role": "user", "content": "list files" })
        );
        // One tool message per result.
        assert_eq!(
            messages[3],
            json!({ "role": "tool", "tool_call_id": "c1", "content": "{\"ok\":1}" })
        );
        assert_eq!(
            messages[4],
            json!({ "role": "tool", "tool_call_id": "c2", "content": "{\"error\":\"no\"}" })
        );
        assert!(!body.contains("tool_choice"));
        let b: Value = serde_json::from_str(
            &openai_body(Flavor::OpenRouter, &req(), false, &[], &history()).unwrap(),
        )
        .unwrap();
        assert!(b.get("tools").is_none());
        assert!(b.get("reasoning").is_none());
        assert_eq!(b["max_tokens"], 4096);
    }

    #[test]
    fn extra_merges_into_the_rest_of_the_body() {
        let extra = json!({ "metadata": { "user_id": "u" }, "max_tokens": 9 });
        let mut r = req();
        r.extra = Some(extra.as_object().unwrap());
        let b: Value =
            serde_json::from_str(&anthropic_body(&r, LOW, &tools(), &history()).unwrap()).unwrap();
        assert_eq!(b["metadata"]["user_id"], "u");
        assert_eq!(b["max_tokens"], 9);
        assert_eq!(b["messages"].as_array().unwrap().len(), 3);
        assert_eq!(b["tools"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn invalid_raw_is_rejected() {
        for raw in ["not json", "[1]", "\"s\"", "{\"a\":"] {
            let messages = vec![AgentMessage::Assistant { raw: raw.into() }];
            let e = anthropic_body(&req(), LOW, &[], &messages).unwrap_err();
            assert_eq!(e.kind, ErrorKind::Other, "{raw}");
            let e = openai_body(Flavor::Custom, &req(), true, &[], &messages).unwrap_err();
            assert_eq!(e.kind, ErrorKind::Other, "{raw}");
        }
    }

    #[test]
    fn parses_inputs_strictly() {
        assert_eq!(parse_input(r#"{"a":1}"#), (json!({ "a": 1 }), None));
        assert_eq!(parse_input("  "), (json!({}), None));
        for bad in [r#"{"a":"#, "[1]", "3", r#"{"a":1} x"#] {
            assert_eq!(parse_input(bad), (Value::Null, Some(bad.to_string())));
        }
    }

    #[test]
    fn wire_types_serialize_camel_case() {
        let turn = AgentTurn {
            text: "t".into(),
            tool_calls: vec![
                ToolCall {
                    id: "a".into(),
                    name: "n".into(),
                    input: json!({}),
                    invalid: None,
                },
                ToolCall {
                    id: "b".into(),
                    name: "n".into(),
                    input: Value::Null,
                    invalid: Some("{".into()),
                },
            ],
            raw: "{}".into(),
            stop: Stop::Tools,
            effort_dropped: false,
        };
        assert_eq!(
            serde_json::to_value(&turn).unwrap(),
            json!({ "text": "t", "toolCalls": [
                { "id": "a", "name": "n", "input": {} },
                { "id": "b", "name": "n", "input": null, "invalid": "{" },
            ], "raw": "{}", "stop": "tools", "effortDropped": false })
        );
        assert_eq!(
            serde_json::to_value(AgentEvent::ToolCall {
                id: "a".into(),
                name: "n".into()
            })
            .unwrap(),
            json!({ "type": "toolCall", "id": "a", "name": "n" })
        );
        assert_eq!(
            serde_json::to_value(AgentEvent::Text { text: "x".into() }).unwrap(),
            json!({ "type": "text", "text": "x" })
        );
    }

    /* ---- Against the stub ---- */

    fn events() -> (
        Arc<Mutex<Vec<AgentEvent>>>,
        impl Fn(AgentEvent) + Send + Sync,
    ) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        (seen, move |e: AgentEvent| sink.lock().unwrap().push(e))
    }

    fn data(v: Value) -> String {
        format!("data: {v}\n\n")
    }

    fn frame(event: &str, data: Value) -> String {
        format!("event: {event}\ndata: {data}\n\n")
    }

    fn joined_text(events: &[AgentEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn calls_seen(events: &[AgentEvent]) -> Vec<(String, String)> {
        events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolCall { id, name } => Some((id.clone(), name.clone())),
                _ => None,
            })
            .collect()
    }

    /// Two interleaved calls (fragments alternating by index), DeepSeek's
    /// `reasoning_content` and a per-call Gemini `extra_content`.
    fn openai_tool_frames() -> Vec<String> {
        let d = |delta: Value| {
            data(json!({ "choices": [{ "index": 0, "delta": delta, "finish_reason": null }] }))
        };
        vec![
            d(json!({ "role": "assistant", "content": null, "reasoning_content": "Think " })),
            d(json!({ "reasoning_content": "more." })),
            d(json!({ "content": "Checking." })),
            d(
                json!({ "tool_calls": [{ "index": 0, "id": "call_a", "type": "function",
                "function": { "name": "fs__list", "arguments": "" },
                "extra_content": { "google": { "thought_signature": "sigA" } } }] }),
            ),
            d(
                json!({ "tool_calls": [{ "index": 1, "id": "call_b", "type": "function",
                "function": { "name": "term__run", "arguments": "{\"cmd\":" } }] }),
            ),
            d(json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "{\"path\":" } }] })),
            d(json!({ "tool_calls": [{ "index": 1, "function": { "arguments": "\"ls\"}" } }] })),
            d(json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "\"/tmp\"}" } }] })),
            data(json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] })),
            "data: [DONE]\n\n".into(),
        ]
    }

    #[tokio::test]
    async fn openai_stream_with_interleaved_tool_calls() {
        let server = stub::serve(vec![Canned::sse(
            openai_tool_frames(),
            Duration::from_millis(5),
        )])
        .await;
        let (seen, emit) = events();
        let turn = openai::agent_turn(
            &stub::client(),
            Flavor::DeepSeek,
            &server.url,
            Some("k"),
            &req(),
            &tools(),
            &history(),
            &emit,
        )
        .await
        .unwrap();
        assert_eq!(turn.text, "Checking.");
        // `finish_reason` says stop, but there are calls.
        assert_eq!(turn.stop, Stop::Tools);
        assert_eq!(
            turn.tool_calls,
            vec![
                ToolCall {
                    id: "call_a".into(),
                    name: "fs__list".into(),
                    input: json!({ "path": "/tmp" }),
                    invalid: None
                },
                ToolCall {
                    id: "call_b".into(),
                    name: "term__run".into(),
                    input: json!({ "cmd": "ls" }),
                    invalid: None
                },
            ]
        );
        let raw: Value = serde_json::from_str(&turn.raw).unwrap();
        assert_eq!(
            raw,
            json!({
                "role": "assistant",
                "content": "Checking.",
                "reasoning_content": "Think more.",
                "tool_calls": [
                    { "id": "call_a", "type": "function",
                      "function": { "name": "fs__list", "arguments": "{\"path\":\"/tmp\"}" },
                      "extra_content": { "google": { "thought_signature": "sigA" } } },
                    { "id": "call_b", "type": "function",
                      "function": { "name": "term__run", "arguments": "{\"cmd\":\"ls\"}" } },
                ],
            })
        );
        let seen = seen.lock().unwrap();
        assert_eq!(joined_text(&seen), "Checking.");
        assert_eq!(
            calls_seen(&seen),
            vec![
                ("call_a".to_string(), "fs__list".to_string()),
                ("call_b".to_string(), "term__run".to_string())
            ]
        );
        let sent = &server.requests()[0];
        assert!(sent.body.contains(RAW));
        assert_eq!(sent.header("content-type"), Some("application/json"));
        assert_eq!(sent.json()["tools"][0]["type"], "function");
    }

    #[tokio::test]
    async fn openai_invalid_arguments_and_stop_mapping() {
        let d = |delta: Value, finish: Value| {
            data(json!({ "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] }))
        };
        let server = stub::serve(vec![
            // Cut-off arguments: flagged, kept as received in raw.
            Canned::sse(
                vec![
                    d(
                        json!({ "tool_calls": [{ "index": 0, "id": "c", "function": { "name": "t", "arguments": "{\"a\":" } }] }),
                        Value::Null,
                    ),
                    d(json!({}), json!("length")),
                ],
                Duration::ZERO,
            ),
            // Text only, cut by the limit.
            Canned::sse(
                vec![
                    d(json!({ "content": "par" }), Value::Null),
                    d(json!({}), json!("length")),
                ],
                Duration::ZERO,
            ),
            // Nothing at all.
            Canned::sse(
                vec![d(json!({}), json!("length"))],
                Duration::ZERO,
            ),
            // Text, ended.
            Canned::sse(
                vec![
                    d(json!({ "content": "<think>x</think>\n done" }), Value::Null),
                    d(json!({}), json!("stop")),
                ],
                Duration::ZERO,
            ),
        ])
        .await;
        let turn = |n: usize| {
            let url = server.url.clone();
            async move {
                let _ = n;
                openai::agent_turn(
                    &stub::client(),
                    Flavor::Custom,
                    &url,
                    None,
                    &req(),
                    &[],
                    &[],
                    &|_| {},
                )
                .await
            }
        };
        let t = turn(0).await.unwrap();
        assert_eq!(t.stop, Stop::Tools);
        assert_eq!(t.tool_calls[0].input, Value::Null);
        assert_eq!(t.tool_calls[0].invalid.as_deref(), Some("{\"a\":"));
        let raw: Value = serde_json::from_str(&t.raw).unwrap();
        assert_eq!(raw["tool_calls"][0]["function"]["arguments"], "{\"a\":");
        assert_eq!(raw["content"], Value::Null);
        let t = turn(1).await.unwrap();
        assert_eq!((t.text.as_str(), t.stop), ("par", Stop::Length));
        assert!(t.tool_calls.is_empty());
        assert!(
            serde_json::from_str::<Value>(&t.raw)
                .unwrap()
                .get("tool_calls")
                .is_none()
        );
        let e = turn(2).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Empty);
        assert!(e.message.contains("token limit"));
        let t = turn(3).await.unwrap();
        assert_eq!((t.text.as_str(), t.stop), ("done", Stop::End));
        // The think block stays in raw: it is what the model said.
        let raw: Value = serde_json::from_str(&t.raw).unwrap();
        assert_eq!(raw["content"], "<think>x</think>\n done");
    }

    #[tokio::test]
    async fn openai_json_fallback_reads_tool_calls() {
        let message = json!({
            "role": "assistant", "content": null,
            "tool_calls": [{ "id": "c9", "type": "function", "function": { "name": "t", "arguments": "{\"x\":true}" } }],
        });
        let server = stub::serve(vec![Canned::json(
            200,
            json!({ "choices": [{ "index": 0, "message": message, "finish_reason": "tool_calls" }] }),
        )])
        .await;
        let (seen, emit) = events();
        let t = openai::agent_turn(
            &stub::client(),
            Flavor::Custom,
            &server.url,
            None,
            &req(),
            &tools(),
            &[],
            &emit,
        )
        .await
        .unwrap();
        assert_eq!(t.text, "");
        assert_eq!(t.stop, Stop::Tools);
        assert_eq!(t.tool_calls[0].input, json!({ "x": true }));
        assert_eq!(serde_json::from_str::<Value>(&t.raw).unwrap(), message);
        assert_eq!(
            calls_seen(&seen.lock().unwrap()),
            vec![("c9".to_string(), "t".to_string())]
        );
    }

    #[tokio::test]
    async fn openai_error_chunk_and_cut_short() {
        let server = stub::serve(vec![
            Canned::sse(
                vec![data(json!({ "error": { "message": "boom" } }))],
                Duration::ZERO,
            ),
            Canned::sse(
                vec![data(
                    json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "c", "function": { "name": "t", "arguments": "{}" } }] } }] }),
                )],
                Duration::ZERO,
            ),
        ])
        .await;
        for kind in [ErrorKind::Http, ErrorKind::Network] {
            let e = openai::agent_turn(
                &stub::client(),
                Flavor::Custom,
                &server.url,
                None,
                &req(),
                &[],
                &[],
                &|_| {},
            )
            .await
            .unwrap_err();
            assert_eq!(e.kind, kind);
        }
    }

    fn block_start(index: u32, block: Value) -> String {
        frame(
            "content_block_start",
            json!({ "type": "content_block_start", "index": index, "content_block": block }),
        )
    }

    fn block_delta(index: u32, delta: Value) -> String {
        frame(
            "content_block_delta",
            json!({ "type": "content_block_delta", "index": index, "delta": delta }),
        )
    }

    fn block_stop(index: u32) -> String {
        frame(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": index }),
        )
    }

    fn message_end(stop: &str, details: Value) -> Vec<String> {
        vec![
            frame(
                "message_delta",
                json!({ "type": "message_delta", "delta": { "stop_reason": stop, "stop_details": details } }),
            ),
            frame("message_stop", json!({ "type": "message_stop" })),
        ]
    }

    fn anthropic_tool_frames() -> Vec<String> {
        let mut frames = vec![
            frame(
                "message_start",
                json!({ "type": "message_start", "message": { "id": "msg_1", "content": [] } }),
            ),
            block_start(
                0,
                json!({ "type": "thinking", "thinking": "", "signature": "" }),
            ),
            block_delta(0, json!({ "type": "thinking_delta", "thinking": "Plan " })),
            block_delta(0, json!({ "type": "thinking_delta", "thinking": "it." })),
            block_delta(
                0,
                json!({ "type": "signature_delta", "signature": "SIG==" }),
            ),
            block_stop(0),
            block_start(1, json!({ "type": "redacted_thinking", "data": "opaque" })),
            block_stop(1),
            block_start(2, json!({ "type": "text", "text": "" })),
            block_delta(2, json!({ "type": "text_delta", "text": "Let me " })),
            block_delta(2, json!({ "type": "text_delta", "text": "look." })),
            block_stop(2),
            block_start(
                3,
                json!({ "type": "tool_use", "id": "toolu_1", "name": "fs__list", "input": {} }),
            ),
            block_delta(3, json!({ "type": "input_json_delta", "partial_json": "" })),
            block_delta(
                3,
                json!({ "type": "input_json_delta", "partial_json": "{\"path\": " }),
            ),
            block_delta(
                3,
                json!({ "type": "input_json_delta", "partial_json": "\"/tmp\"}" }),
            ),
            block_stop(3),
            block_start(
                4,
                json!({ "type": "tool_use", "id": "toolu_2", "name": "term__ping", "input": {} }),
            ),
            block_stop(4),
            frame("ping", json!({ "type": "ping" })),
        ];
        frames.extend(message_end("tool_use", Value::Null));
        frames
    }

    #[tokio::test]
    async fn anthropic_stream_with_thinking_and_tool_uses() {
        let server = stub::serve(vec![Canned::sse(
            anthropic_tool_frames(),
            Duration::from_millis(5),
        )])
        .await;
        let (seen, emit) = events();
        let turn = anthropic::agent_turn(
            &stub::client(),
            &server.url,
            "sk-ant",
            &req(),
            LOW,
            &tools(),
            &history(),
            &emit,
        )
        .await
        .unwrap();
        assert_eq!(turn.text, "Let me look.");
        assert_eq!(turn.stop, Stop::Tools);
        assert_eq!(turn.tool_calls.len(), 2);
        assert_eq!(turn.tool_calls[0].id, "toolu_1");
        assert_eq!(turn.tool_calls[0].input, json!({ "path": "/tmp" }));
        assert_eq!(turn.tool_calls[1].name, "term__ping");
        assert_eq!(turn.tool_calls[1].input, json!({}));
        assert_eq!(
            serde_json::from_str::<Value>(&turn.raw).unwrap(),
            json!({ "role": "assistant", "content": [
                { "type": "thinking", "thinking": "Plan it.", "signature": "SIG==" },
                { "type": "redacted_thinking", "data": "opaque" },
                { "type": "text", "text": "Let me look." },
                { "type": "tool_use", "id": "toolu_1", "name": "fs__list", "input": { "path": "/tmp" } },
                { "type": "tool_use", "id": "toolu_2", "name": "term__ping", "input": {} },
            ] })
        );
        let seen = seen.lock().unwrap();
        assert_eq!(joined_text(&seen), "Let me look.");
        assert_eq!(
            calls_seen(&seen),
            vec![
                ("toolu_1".to_string(), "fs__list".to_string()),
                ("toolu_2".to_string(), "term__ping".to_string())
            ]
        );
        let sent = &server.requests()[0];
        assert!(sent.body.contains(RAW));
        assert_eq!(sent.json()["tools"][0]["name"], "term__run");
        assert_eq!(sent.header("x-api-key"), Some("sk-ant"));
    }

    #[tokio::test]
    async fn anthropic_invalid_input_stop_mapping_and_refusal() {
        let tool = |json: &str| {
            vec![
                block_start(
                    0,
                    json!({ "type": "tool_use", "id": "t1", "name": "x", "input": {} }),
                ),
                block_delta(
                    0,
                    json!({ "type": "input_json_delta", "partial_json": json }),
                ),
                block_stop(0),
            ]
        };
        let with_end = |mut frames: Vec<String>, stop: &str| {
            frames.extend(message_end(stop, Value::Null));
            frames
        };
        let text = |t: &str| {
            vec![
                block_start(0, json!({ "type": "text", "text": "" })),
                block_delta(0, json!({ "type": "text_delta", "text": t })),
            ]
        };
        let mut refused = text("Sure");
        refused.extend(message_end(
            "refusal",
            json!({ "type": "refusal", "explanation": "Not this one." }),
        ));
        let server = stub::serve(vec![
            Canned::sse(with_end(tool("{\"a\": tru"), "max_tokens"), Duration::ZERO),
            Canned::sse(with_end(text("cut"), "max_tokens"), Duration::ZERO),
            Canned::sse(with_end(text("done"), "end_turn"), Duration::ZERO),
            Canned::sse(with_end(text("  "), "end_turn"), Duration::ZERO),
            Canned::sse(refused, Duration::ZERO),
            Canned::sse(text("half"), Duration::ZERO),
        ])
        .await;
        let client = stub::client();
        let r = req();
        let turn = || anthropic::agent_turn(&client, &server.url, "k", &r, LOW, &[], &[], &|_| {});
        // Invalid input: flagged; `{}` in raw so the history stays valid.
        let t = turn().await.unwrap();
        assert_eq!(t.stop, Stop::Length);
        assert_eq!(t.tool_calls[0].input, Value::Null);
        assert_eq!(t.tool_calls[0].invalid.as_deref(), Some("{\"a\": tru"));
        let raw: Value = serde_json::from_str(&t.raw).unwrap();
        assert_eq!(raw["content"][0]["input"], json!({}));
        let t = turn().await.unwrap();
        assert_eq!((t.text.as_str(), t.stop), ("cut", Stop::Length));
        let t = turn().await.unwrap();
        assert_eq!((t.text.as_str(), t.stop), ("done", Stop::End));
        // Whitespace only: empty.
        assert_eq!(turn().await.unwrap_err().kind, ErrorKind::Empty);
        let e = turn().await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Refused);
        assert_eq!(e.message, "Not this one.");
        assert_eq!(turn().await.unwrap_err().kind, ErrorKind::Network);
    }

    /* ---- Through the manager ---- */

    fn custom_target(url: &str) -> crate::ai::Target {
        serde_json::from_value(json!({
            "provider": { "id": "custom", "baseUrl": url },
            "model": "m",
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn cli_targets_are_rejected() {
        let manager = crate::ai::AiManager::default();
        let target: crate::ai::Target = serde_json::from_value(json!({
            "provider": { "id": "claude-code" },
            "model": "",
        }))
        .unwrap();
        let e = manager
            .agent_turn(&target, "", &[], &[], None, &|_| {})
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Other);
        assert_eq!(e.message, CLI_UNSUPPORTED);
    }

    #[tokio::test]
    async fn extra_cannot_set_tools() {
        let manager = crate::ai::AiManager::default();
        let mut target = custom_target("http://127.0.0.1:9");
        target.extra = Some(json!({ "tools": [] }).as_object().unwrap().clone());
        let e = manager
            .agent_turn(&target, "", &tools(), &[], None, &|_| {})
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Other);
        assert!(e.message.contains("`tools`"), "{}", e.message);
    }

    #[tokio::test]
    async fn manager_turn_against_stub() {
        let server = stub::serve(vec![Canned::sse(openai_tool_frames(), Duration::ZERO)]).await;
        let manager = crate::ai::AiManager::default();
        let target = custom_target(&server.url);
        let turn = manager
            .agent_turn(&target, "sys", &tools(), &history(), Some(4096), &|_| {})
            .await
            .unwrap();
        assert_eq!(turn.stop, Stop::Tools);
        let sent = server.requests()[0].json();
        assert_eq!(
            sent["messages"][0],
            json!({ "role": "system", "content": "sys" })
        );
        assert!(sent["max_tokens"].as_u64().unwrap() >= 4096);
    }

    #[tokio::test]
    async fn cancel_mid_turn() {
        let d = |text: String| data(json!({ "choices": [{ "delta": { "content": text } }] }));
        let server = stub::serve(vec![Canned::sse(
            (0..10).map(|i| d(format!("t{i} "))).collect(),
            Duration::from_millis(150),
        )])
        .await;
        let manager = Arc::new(crate::ai::AiManager::default());
        let target = custom_target(&server.url);
        let gate = Arc::new(crate::ai::Gate::default());
        let seen = Arc::new(Mutex::new(Vec::<AgentEvent>::new()));
        let (sink, open) = (seen.clone(), gate.clone());
        let emit = move |e: AgentEvent| open.pass(|| sink.lock().unwrap().push(e));
        let (canceller, watched) = (manager.clone(), seen.clone());
        tokio::spawn(async move {
            while watched.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            canceller.cancel("a1");
        });
        let result = manager
            .cancellable_gated(
                "a1",
                Some(gate),
                manager.agent_turn(&target, "", &[], &[], None, &emit),
            )
            .await;
        assert_eq!(result.unwrap_err().kind, ErrorKind::Cancelled);
        let at_cancel = seen.lock().unwrap().len();
        assert!((1..10).contains(&at_cancel), "{at_cancel}");
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            seen.lock().unwrap().len(),
            at_cancel,
            "an event after cancel"
        );
    }
}
