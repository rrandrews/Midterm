//! What both HTTP adapters share: the client, sending a request and turning
//! its failure into an [`AiError`].

use std::time::Duration;

use serde_json::Value;

use super::error::{AiError, ErrorKind, redact, truncate};

/// Total time allowed for one request, connection included.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub fn build_client() -> Result<reqwest::Client, AiError> {
    reqwest::Client::builder()
        .user_agent(concat!("Midterm/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        // The APIs do not redirect, and a redirect to another origin would
        // carry `x-api-key` along (reqwest strips only `Authorization`).
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AiError::other(format!("could not set up HTTP: {e}")))
}

/// A failed request, keeping the HTTP status and body so the adapters can
/// decide to retry (see `mentions`).
#[derive(Debug)]
pub enum Failure {
    Status { status: u16, body: String },
    Other(AiError),
}

impl Failure {
    /// Whether this is an HTTP 400 whose body mentions any of `words`
    /// (case-insensitive). Used to retry without a parameter the model does
    /// not support.
    pub fn is_bad_request_about(&self, words: &[&str]) -> bool {
        match self {
            Failure::Status { status: 400, body } => {
                let body = body.to_ascii_lowercase();
                words.iter().any(|w| body.contains(w))
            }
            _ => false,
        }
    }

    /// The error to report, with `key` (the request's key) redacted.
    pub fn into_error(self, key: Option<&str>) -> AiError {
        match self {
            Failure::Other(e) => e,
            Failure::Status { status, body } => status_error(status, &body, key),
        }
    }
}

/// Sends `request` and returns the JSON body of a 2xx answer. `key` is the
/// request's key, redacted from any error text.
pub async fn send(request: reqwest::RequestBuilder, key: Option<&str>) -> Result<Value, Failure> {
    let response = request
        .send()
        .await
        .map_err(|e| Failure::Other(transport_error(&e)))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| Failure::Other(transport_error(&e)))?;
    if !status.is_success() {
        return Err(Failure::Status {
            status: status.as_u16(),
            body,
        });
    }
    serde_json::from_str(&body).map_err(|_| {
        Failure::Other(AiError::other(format!(
            "the provider sent a response that is not JSON: {}",
            truncate(&redact(&body, key), 200)
        )))
    })
}

pub fn transport_error(e: &reqwest::Error) -> AiError {
    if e.is_timeout() {
        AiError::new(
            ErrorKind::Timeout,
            format!("no answer within {} s", REQUEST_TIMEOUT.as_secs()),
        )
    } else if e.is_connect() || e.is_request() {
        AiError::new(
            ErrorKind::Network,
            format!("could not reach the provider: {e}"),
        )
    } else {
        AiError::new(ErrorKind::Network, e.to_string())
    }
}

/// The error for a non-2xx answer: 401 and 403 are `auth`, the rest `http`.
/// `key` is redacted from the provider's message before it is shortened.
pub fn status_error(status: u16, body: &str, key: Option<&str>) -> AiError {
    let detail = truncate(&redact(&error_detail(body), key), 300);
    let kind = if matches!(status, 401 | 403) {
        ErrorKind::Auth
    } else {
        ErrorKind::Http
    };
    let message = if detail.is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {detail}")
    };
    AiError::new(kind, message)
}

/// The human-readable message in an error body. OpenAI, Anthropic, DeepSeek
/// and OpenRouter use `{"error": {"message": …}}`; Gemini's compatible
/// endpoint sometimes wraps that in an array; some servers send
/// `{"error": "…"}` or `{"message": "…"}`. Falls back to the raw body.
/// Not shortened: callers redact the key first, then truncate.
pub fn error_detail(body: &str) -> String {
    let Ok(json) = serde_json::from_str::<Value>(body) else {
        return body.to_string();
    };
    let json = match &json {
        Value::Array(items) => items.first().cloned().unwrap_or(Value::Null),
        _ => json,
    };
    let found = json
        .pointer("/error/message")
        .or_else(|| json.get("error").filter(|e| e.is_string()))
        .or_else(|| json.get("message"))
        .and_then(Value::as_str);
    found.unwrap_or(body).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_error_messages() {
        assert_eq!(
            error_detail(r#"{"error":{"message":"bad key","type":"x"}}"#),
            "bad key"
        );
        assert_eq!(
            error_detail(r#"[{"error":{"code":400,"message":"nope"}}]"#),
            "nope"
        );
        assert_eq!(error_detail(r#"{"error":"plain"}"#), "plain");
        assert_eq!(error_detail(r#"{"message":"m"}"#), "m");
        assert_eq!(error_detail("gateway down"), "gateway down");
    }

    #[test]
    fn maps_statuses() {
        assert_eq!(status_error(401, "{}", None).kind, ErrorKind::Auth);
        assert_eq!(status_error(403, "", None).kind, ErrorKind::Auth);
        let e = status_error(429, r#"{"error":{"message":"slow down"}}"#, None);
        assert_eq!(e.kind, ErrorKind::Http);
        assert_eq!(e.message, "HTTP 429: slow down");
        assert_eq!(status_error(500, "", None).message, "HTTP 500");
    }

    #[test]
    fn redacts_before_truncating() {
        // The key straddles the 300-character cut: truncating first would
        // leave its first half in the message.
        let key = "sk-0123456789abcdef";
        let body = format!(
            r#"{{"error":{{"message":"{}{key} is invalid"}}}}"#,
            "x".repeat(290)
        );
        let e = status_error(401, &body, Some(key));
        assert!(!e.message.contains("sk-0123"), "{}", e.message);
        assert!(e.message.contains("[redacted]"), "{}", e.message);
        // Short keys are redacted too.
        let e = status_error(401, r#"{"error":"key abc rejected"}"#, Some("abc"));
        assert_eq!(e.message, "HTTP 401: key [redacted] rejected");
    }

    #[test]
    fn bad_request_about() {
        let f = Failure::Status {
            status: 400,
            body: "Unsupported parameter: 'reasoning_effort'".into(),
        };
        assert!(f.is_bad_request_about(&["reasoning"]));
        assert!(!f.is_bad_request_about(&["effort_x"]));
        let f = Failure::Status {
            status: 500,
            body: "reasoning".into(),
        };
        assert!(!f.is_bad_request_about(&["reasoning"]));
    }
}
