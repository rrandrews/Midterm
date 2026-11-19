//! The one error type every AI command returns. Serialized for the webview
//! as `{ kind, message }`, where `kind` lets the UI choose what to show
//! (a "set a key" hint, a quiet retry, nothing at all for `cancelled`).

use std::fmt;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// The provider needs an API key and none is stored.
    NoKey,
    /// The provider rejected the key (HTTP 401/403), or a CLI is not logged in.
    Auth,
    /// The request never got an HTTP answer (DNS, refused connection, TLS).
    Network,
    /// Any other HTTP error status.
    Http,
    /// The model or the provider's filter declined to answer.
    Refused,
    /// The model answered with no text.
    Empty,
    Timeout,
    /// `ai_cancel` was called for the request.
    Cancelled,
    /// A CLI provider's executable could not be found.
    NotFound,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AiError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn other(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Other, message)
    }

    pub fn cancelled() -> Self {
        Self::new(ErrorKind::Cancelled, "the request was cancelled")
    }
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for AiError {}

/// The first `max` characters of `text` (trimmed), with an ellipsis if cut.
pub fn truncate(text: &str, max: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_kind_in_camel_case() {
        let json = serde_json::to_value(AiError::new(ErrorKind::NoKey, "x")).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "noKey", "message": "x" }));
        let json = serde_json::to_value(AiError::new(ErrorKind::NotFound, "y")).unwrap();
        assert_eq!(json["kind"], "notFound");
    }

    #[test]
    fn truncates_on_char_boundaries() {
        assert_eq!(truncate("héllo", 2), "hé…");
        assert_eq!(truncate("  hi  ", 5), "hi");
    }
}
