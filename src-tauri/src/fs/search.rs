//! Text search under a directory (the explorer's "search in files"):
//! ripgrep's `grep-*` crates over the `ignore` walker, streaming results in
//! batches, plus the registry of running searches.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkFinish, SinkMatch};
use serde::{Deserialize, Serialize};

use super::find::walk;

/// Files larger than this are not searched.
pub const MAX_FILE_SIZE: u64 = 8 * 1024 * 1024;
/// Lines longer than this (in UTF-16 units) are cut to a window.
pub const MAX_LINE: usize = 300;
/// At most this many matches are recorded per line.
const MAX_RANGES: usize = 100;
/// How much of a long line is kept before its first match.
const CONTEXT_BEFORE: usize = 60;
/// A batch is sent once this many files have matches, or `FLUSH_INTERVAL` has passed.
pub const BATCH_FILES: usize = 100;
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(50);

/// As `TextSearchOptions` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchOptions {
    /// Literal unless `regex`.
    pub query: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub show_hidden: bool,
    /// Matching lines in total; the search stops after this many.
    pub max_results: usize,
}

/// As `TextMatch` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TextMatch {
    /// 1-based.
    pub line: u64,
    /// 1-based, in UTF-16 code units, of the first match in the full line.
    pub column: usize,
    /// The line without its newline, or a window of it (see [`MAX_LINE`]).
    pub text: String,
    /// `[start, end)` UTF-16 offsets into `text`.
    pub ranges: Vec<(usize, usize)>,
}

/// As `TextSearchFile` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TextSearchFile {
    /// Relative to the root, `/`-separated.
    pub path: String,
    pub matches: Vec<TextMatch>,
}

/// As `TextSearchEvent` in `src/ipc/fs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TextSearchEvent {
    /// A batch; each file is in exactly one batch with all its matches.
    Files { files: Vec<TextSearchFile> },
    Done { truncated: bool, cancelled: bool, files_searched: usize },
    /// The search could not start (invalid pattern, bad root). No `Done` follows.
    Error { message: String },
}

fn build_matcher(options: &TextSearchOptions) -> Result<RegexMatcher, String> {
    RegexMatcherBuilder::new()
        .case_insensitive(!options.case_sensitive)
        .word(options.whole_word)
        .fixed_strings(!options.regex)
        // Lets the regex engine search for whole lines and stops patterns
        // such as `\s` from matching across them.
        .line_terminator(Some(b'\n'))
        .build(&options.query)
        .map_err(|e| e.to_string())
}

/// Searches the text files under `root`, reporting through `emit`: any
/// number of `Files` batches, then `Done` (or a single `Error` and nothing
/// else). Walks sequentially in name order. Binary files (a NUL byte
/// anywhere) and files over [`MAX_FILE_SIZE`] are skipped. Stops once
/// `cancel` is set, or after `options.max_results` matching lines (the
/// last file's matches are cut there).
pub fn search_text(
    root: &Path,
    options: &TextSearchOptions,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(TextSearchEvent),
) {
    if options.query.is_empty() {
        return emit(TextSearchEvent::Done { truncated: false, cancelled: false, files_searched: 0 });
    }
    if !root.is_dir() {
        return emit(TextSearchEvent::Error { message: format!("{} is not a directory", root.display()) });
    }
    let matcher = match build_matcher(options) {
        Ok(matcher) => matcher,
        Err(message) => return emit(TextSearchEvent::Error { message }),
    };
    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\0'))
        .line_number(true)
        .build();

    let mut pending: Vec<TextSearchFile> = Vec::new();
    let mut last_flush = Instant::now();
    let mut remaining = options.max_results;
    let mut truncated = false;
    let mut files_searched = 0;
    let flush = |pending: &mut Vec<TextSearchFile>, emit: &mut dyn FnMut(TextSearchEvent)| {
        if !pending.is_empty() {
            emit(TextSearchEvent::Files { files: std::mem::take(pending) });
        }
    };

    for entry in walk(root, options.show_hidden) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Some(relative) = entry.path().strip_prefix(root).ok().and_then(Path::to_str) else {
            continue;
        };
        if entry.metadata().is_ok_and(|m| m.len() > MAX_FILE_SIZE) {
            continue;
        }
        let mut sink = FileSink { matcher: &matcher, cancel, budget: remaining, matches: Vec::new(), overflow: false };
        let result = searcher.search_path(&matcher, entry.path(), &mut sink);
        files_searched += 1;
        // An unreadable file is skipped, but what was found before the
        // failure is kept.
        let _ = result;
        if !sink.matches.is_empty() {
            remaining -= sink.matches.len();
            pending.push(TextSearchFile {
                path: relative.replace(std::path::MAIN_SEPARATOR, "/"),
                matches: sink.matches,
            });
        }
        if sink.overflow {
            truncated = true;
            break;
        }
        if pending.len() >= BATCH_FILES || (!pending.is_empty() && last_flush.elapsed() >= FLUSH_INTERVAL) {
            flush(&mut pending, emit);
            last_flush = Instant::now();
        }
    }
    flush(&mut pending, emit);
    emit(TextSearchEvent::Done { truncated, cancelled: cancel.load(Ordering::Relaxed), files_searched });
}

