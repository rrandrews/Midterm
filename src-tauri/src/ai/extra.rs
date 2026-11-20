//! Extra request JSON: user-written fields a model profile merges into the
//! request body of an API provider (CLI backends ignore it).
//!
//! It is applied as a JSON Merge Patch (RFC 7386) after the adapter has
//! built the body: objects merge recursively, `null` removes a key, any
//! other value replaces. The user's values win, except for [`PROTECTED`]
//! keys, which [`check`] rejects. Extra JSON cannot change the URL or the
//! headers, so a key still only goes to its provider.

use serde_json::{Map, Value};

use super::error::AiError;

/// Top-level keys extra JSON may not set: Midterm owns them. Mirrored as
/// `PROTECTED_EXTRA_KEYS` in `src/ipc/ai.ts`.
pub const PROTECTED: &[&str] = &[
    "model",
    "messages",
    "system",
    "stream",
    "tools",
    "tool_choice",
    "functions",
    "function_call",
    "n",
];

/// The largest extra JSON accepted, serialized.
pub const MAX_BYTES: usize = 16 * 1024;

/// Keys that carry reasoning settings. When extra JSON sets one, a rejected
/// effort level may be the user's field's fault, so it is not remembered.
const REASONING_KEYS: &[&str] = &["reasoning_effort", "reasoning", "thinking", "output_config"];

/// Rejects extra JSON that sets a protected key or is too large.
pub fn check(extra: &Map<String, Value>) -> Result<(), AiError> {
    if let Some(key) = PROTECTED.iter().find(|k| extra.contains_key(**k)) {
        return Err(AiError::other(format!(
            "extra request JSON cannot set `{key}`"
        )));
    }
    let size = serde_json::to_string(extra).map(|s| s.len()).unwrap_or(0);
    if size > MAX_BYTES {
        return Err(AiError::other(format!(
            "extra request JSON is too large ({size} bytes; the limit is {MAX_BYTES})"
        )));
    }
    Ok(())
}

/// Whether `extra` sets a reasoning field (see [`REASONING_KEYS`]).
pub fn touches_reasoning(extra: Option<&Map<String, Value>>) -> bool {
    extra.is_some_and(|e| REASONING_KEYS.iter().any(|k| e.contains_key(*k)))
}

/// Merges `extra` into `body` (RFC 7386).
pub fn merge(body: &mut Map<String, Value>, extra: &Map<String, Value>) {
    for (key, value) in extra {
        match value {
            Value::Null => {
                body.remove(key);
            }
            Value::Object(patch) => {
                let target = body
                    .entry(key.clone())
                    .and_modify(|v| {
                        if !v.is_object() {
                            *v = Value::Object(Map::new());
                        }
                    })
                    .or_insert_with(|| Value::Object(Map::new()));
                if let Value::Object(target) = target {
                    merge(target, patch);
                }
            }
            other => {
                body.insert(key.clone(), other.clone());
            }
        }
    }
}

/// Merges `extra`, if any, into a body that is a JSON object.
pub fn apply(body: &mut Value, extra: Option<&Map<String, Value>>) {
    if let (Value::Object(body), Some(extra)) = (body, extra) {
        merge(body, extra);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            _ => panic!("not an object"),
        }
    }

    #[test]
    fn merges_as_a_merge_patch() {
        let mut body = map(json!({
            "model": "m",
            "max_tokens": 10,
            "reasoning": { "effort": "low", "exclude": true },
            "stop": ["a"],
            "keep": 1
        }));
        merge(
            &mut body,
            &map(json!({
                "reasoning": { "effort": "high", "exclude": null, "new": { "x": 1 } },
                "stop": ["b", "c"],
                "keep": null,
                "provider": { "order": ["x"] },
                "max_tokens": 20
            })),
        );
        assert_eq!(
            Value::Object(body),
            json!({
                "model": "m",
                "max_tokens": 20,
                "reasoning": { "effort": "high", "new": { "x": 1 } },
                "stop": ["b", "c"],
                "provider": { "order": ["x"] }
            })
        );
        // An object replaces a scalar.
        let mut body = map(json!({ "a": 1 }));
        merge(&mut body, &map(json!({ "a": { "b": null, "c": 2 } })));
        assert_eq!(Value::Object(body), json!({ "a": { "c": 2 } }));
    }

    #[test]
    fn checks_protected_keys_and_size() {
        for key in PROTECTED {
            let mut extra = Map::new();
            extra.insert((*key).to_string(), json!(1));
            let e = check(&extra).unwrap_err();
            assert!(e.message.contains(&format!("`{key}`")), "{}", e.message);
        }
        assert!(check(&map(json!({ "temperature": 0.2, "provider": {} }))).is_ok());
        // Only top-level keys are protected.
        assert!(check(&map(json!({ "provider": { "model": "x" } }))).is_ok());
        let big = map(json!({ "x": "a".repeat(MAX_BYTES) }));
        assert!(check(&big).unwrap_err().message.contains("too large"));
    }

    #[test]
    fn detects_reasoning_fields() {
        assert!(!touches_reasoning(None));
        assert!(!touches_reasoning(Some(&map(json!({ "top_k": 3 })))));
        for key in REASONING_KEYS {
            let mut extra = Map::new();
            extra.insert((*key).to_string(), json!({}));
            assert!(touches_reasoning(Some(&extra)));
        }
    }
}
