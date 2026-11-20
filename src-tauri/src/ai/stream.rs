//! What the streaming adapters share: the outcome type, the text
//! accumulator, and the loop that reads an SSE body into an adapter's
//! stream state.
//!
//! Each adapter's state is an accumulator: [`StreamState::event`] takes one
//! SSE event, [`StreamState::take_text`] drains the text gathered since the
//! last call, and the adapter's own `finish` turns what was gathered into
//! the reply or an error. Tool calls (MID-13) extend the states, not the
//! loop.

use std::time::Duration;

use serde::Serialize;

use super::error::{AiError, ErrorKind, redact, truncate};
use super::http;
use super::sse::{SseEvent, SseParser};

/// Why a streamed reply ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stop {
    /// The model finished.
    End,
    /// The token limit cut the reply short.
    Length,
}

/// A streamed reply: the full text (authoritative over the deltas), why it
/// ended, and whether the provider rejected the effort field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Streamed {
    pub text: String,
    pub stop: Stop,
    pub effort_dropped: bool,
}

/// Whether to keep reading after an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    Continue,
    /// The provider said the reply is complete (`[DONE]`, `message_stop`).
    Done,
}

pub trait StreamState {
    fn event(&mut self, event: &SseEvent) -> Result<Flow, AiError>;
    /// The text gathered since the last call.
    fn take_text(&mut self) -> String;
}

/// Reply text as it streams: leading whitespace is dropped before the first
/// text, deltas are kept until taken, and the whole text is kept for the
/// final reply (which is trimmed).
#[derive(Default)]
pub struct Text {
    all: String,
    pending: String,
}

impl Text {
    pub fn push(&mut self, text: &str) {
        let text = if self.all.is_empty() {
            text.trim_start()
        } else {
            text
        };
        self.all.push_str(text);
        self.pending.push_str(text);
    }

    pub fn take(&mut self) -> String {
        std::mem::take(&mut self.pending)
    }

    /// The whole text, trimmed.
    pub fn finish(self) -> String {
        self.all.trim().to_string()
    }

    pub fn is_empty(&self) -> bool {
        self.all.trim().is_empty()
    }
}

/// A stream that ended (the connection closed cleanly) before the
/// provider said the reply was complete: the text may be cut short.
pub fn cut_short() -> AiError {
    AiError::new(
        ErrorKind::Network,
        "the connection closed before the reply was complete",
    )
}

/// An error a provider reported inside a stream: `http`, with `key`
/// redacted before the message is shortened.
pub fn provider_error(message: &str, key: Option<&str>) -> AiError {
    let detail = truncate(&redact(message, key), 300);
    let message = if detail.is_empty() {
        "the provider reported an error mid-stream".to_string()
    } else {
        format!("the provider reported an error: {detail}")
    };
    AiError::new(ErrorKind::Http, message)
}

/// Reads an SSE body into `state`, calling `emit` with the text of each
/// network chunk (all its events' text together; nothing for a chunk
/// without text). Stops at [`Flow::Done`] or the end of the body. Each
/// chunk may take at most `idle`.
pub async fn read(
    response: &mut reqwest::Response,
    idle: Duration,
    state: &mut impl StreamState,
    emit: &(dyn Fn(&str) + Send + Sync),
) -> Result<(), AiError> {
    let mut parser = SseParser::new();
    loop {
        let chunk = http::next_chunk(response, idle).await?;
        let (events, end) = match &chunk {
            Some(bytes) => (parser.push(bytes), false),
            None => (parser.finish(), true),
        };
        let mut done = false;
        for event in &events {
            if state.event(event)? == Flow::Done {
                done = true;
                break;
            }
        }
        let text = state.take_text();
        if !text.is_empty() {
            emit(&text);
        }
        if done || end {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_drops_leading_whitespace_and_trims() {
        let mut t = Text::default();
        t.push("  \n");
        assert_eq!(t.take(), "");
        assert!(t.is_empty());
        t.push(" hello");
        t.push(" world \n");
        assert_eq!(t.take(), "hello world \n");
        assert_eq!(t.finish(), "hello world");
    }

    #[test]
    fn provider_errors_are_redacted_then_truncated() {
        let key = "sk-0123456789abcdef";
        let message = format!("{}{key} bad", "x".repeat(295));
        let e = provider_error(&message, Some(key));
        assert_eq!(e.kind, ErrorKind::Http);
        assert!(!e.message.contains("sk-0123"), "{}", e.message);
    }
}