/// Collects one file's matching lines.
struct FileSink<'a> {
    matcher: &'a RegexMatcher,
    cancel: &'a AtomicBool,
    /// How many more matches may be kept.
    budget: usize,
    matches: Vec<TextMatch>,
    /// A match beyond the budget was found.
    overflow: bool,
}

impl Sink for FileSink<'_> {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
        if self.cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let line = String::from_utf8_lossy(mat.bytes());
        let line = line.strip_suffix('\n').unwrap_or(&line);
        let line = line.strip_suffix('\r').unwrap_or(line);
        // Matching again on the (lossy) text makes the offsets valid for it.
        let Some(found) = line_match(self.matcher, line) else {
            return Ok(true);
        };
        if self.matches.len() >= self.budget {
            self.overflow = true;
            return Ok(false);
        }
        self.matches.push(TextMatch { line: mat.line_number().unwrap_or(0), ..found });
        Ok(true)
    }

    fn finish(&mut self, _searcher: &Searcher, finish: &SinkFinish) -> Result<(), io::Error> {
        // A NUL byte was found: a binary file, whose matches are not wanted
        // (those before the NUL were already collected).
        if finish.binary_byte_offset().is_some() {
            self.matches.clear();
            self.overflow = false;
        }
        Ok(())
    }
}

/// The match record for `line` (no newline), or `None` if it has no
/// non-empty match. `line` of the result is left 0 for the caller.
fn line_match(matcher: &RegexMatcher, line: &str) -> Option<TextMatch> {
    let mut byte_ranges: Vec<(usize, usize)> = Vec::new();
    let _ = matcher.find_iter(line.as_bytes(), |m| {
        if m.start() < m.end() {
            byte_ranges.push((m.start(), m.end()));
        }
        byte_ranges.len() < MAX_RANGES
    });
    if byte_ranges.is_empty() {
        return None;
    }
    let units: Vec<u16> = line.encode_utf16().collect();
    let ranges = utf16_ranges(line, &byte_ranges);
    let first = ranges[0].0;
    let column = first + 1;
    if units.len() <= MAX_LINE {
        return Some(TextMatch { line: 0, column, text: line.to_string(), ranges });
    }

    // Cut a window around the first match, not through a surrogate pair.
    let mut start = first.saturating_sub(CONTEXT_BEFORE);
    if start > 0 && is_low_surrogate(units[start]) {
        start += 1;
    }
    let mut end = (start + MAX_LINE).min(units.len());
    if end < units.len() && is_low_surrogate(units[end]) {
        end -= 1;
    }
    let lead = usize::from(start > 0);
    let mut text = String::new();
    if start > 0 {
        text.push('…');
    }
    text.push_str(&String::from_utf16_lossy(&units[start..end]));
    if end < units.len() {
        text.push('…');
    }
    let ranges = ranges
        .into_iter()
        .filter(|&(s, _)| s < end)
        .map(|(s, e)| (s.max(start) - start + lead, e.min(end) - start + lead))
        .collect();
    Some(TextMatch { line: 0, column, text, ranges })
}

