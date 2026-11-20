//! A Server-Sent Events parser for streamed replies (no crate: the SSE
//! crates are stale or tied to an older reqwest).
//!
//! Bytes go in as they arrive from the network. Lines are split on `\n`
//! (a preceding `\r` is dropped) at the byte level, before decoding, so a
//! UTF-8 sequence or a CRLF may straddle chunks. `data:` lines of one event
//! are joined with `\n`; `:` lines are comments; a blank line ends an event.

/// One event: its `event:` name (`"message"` when absent) and its data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

#[derive(Default)]
pub struct SseParser {
    /// Bytes of an incomplete line.
    line: Vec<u8>,
    event: String,
    data: String,
    has_data: bool,
    /// Whether the first line was seen (a leading BOM is dropped).
    started: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds `bytes`; returns the events they complete.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        let mut events = Vec::new();
        let mut rest = bytes;
        while let Some(at) = rest.iter().position(|&b| b == b'\n') {
            self.line.extend_from_slice(&rest[..at]);
            rest = &rest[at + 1..];
            let mut line = std::mem::take(&mut self.line);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if let Some(event) = self.line_done(&line) {
                events.push(event);
            }
        }
        self.line.extend_from_slice(rest);
        events
    }

    /// The end of the stream: an unterminated last line and an event with
    /// no closing blank line still count.
    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        if !self.line.is_empty() {
            let mut line = std::mem::take(&mut self.line);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if let Some(event) = self.line_done(&line) {
                events.push(event);
            }
        }
        if let Some(event) = self.dispatch() {
            events.push(event);
        }
        events
    }

    fn line_done(&mut self, line: &[u8]) -> Option<SseEvent> {
        let mut line = line;
        if !self.started {
            self.started = true;
            line = line.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(line);
        }
        if line.is_empty() {
            return self.dispatch();
        }
        if line[0] == b':' {
            return None;
        }
        let line = String::from_utf8_lossy(line);
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line.as_ref(), ""),
        };
        match field {
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            "event" => self.event = value.to_string(),
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseEvent> {
        let event = std::mem::take(&mut self.event);
        let data = std::mem::take(&mut self.data);
        if !std::mem::take(&mut self.has_data) {
            return None;
        }
        Some(SseEvent {
            event: if event.is_empty() {
                "message".into()
            } else {
                event
            },
            data,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(event: &str, data: &str) -> SseEvent {
        SseEvent {
            event: event.into(),
            data: data.into(),
        }
    }

    fn parse_all(chunks: &[&[u8]]) -> Vec<SseEvent> {
        let mut parser = SseParser::new();
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(parser.push(chunk));
        }
        events.extend(parser.finish());
        events
    }

    const FIXTURE: &str = "\u{FEFF}: a comment\r\n\
        event: content_block_delta\r\n\
        data: {\"text\":\"h\u{e9}llo \u{1F600}\"}\r\n\
        \r\n\
        data: line one\n\
        data: line two\n\
        data:no-space\n\
        id: 7\n\
        retry: 100\n\
        \n\
        : keep-alive\n\
        \n\
        event: ping\n\
        \n\
        data: [DONE]";

    fn expected() -> Vec<SseEvent> {
        vec![
            ev("content_block_delta", "{\"text\":\"h\u{e9}llo \u{1F600}\"}"),
            ev("message", "line one\nline two\nno-space"),
            ev("message", "[DONE]"),
        ]
    }

    #[test]
    fn parses_a_fixture_in_one_piece() {
        assert_eq!(parse_all(&[FIXTURE.as_bytes()]), expected());
    }

    #[test]
    fn parses_a_fixture_split_at_every_byte_offset() {
        let bytes = FIXTURE.as_bytes();
        for at in 0..=bytes.len() {
            assert_eq!(
                parse_all(&[&bytes[..at], &bytes[at..]]),
                expected(),
                "split at {at}"
            );
        }
        // And one byte at a time.
        let singles: Vec<&[u8]> = bytes.chunks(1).collect();
        assert_eq!(parse_all(&singles), expected());
    }

    #[test]
    fn blank_lines_without_data_dispatch_nothing() {
        assert!(parse_all(&[b"\n\n\r\n: x\n\nevent: e\n\n"]).is_empty());
        // An empty data line is an event with empty data.
        assert_eq!(parse_all(&[b"data:\n\n"]), vec![ev("message", "")]);
        assert_eq!(parse_all(&[b"data\n\n"]), vec![ev("message", "")]);
    }

    #[test]
    fn finish_flushes_an_unterminated_event() {
        assert_eq!(parse_all(&[b"data: a\r\n"]), vec![ev("message", "a")]);
        assert_eq!(parse_all(&[b"data: a\r"]), vec![ev("message", "a")]);
        assert!(parse_all(&[b""]).is_empty());
    }
}