/// Converts ascending, non-overlapping byte ranges of `line` to UTF-16
/// ranges in one forward pass. A byte-oriented regex can match inside a
/// multibyte character; such a range grows to the whole character (a start
/// moves back, an end forward), and ranges that then overlap are merged.
fn utf16_ranges(line: &str, byte_ranges: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut starts = Utf16Cursor::new(line);
    let mut ends = Utf16Cursor::new(line);
    let mut ranges: Vec<(usize, usize)> = Vec::with_capacity(byte_ranges.len());
    for &(s, e) in byte_ranges {
        let (s, e) = (starts.advance_to(s, false), ends.advance_to(e, true));
        match ranges.last_mut() {
            Some(last) if s < last.1 => last.1 = last.1.max(e),
            _ => ranges.push((s, e)),
        }
    }
    ranges
}

/// A position in a string that only moves forward, tracking the UTF-16
/// offset of its byte offset (always a char boundary).
struct Utf16Cursor<'a> {
    line: &'a str,
    byte: usize,
    units: usize,
}

impl<'a> Utf16Cursor<'a> {
    fn new(line: &'a str) -> Self {
        Self { line, byte: 0, units: 0 }
    }

    /// Moves to `target` (not before the current position) and returns the
    /// UTF-16 offset there. A target inside a character stops before it, or
    /// after it if `round_up`.
    fn advance_to(&mut self, target: usize, round_up: bool) -> usize {
        while self.byte < target {
            let Some(c) = self.line[self.byte..].chars().next() else { break };
            let next = self.byte + c.len_utf8();
            if next > target && !round_up {
                break;
            }
            self.byte = next;
            self.units += c.len_utf16();
        }
        self.units
    }
}

fn is_low_surrogate(unit: u16) -> bool {
    (0xDC00..=0xDFFF).contains(&unit)
}

/// Running searches, each tagged with the window that started it so it can
/// be cancelled with the window's page, like watchers and PTYs.
#[derive(Default, Clone)]
pub struct SearchManager {
    registry: Arc<Mutex<Registry>>,
}

#[derive(Default)]
struct Registry {
    searches: HashMap<u32, Entry>,
    next_id: u32,
    /// Set by [`SearchManager::cancel_all`]; nothing may start afterwards.
    shut_down: bool,
}

struct Entry {
    owner: String,
    cancel: Arc<AtomicBool>,
}

impl SearchManager {
    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `job` on its own thread with a cancel flag, and returns the
    /// search's id (from 1, never reused within a run) at once. The search
    /// is forgotten when `job` returns.
    pub fn start(
        &self,
        owner: &str,
        job: impl FnOnce(Arc<AtomicBool>) + Send + 'static,
    ) -> Result<u32, String> {
        let cancel = Arc::new(AtomicBool::new(false));
        let id = {
            let mut registry = self.registry();
            if registry.shut_down {
                return Err("search manager is shut down".into());
            }
            registry.next_id += 1;
            let id = registry.next_id;
            registry.searches.insert(id, Entry { owner: owner.to_string(), cancel: Arc::clone(&cancel) });
            id
        };
        let manager = self.clone();
        let spawned = std::thread::Builder::new().name(format!("text-search-{id}")).spawn(move || {
            job(cancel);
            manager.registry().searches.remove(&id);
        });
        if let Err(e) = spawned {
            self.registry().searches.remove(&id);
            return Err(format!("cannot start search: {e}"));
        }
        Ok(id)
    }

    /// Asks a search to stop. Unknown ids (never started, or finished) are ignored.
    pub fn cancel(&self, id: u32) {
        if let Some(entry) = self.registry().searches.get(&id) {
            entry.cancel.store(true, Ordering::Relaxed);
        }
    }

    pub fn cancel_owned_by(&self, owner: &str) {
        for entry in self.registry().searches.values().filter(|e| e.owner == owner) {
            entry.cancel.store(true, Ordering::Relaxed);
        }
    }

    pub fn cancel_all(&self) {
        let mut registry = self.registry();
        registry.shut_down = true;
        for entry in registry.searches.values() {
            entry.cancel.store(true, Ordering::Relaxed);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.registry().searches.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc;

    fn options(query: &str) -> TextSearchOptions {
        TextSearchOptions {
            query: query.into(),
            regex: false,
            case_sensitive: false,
            whole_word: false,
            show_hidden: false,
            max_results: 1000,
        }
    }

    struct Outcome {
        files: Vec<TextSearchFile>,
        done: Option<(bool, bool, usize)>,
        error: Option<String>,
        batches: usize,
    }

    fn run_with(root: &Path, options: &TextSearchOptions, cancel: &AtomicBool) -> Outcome {
        let mut out = Outcome { files: vec![], done: None, error: None, batches: 0 };
        search_text(root, options, cancel, &mut |event| match event {
            TextSearchEvent::Files { files } => {
                out.batches += 1;
                out.files.extend(files);
            }
            TextSearchEvent::Done { truncated, cancelled, files_searched } => {
                assert!(out.done.is_none(), "two done events");
                out.done = Some((truncated, cancelled, files_searched));
            }
            TextSearchEvent::Error { message } => out.error = Some(message),
        });
        out
    }

    fn run(root: &Path, options: &TextSearchOptions) -> Outcome {
        run_with(root, options, &AtomicBool::new(false))
    }

    fn hits(out: &Outcome) -> Vec<(String, u64)> {
        out.files
            .iter()
            .flat_map(|f| f.matches.iter().map(|m| (f.path.clone(), m.line)))
            .collect()
    }

    fn tree(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (path, content) in files {
            let full = dir.path().join(path);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, content).unwrap();
        }
        dir
    }

    #[test]
    fn finds_literals_not_patterns() {
        let dir = tree(&[("a.txt", "one\na.c here\nabc\n"), ("sub/b.txt", "no\nxa.cx\n")]);
        let out = run(dir.path(), &options("a.c"));
        assert_eq!(hits(&out), vec![("a.txt".into(), 2), ("sub/b.txt".into(), 2)]);
        assert_eq!(out.done, Some((false, false, 2)));
        let m = &out.files[0].matches[0];
        assert_eq!((m.column, m.text.as_str(), m.ranges.clone()), (1, "a.c here", vec![(0, 3)]));
    }

    #[test]
    fn is_case_insensitive_unless_asked() {
        let dir = tree(&[("a.txt", "Hello\nhello\nHELLO\n")]);
        assert_eq!(hits(&run(dir.path(), &options("hello"))).len(), 3);
        let mut o = options("hello");
        o.case_sensitive = true;
        assert_eq!(hits(&run(dir.path(), &o)), vec![("a.txt".into(), 2)]);
    }

    #[test]
    fn whole_word() {
        let dir = tree(&[("a.txt", "cat\nconcat\ncat-food\ncats\n")]);
        let mut o = options("cat");
        o.whole_word = true;
        let lines: Vec<u64> = hits(&run(dir.path(), &o)).into_iter().map(|h| h.1).collect();
        assert_eq!(lines, vec![1, 3]);
    }

    #[test]
    fn regex_with_several_matches_per_line() {
        let dir = tree(&[("a.txt", "x1 y22 z\nnone\n")]);
        let mut o = options(r"\d+");
        o.regex = true;
        let out = run(dir.path(), &o);
        let m = &out.files[0].matches[0];
        assert_eq!(m.ranges, vec![(1, 2), (4, 6)]);
        assert_eq!(m.column, 2);
        // The same text is a literal without `regex`.
        assert!(run(dir.path(), &options(r"\d+")).files.is_empty());
    }

    #[test]
    fn regex_that_matches_the_empty_string_reports_only_real_matches() {
        let dir = tree(&[("a.txt", "aaa\nb\n")]);
        let mut o = options("a*");
        o.regex = true;
        assert_eq!(hits(&run(dir.path(), &o)), vec![("a.txt".into(), 1)]);
    }

    #[test]
    fn invalid_regex_is_an_error_without_done() {
        let dir = tree(&[("a.txt", "x\n")]);
        let mut o = options("(unclosed");
        o.regex = true;
        let out = run(dir.path(), &o);
        assert!(out.error.is_some());
        assert!(out.done.is_none());
        assert!(out.files.is_empty());
        // The same text is fine as a literal.
        assert!(run(dir.path(), &options("(unclosed")).error.is_none());
    }

    #[test]
    fn empty_query_and_missing_root() {
        let dir = tree(&[("a.txt", "x\n")]);
        let out = run(dir.path(), &options(""));
        assert_eq!(out.done, Some((false, false, 0)));
        assert!(out.files.is_empty());
        let out = run(Path::new("/definitely/not/here"), &options("x"));
        assert!(out.error.is_some() && out.done.is_none());
    }

    #[test]
    fn skips_binary_and_oversized_files() {
        let dir = tree(&[("text.txt", "needle\n"), ("bin.dat", "needle\n\0more needle\n"), ("late.dat", "needle")]);
        // A NUL after the first buffer's worth of matches must still discard the file.
        let mut late = "needle\n".repeat(20_000);
        late.push('\0');
        fs::write(dir.path().join("late.dat"), late).unwrap();
        let big = vec![b'a'; (MAX_FILE_SIZE + 1) as usize];
        let mut content = b"needle ".to_vec();
        content.extend(big);
        fs::write(dir.path().join("big.txt"), content).unwrap();
        let mut o = options("needle");
        o.max_results = 1_000_000;
        let out = run(dir.path(), &o);
        assert_eq!(hits(&out), vec![("text.txt".into(), 1)]);
    }

    #[test]
    fn hidden_and_ignored_handling() {
        let dir = tree(&[
            ("a.txt", "needle\n"),
            (".hidden/b.txt", "needle\n"),
            (".env", "needle\n"),
            ("build/c.txt", "needle\n"),
            (".git/config", "needle\n"),
            (".ignore", "build/\n"),
        ]);
        let out = run(dir.path(), &options("needle"));
        assert_eq!(hits(&out), vec![("a.txt".into(), 1)]);
        let mut o = options("needle");
        o.show_hidden = true;
        let paths: Vec<String> = run(dir.path(), &o).files.into_iter().map(|f| f.path).collect();
        assert_eq!(paths, vec![".env", ".hidden/b.txt", "a.txt", "build/c.txt"]);
    }

    #[test]
    fn stops_at_max_results() {
        let dir = tree(&[("a.txt", "x\nx\nx\n"), ("b.txt", "x\nx\n"), ("c.txt", "x\n")]);
        let mut o = options("x");
        o.max_results = 4;
        let out = run(dir.path(), &o);
        assert_eq!(hits(&out).len(), 4);
        assert_eq!(out.done.map(|d| d.0), Some(true));
        assert_eq!(out.files.len(), 2);
        // Exactly as many matches as the limit is not truncated.
        o.max_results = 6;
        let out = run(dir.path(), &o);
        assert_eq!(hits(&out).len(), 6);
        assert_eq!(out.done.map(|d| d.0), Some(false));
    }

    #[test]
    fn cancellation_stops_the_walk() {
        let dir = tree(&[("a.txt", "x\n"), ("b.txt", "x\n")]);
        let cancel = AtomicBool::new(true);
        let out = run_with(dir.path(), &options("x"), &cancel);
        assert!(out.files.is_empty());
        assert_eq!(out.done, Some((false, true, 0)));

        // Cancelled from the sink (as a UI would) after the first batch.
        let many: Vec<(String, &str)> = (0..300).map(|i| (format!("f{i:03}.txt"), "x\n")).collect();
        let refs: Vec<(&str, &str)> = many.iter().map(|(p, c)| (p.as_str(), *c)).collect();
        let dir = tree(&refs);
        let cancel = AtomicBool::new(false);
        let mut files = 0;
        let mut done = None;
        search_text(dir.path(), &options("x"), &cancel, &mut |event| match event {
            TextSearchEvent::Files { files: batch } => {
                files += batch.len();
                cancel.store(true, Ordering::Relaxed);
            }
            TextSearchEvent::Done { cancelled, .. } => done = Some(cancelled),
            TextSearchEvent::Error { .. } => unreachable!(),
        });
        assert!((BATCH_FILES..300).contains(&files), "{files}");
        assert_eq!(done, Some(true));
    }

    #[test]
    fn batches_files() {
        let many: Vec<(String, &str)> = (0..250).map(|i| (format!("f{i:03}.txt"), "x\n")).collect();
        let refs: Vec<(&str, &str)> = many.iter().map(|(p, c)| (p.as_str(), *c)).collect();
        let dir = tree(&refs);
        let out = run(dir.path(), &options("x"));
        assert_eq!(out.files.len(), 250);
        assert!(out.batches >= 3, "{}", out.batches);
        let mut seen: Vec<_> = out.files.iter().map(|f| f.path.clone()).collect();
        seen.dedup();
        assert_eq!(seen.len(), 250, "a file appeared in two batches");
    }

    #[test]
    fn utf16_offsets_with_non_ascii_text() {
        // "é" is 2 bytes / 1 unit; "😀" is 4 bytes / 2 units; "日本" 3 bytes / 1 unit each.
        let dir = tree(&[("a.txt", "é😀 日本 target and TARGET\n")]);
        let out = run(dir.path(), &options("target"));
        let m = &out.files[0].matches[0];
        let units: Vec<u16> = m.text.encode_utf16().collect();
        assert_eq!(m.ranges.len(), 2);
        for &(s, e) in &m.ranges {
            assert_eq!(String::from_utf16_lossy(&units[s..e]).to_lowercase(), "target");
        }
        assert_eq!(m.ranges[0], (7, 13));
        assert_eq!(m.column, 8);
    }

    #[test]
    fn invalid_utf8_lines_are_converted_lossily_with_correct_offsets() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"\xc0\xc1 needle\r\nplain\n").unwrap();
        let out = run(dir.path(), &options("needle"));
        let m = &out.files[0].matches[0];
        assert_eq!(m.text, "\u{fffd}\u{fffd} needle");
        assert_eq!(m.ranges, vec![(3, 9)]);
        assert_eq!(m.column, 4);
    }

    #[test]
    fn long_lines_are_cut_to_a_window() {
        let line = format!("{}needle{}needle{}\n", "é".repeat(500), "x".repeat(400), "y".repeat(10));
        let dir = tree(&[("a.txt", &line)]);
        let out = run(dir.path(), &options("needle"));
        let m = &out.files[0].matches[0];
        assert_eq!(m.column, 501);
        let units: Vec<u16> = m.text.encode_utf16().collect();
        assert!(units.len() <= MAX_LINE + 2, "{}", units.len());
        assert!(m.text.starts_with('…') && m.text.ends_with('…'));
        // The second match is far outside the window.
        assert_eq!(m.ranges.len(), 1);
        let (s, e) = m.ranges[0];
        assert_eq!(String::from_utf16_lossy(&units[s..e]), "needle");
        assert_eq!(s, 1 + CONTEXT_BEFORE);
    }

    #[test]
    fn long_line_windows_do_not_split_surrogate_pairs() {
        for pad in 0..4 {
            let line = format!("{}{}needle{}\n", "x".repeat(pad), "😀".repeat(200), "😀".repeat(200));
            let dir = tree(&[("a.txt", &line)]);
            let out = run(dir.path(), &options("needle"));
            let m = &out.files[0].matches[0];
            assert!(!m.text.contains('\u{fffd}'), "pad {pad}: {:?}", m.text);
            let units: Vec<u16> = m.text.encode_utf16().collect();
            let (s, e) = m.ranges[0];
            assert_eq!(String::from_utf16_lossy(&units[s..e]), "needle");
        }
    }

    #[test]
    fn a_line_at_the_limit_is_kept_whole() {
        let line = format!("needle{}\n", "x".repeat(MAX_LINE - 6));
        let dir = tree(&[("a.txt", &line)]);
        let m = &run(dir.path(), &options("needle")).files[0].matches[0];
        assert_eq!(m.text.encode_utf16().count(), MAX_LINE);
        assert!(!m.text.contains('…'));
    }

    #[test]
    fn a_match_inside_a_multibyte_character_does_not_panic() {
        // "é" is the bytes C3 A9; `\x80`-style byte classes match inside it.
        let dir = tree(&[("a.txt", "aé😀b\n")]);
        for pattern in [r"(?-u:\xA9)", r"(?-u:[\x80-\xBF])", r"(?-u:\xC3)"] {
            let mut o = options(pattern);
            o.regex = true;
            let out = run(dir.path(), &o);
            assert!(out.error.is_none(), "{pattern}: {:?}", out.error);
            let m = &out.files[0].matches[0];
            let units: Vec<u16> = m.text.encode_utf16().collect();
            for &(s, e) in &m.ranges {
                assert!(s < e && e <= units.len(), "{pattern}: {:?}", m.ranges);
            }
        }
        // The grown ranges cover whole characters: 'é' is unit 1, '😀' units 2..4.
        let mut o = options(r"(?-u:[\x80-\xBF])");
        o.regex = true;
        let m = &run(dir.path(), &o).files[0].matches[0];
        assert_eq!(m.ranges, vec![(1, 2), (2, 4)]);
        assert_eq!(m.column, 2);
    }

    #[test]
    fn utf16_ranges_round_outwards_and_merge() {
        // Bytes: a 0, é 1..3, 😀 3..7, b 7; UTF-16 units: 0, 1, 2..4, 4.
        let line = "aé😀b";
        assert_eq!(utf16_ranges(line, &[(0, 1), (1, 3), (3, 7), (7, 8)]), vec![(0, 1), (1, 2), (2, 4), (4, 5)]);
        // Two matches inside one character become one range.
        assert_eq!(utf16_ranges(line, &[(1, 2), (2, 3)]), vec![(1, 2)]);
        assert_eq!(utf16_ranges(line, &[(5, 6)]), vec![(2, 4)]);
    }

    #[test]
    fn many_matches_on_a_long_line_are_capped() {
        let line = format!("{}\n", "ab ".repeat(100_000));
        let dir = tree(&[("a.txt", &line)]);
        let m = &run(dir.path(), &options("ab")).files[0].matches[0];
        assert_eq!(m.ranges.len(), MAX_RANGES);
    }

    #[test]
    fn manager_ids_cancel_and_cleanup() {
        let manager = SearchManager::default();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let job = |tag: u8| {
            let started = started_tx.clone();
            let done = done_tx.clone();
            move |cancel: Arc<AtomicBool>| {
                started.send(()).unwrap();
                while !cancel.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                done.send(tag).unwrap();
            }
        };
        let a = manager.start("main", job(1)).unwrap();
        let b = manager.start("other", job(2)).unwrap();
        assert_eq!((a, b), (1, 2));
        started_rx.recv().unwrap();
        started_rx.recv().unwrap();
        manager.cancel(999);
        manager.cancel_owned_by("main");
        assert_eq!(done_rx.recv_timeout(Duration::from_secs(5)).unwrap(), 1);
        manager.cancel(b);
        assert_eq!(done_rx.recv_timeout(Duration::from_secs(5)).unwrap(), 2);
        let deadline = Instant::now() + Duration::from_secs(5);
        while manager.len() > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(manager.len(), 0);

        manager.cancel_all();
        assert!(manager.start("main", |_| {}).is_err());
    }
}
