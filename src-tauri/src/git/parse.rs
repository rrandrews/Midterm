//! Pure parsers for `git` CLI output (porcelain v2 status, unified diffs,
//! branch metadata, commit logs, commit file stats, and stashes).

use std::collections::HashMap;

use super::types::{
    ScmBranch, ScmChangeKind, ScmCommit, ScmCommitFile, ScmDiff, ScmDiffHunk, ScmDiffLine,
    ScmDiffLineKind, ScmFileChange, ScmRef, ScmRefKind, ScmStash,
};

pub const MAX_UNTRACKED_DIFF_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParsedStatus {
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<ScmFileChange>,
    pub unstaged: Vec<ScmFileChange>,
    pub untracked: Vec<ScmFileChange>,
    pub conflicted: Vec<ScmFileChange>,
}

fn change_kind_from_char(c: char) -> Option<ScmChangeKind> {
    match c {
        'M' => Some(ScmChangeKind::Modified),
        'A' => Some(ScmChangeKind::Added),
        'D' => Some(ScmChangeKind::Deleted),
        'R' => Some(ScmChangeKind::Renamed),
        'C' => Some(ScmChangeKind::Copied),
        'T' => Some(ScmChangeKind::TypeChanged),
        _ => None,
    }
}

/// Parses `git status --porcelain=v2 --branch -uall -z` output.
/// Only accepts complete NUL-terminated UTF-8 entries (non-UTF-8 entries are
/// skipped rather than lossily decoded into ambiguous mutation paths).
pub fn parse_porcelain_v2_z(raw: &[u8]) -> ParsedStatus {
    let mut out = ParsedStatus::default();
    if raw.is_empty() {
        return out;
    }
    // Every porcelain `-z` record ends with a NUL terminator; ignore any
    // unterminated trailing slice defensively.
    let complete = match raw.iter().rposition(|&b| b == 0) {
        Some(end) => &raw[..end],
        None => return out,
    };
    let tokens: Vec<&[u8]> = complete.split(|&b| b == 0).collect();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        i += 1;
        if tok.is_empty() {
            continue;
        }
        // Renames/copies (`2 `) consume a second NUL-terminated orig-path token
        // even when we skip the entry due to non-UTF-8 bytes.
        let is_rename = tok.starts_with(b"2 ");
        let orig_tok = if is_rename {
            if i < tokens.len() {
                let t = tokens[i];
                i += 1;
                Some(t)
            } else {
                None
            }
        } else {
            None
        };

        let Ok(line) = std::str::from_utf8(tok) else {
            continue;
        };

        if let Some(rest) = line.strip_prefix("# ") {
            if let Some(oid) = rest.strip_prefix("branch.oid ") {
                let oid = oid.trim();
                out.head_oid = if oid == "(initial)" || oid.is_empty() {
                    None
                } else {
                    Some(oid.to_string())
                };
            } else if let Some(head) = rest.strip_prefix("branch.head ") {
                let head = head.trim();
                out.branch = if head == "(detached)" || head.is_empty() {
                    None
                } else {
                    Some(head.to_string())
                };
            } else if let Some(up) = rest.strip_prefix("branch.upstream ") {
                let up = up.trim();
                out.upstream = if up.is_empty() {
                    None
                } else {
                    Some(up.to_string())
                };
            } else if let Some(ab) = rest.strip_prefix("branch.ab ") {
                for part in ab.split_whitespace() {
                    if let Some(n) = part.strip_prefix('+') {
                        out.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix('-') {
                        out.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }

        if let Some(path) = line.strip_prefix("? ") {
            out.untracked.push(ScmFileChange {
                path: path.to_string(),
                orig_path: None,
                status: ScmChangeKind::Untracked,
                conflict_code: None,
            });
            continue;
        }

        if line.starts_with("1 ") {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            let parts: Vec<&str> = line.splitn(9, ' ').collect();
            if parts.len() == 9 {
                let xy: Vec<char> = parts[1].chars().collect();
                let path = parts[8].to_string();
                if xy.len() == 2 {
                    if let Some(st) = change_kind_from_char(xy[0]) {
                        out.staged.push(ScmFileChange {
                            path: path.clone(),
                            orig_path: None,
                            status: st,
                            conflict_code: None,
                        });
                    }
                    if let Some(st) = change_kind_from_char(xy[1]) {
                        out.unstaged.push(ScmFileChange {
                            path,
                            orig_path: None,
                            status: st,
                            conflict_code: None,
                        });
                    }
                }
            }
            continue;
        }

        if is_rename {
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
            let orig_path = match orig_tok.and_then(|t| std::str::from_utf8(t).ok()) {
                Some(s) => Some(s.to_string()),
                None => continue,
            };
            let parts: Vec<&str> = line.splitn(10, ' ').collect();
            if parts.len() == 10 {
                let xy: Vec<char> = parts[1].chars().collect();
                let path = parts[9].to_string();
                if xy.len() == 2 {
                    if let Some(st) = change_kind_from_char(xy[0]) {
                        out.staged.push(ScmFileChange {
                            path: path.clone(),
                            orig_path,
                            status: st,
                            conflict_code: None,
                        });
                    }
                    if let Some(st) = change_kind_from_char(xy[1]) {
                        out.unstaged.push(ScmFileChange {
                            path,
                            orig_path: None,
                            status: st,
                            conflict_code: None,
                        });
                    }
                }
            }
            continue;
        }

        if line.starts_with("u ") {
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            let parts: Vec<&str> = line.splitn(11, ' ').collect();
            if parts.len() == 11 {
                out.conflicted.push(ScmFileChange {
                    path: parts[10].to_string(),
                    orig_path: None,
                    status: ScmChangeKind::Conflicted,
                    conflict_code: Some(parts[1].to_string()),
                });
            }
        }
    }
    out
}

fn parse_hunk_range(token: &str) -> Option<(u32, u32)> {
    let body = token.strip_prefix('-').or_else(|| token.strip_prefix('+'))?;
    if let Some((start, count)) = body.split_once(',') {
        Some((start.parse().ok()?, count.parse().ok()?))
    } else {
        Some((body.parse().ok()?, 1))
    }
}

fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = line.strip_prefix("@@ ")?;
    let end = rest.find(" @@")?;
    let ranges = &rest[..end];
    let mut parts = ranges.split_whitespace();
    let old = parse_hunk_range(parts.next()?)?;
    let new = parse_hunk_range(parts.next()?)?;
    Some((old.0, old.1, new.0, new.1))
}

/// Maximum total lines emitted in a single `ScmDiff` IPC response so files
/// packed with newlines cannot blow up JSON serialization.
pub const MAX_DIFF_LINES: usize = 10_000;

/// Decodes Git's C-quoted path spelling (used in `rename from` even when
/// `core.quotepath=false` for tabs, newlines, backslashes, and quotes).
pub(crate) fn unquote_git_path(raw: &str) -> String {
    let Some(inner) = raw.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else {
        return raw.to_string();
    };
    let bytes = inner.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 1;
            match bytes[i] {
                b'\\' => out.push(b'\\'),
                b'"' => out.push(b'"'),
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b't' => out.push(b'\t'),
                b'a' => out.push(0x07),
                b'b' => out.push(0x08),
                b'f' => out.push(0x0c),
                b'v' => out.push(0x0b),
                b'0'..=b'7' => {
                    let mut val: u16 = 0;
                    let mut digits = 0;
                    while i < bytes.len() && digits < 3 && (b'0'..=b'7').contains(&bytes[i]) {
                        val = val * 8 + u16::from(bytes[i] - b'0');
                        i += 1;
                        digits += 1;
                    }
                    out.push((val & 0xff) as u8);
                    continue;
                }
                other => out.push(other),
            }
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses unified diff output from `git diff` / `git show`.
/// Preserves `\r` inside hunk content lines so CRLF-vs-LF diffs stay faithful
/// and reconstructed hunk patches apply cleanly to CRLF files.
pub fn parse_unified_diff(path: &str, raw: &[u8], truncated: bool) -> ScmDiff {
    let non_utf8 = std::str::from_utf8(raw).is_err();
    let text = String::from_utf8_lossy(raw);
    let mut diff = ScmDiff {
        path: path.to_string(),
        old_path: None,
        binary: false,
        too_large: truncated,
        non_utf8,
        type_changed: false,
        patchable: false,
        is_new: false,
        is_deleted: false,
        hunks: Vec::new(),
    };

    let mut current: Option<ScmDiffHunk> = None;
    let mut old_line: u32 = 0;
    let mut new_line: u32 = 0;
    let mut seen_sections: usize = 0;
    let mut total_lines: usize = 0;

    for raw_line in text.split('\n') {
        let meta_line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if meta_line.starts_with("diff --git ") {
            if let Some(finished) = current.take() {
                diff.hunks.push(finished);
            }
            seen_sections += 1;
            if seen_sections > 1 {
                // File-type change (e.g. regular file <-> symlink): Git emits
                // a delete section followed by a new-file section for the same path.
                diff.type_changed = true;
                diff.is_new = false;
                diff.is_deleted = false;
            }
            continue;
        }

        if current.is_none() {
            if meta_line.starts_with("Binary files ") || meta_line == "GIT binary patch" {
                diff.binary = true;
                diff.hunks.clear();
                diff.patchable = false;
                return diff;
            }
            if !diff.type_changed && meta_line.starts_with("new file mode ") {
                diff.is_new = true;
                continue;
            }
            if !diff.type_changed && meta_line.starts_with("deleted file mode ") {
                diff.is_deleted = true;
                continue;
            }
            if let Some(old) = meta_line.strip_prefix("rename from ") {
                diff.old_path = Some(unquote_git_path(old));
                continue;
            }
            if let Some((os, ol, ns, nl)) = parse_hunk_header(meta_line) {
                old_line = os;
                new_line = ns;
                current = Some(ScmDiffHunk {
                    header: meta_line.to_string(),
                    old_start: os,
                    old_lines: ol,
                    new_start: ns,
                    new_lines: nl,
                    lines: Vec::new(),
                });
            }
            continue;
        }

        if let Some((os, ol, ns, nl)) = parse_hunk_header(meta_line) {
            if let Some(finished) = current.take() {
                diff.hunks.push(finished);
            }
            old_line = os;
            new_line = ns;
            current = Some(ScmDiffHunk {
                header: meta_line.to_string(),
                old_start: os,
                old_lines: ol,
                new_start: ns,
                new_lines: nl,
                lines: Vec::new(),
            });
            continue;
        }

        let Some(hunk) = current.as_mut() else {
            continue;
        };

        if meta_line == "\\ No newline at end of file" {
            if let Some(last) = hunk.lines.last_mut() {
                last.no_newline = true;
            }
            continue;
        }

        if total_lines >= MAX_DIFF_LINES {
            diff.too_large = true;
            break;
        }

        // Preserve exact line payload (including any trailing `\r` for CRLF files).
        let mut chars = raw_line.chars();
        match chars.next() {
            Some('+') => {
                hunk.lines.push(ScmDiffLine {
                    kind: ScmDiffLineKind::Add,
                    content: chars.as_str().to_string(),
                    old_line: None,
                    new_line: Some(new_line),
                    no_newline: false,
                });
                new_line = new_line.saturating_add(1);
                total_lines += 1;
            }
            Some('-') => {
                hunk.lines.push(ScmDiffLine {
                    kind: ScmDiffLineKind::Del,
                    content: chars.as_str().to_string(),
                    old_line: Some(old_line),
                    new_line: None,
                    no_newline: false,
                });
                old_line = old_line.saturating_add(1);
                total_lines += 1;
            }
            Some(' ') => {
                hunk.lines.push(ScmDiffLine {
                    kind: ScmDiffLineKind::Context,
                    content: chars.as_str().to_string(),
                    old_line: Some(old_line),
                    new_line: Some(new_line),
                    no_newline: false,
                });
                old_line = old_line.saturating_add(1);
                new_line = new_line.saturating_add(1);
                total_lines += 1;
            }
            _ => {}
        }
    }

    if let Some(finished) = current {
        diff.hunks.push(finished);
    }

    diff.patchable = !diff.binary && !diff.too_large && !diff.non_utf8 && !diff.type_changed;
    diff
}

/// Builds an all-added diff for an untracked file from its raw bytes.
pub fn synthesize_untracked_diff(path: &str, bytes: &[u8]) -> ScmDiff {
    if bytes.len() > MAX_UNTRACKED_DIFF_BYTES {
        return ScmDiff {
            path: path.to_string(),
            old_path: None,
            binary: false,
            too_large: true,
            non_utf8: false,
            type_changed: false,
            patchable: false,
            is_new: true,
            is_deleted: false,
            hunks: Vec::new(),
        };
    }
    let probe = &bytes[..bytes.len().min(8192)];
    if probe.contains(&0) {
        return ScmDiff {
            path: path.to_string(),
            old_path: None,
            binary: true,
            too_large: false,
            non_utf8: false,
            type_changed: false,
            patchable: false,
            is_new: true,
            is_deleted: false,
            hunks: Vec::new(),
        };
    }
    if bytes.is_empty() {
        return ScmDiff {
            path: path.to_string(),
            old_path: None,
            binary: false,
            too_large: false,
            non_utf8: false,
            type_changed: false,
            patchable: true,
            is_new: true,
            is_deleted: false,
            hunks: Vec::new(),
        };
    }
    // Check line budget before allocating per-line structs.
    let newline_count = bytes.iter().filter(|&&b| b == b'\n').count();
    let est_lines = if bytes.ends_with(b"\n") {
        newline_count
    } else {
        newline_count + 1
    };
    if est_lines > MAX_DIFF_LINES {
        return ScmDiff {
            path: path.to_string(),
            old_path: None,
            binary: false,
            too_large: true,
            non_utf8: false,
            type_changed: false,
            patchable: false,
            is_new: true,
            is_deleted: false,
            hunks: Vec::new(),
        };
    }
    let non_utf8 = std::str::from_utf8(bytes).is_err();
    let text = String::from_utf8_lossy(bytes);
    let ends_with_newline = text.ends_with('\n');
    let raw_lines: Vec<&str> = if ends_with_newline {
        text[..text.len() - 1].split('\n').collect()
    } else {
        text.split('\n').collect()
    };
    let count = raw_lines.len() as u32;
    let mut lines = Vec::with_capacity(raw_lines.len());
    for (idx, line) in raw_lines.iter().enumerate() {
        lines.push(ScmDiffLine {
            kind: ScmDiffLineKind::Add,
            content: (*line).to_string(),
            old_line: None,
            new_line: Some((idx + 1) as u32),
            no_newline: !ends_with_newline && idx + 1 == raw_lines.len(),
        });
    }
    ScmDiff {
        path: path.to_string(),
        old_path: None,
        binary: false,
        too_large: false,
        non_utf8,
        type_changed: false,
        patchable: !non_utf8,
        is_new: true,
        is_deleted: false,
        hunks: vec![ScmDiffHunk {
            header: format!("@@ -0,0 +1,{count} @@"),
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: count,
            lines,
        }],
    }
}

fn parse_track_counts(track: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    for segment in inner.split(',') {
        let seg = segment.trim();
        if let Some(n) = seg.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = seg.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

/// Parses NUL-delimited `git for-each-ref` output (8 fields per branch, each
/// terminated by `\0`; git adds a trailing newline after each record).
/// Format: `%(HEAD)%00%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)%00%(subject)%00%(committerdate:unix)%00`
pub fn parse_branches_z(raw: &[u8]) -> Vec<ScmBranch> {
    let mut branches = Vec::new();
    let fields: Vec<&[u8]> = raw.split(|&b| b == 0).collect();
    let mut i = 0;
    while i + 7 < fields.len() {
        let head = String::from_utf8_lossy(fields[i]);
        let full_ref = String::from_utf8_lossy(fields[i + 1]);
        let short_name = String::from_utf8_lossy(fields[i + 2]);
        let upstream_raw = String::from_utf8_lossy(fields[i + 3]);
        let track = String::from_utf8_lossy(fields[i + 4]);
        let commit_hash = String::from_utf8_lossy(fields[i + 5]);
        let commit_subject = String::from_utf8_lossy(fields[i + 6]);
        let commit_date_raw = String::from_utf8_lossy(fields[i + 7]);
        i += 8;

        if full_ref.is_empty() {
            continue;
        }
        if full_ref.starts_with("refs/remotes/") && full_ref.ends_with("/HEAD") {
            continue;
        }
        let current = head.trim() == "*";
        let remote = full_ref
            .strip_prefix("refs/remotes/")
            .and_then(|rest| rest.split_once('/').map(|(r, _)| r.to_string()));
        let upstream = if upstream_raw.is_empty() {
            None
        } else {
            Some(upstream_raw.into_owned())
        };
        let (ahead, behind) = parse_track_counts(&track);
        let commit_date = commit_date_raw.trim().parse::<i64>().unwrap_or(0);
        // Derive the actionable branch name from the full ref so a tag sharing
        // the same name never turns `main` into `heads/main`.
        let name = full_ref
            .strip_prefix("refs/heads/")
            .or_else(|| full_ref.strip_prefix("refs/remotes/"))
            .unwrap_or(&short_name)
            .to_string();
        branches.push(ScmBranch {
            name,
            current,
            remote,
            upstream,
            ahead,
            behind,
            commit_hash: commit_hash.into_owned(),
            commit_subject: commit_subject.into_owned(),
            commit_date,
        });
    }
    branches
}

/// Parses `--decorate=full` `%D` decorations using explicit ref namespaces so
/// local branches containing `/` (e.g. `feature/login`) are never mistaken for remotes.
fn parse_full_decorations(raw: &str) -> Vec<ScmRef> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut refs = Vec::new();
    for part in trimmed.split(", ") {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some(target) = part.strip_prefix("HEAD -> ") {
            let short = target.strip_prefix("refs/heads/").unwrap_or(target);
            refs.push(ScmRef {
                kind: ScmRefKind::Head,
                name: short.to_string(),
            });
        } else if part == "HEAD" {
            refs.push(ScmRef {
                kind: ScmRefKind::Head,
                name: "HEAD".to_string(),
            });
        } else if let Some(tag) = part.strip_prefix("tag: ") {
            let short = tag.strip_prefix("refs/tags/").unwrap_or(tag);
            refs.push(ScmRef {
                kind: ScmRefKind::Tag,
                name: short.to_string(),
            });
        } else if let Some(local) = part.strip_prefix("refs/heads/") {
            refs.push(ScmRef {
                kind: ScmRefKind::Branch,
                name: local.to_string(),
            });
        } else if let Some(remote) = part.strip_prefix("refs/remotes/") {
            if remote.ends_with("/HEAD") {
                continue;
            }
            refs.push(ScmRef {
                kind: ScmRefKind::Remote,
                name: remote.to_string(),
            });
        } else if let Some(tag) = part.strip_prefix("refs/tags/") {
            refs.push(ScmRef {
                kind: ScmRefKind::Tag,
                name: tag.to_string(),
            });
        }
    }
    refs
}

/// Parses NUL-delimited `git log --decorate=full` formatted with:
/// `%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b%x00%D%x00`
pub fn parse_log_z(raw: &[u8]) -> Vec<ScmCommit> {
    let mut commits = Vec::new();
    let fields: Vec<&[u8]> = raw.split(|&b| b == 0).collect();
    let mut i = 0;
    while i + 8 < fields.len() {
        let hash = String::from_utf8_lossy(fields[i]).trim().to_string();
        let short_hash = String::from_utf8_lossy(fields[i + 1]).trim().to_string();
        let parents_raw = String::from_utf8_lossy(fields[i + 2]);
        let author = String::from_utf8_lossy(fields[i + 3]).into_owned();
        let email = String::from_utf8_lossy(fields[i + 4]).into_owned();
        let date = String::from_utf8_lossy(fields[i + 5])
            .trim()
            .parse::<i64>()
            .unwrap_or(0);
        let subject = String::from_utf8_lossy(fields[i + 6]).into_owned();
        let body = String::from_utf8_lossy(fields[i + 7]).trim().to_string();
        let dec = String::from_utf8_lossy(fields[i + 8]);
        i += 9;

        if hash.is_empty() {
            continue;
        }
        let parents = parents_raw.split_whitespace().map(str::to_string).collect();
        commits.push(ScmCommit {
            hash,
            short_hash,
            parents,
            author,
            email,
            date,
            subject,
            body,
            refs: parse_full_decorations(&dec),
        });
    }
    commits
}

/// Parses combined `git show --format= --name-status -z -M` and `--numstat -z -M`.
pub fn parse_commit_files(namestatus_z: &[u8], numstat_z: &[u8]) -> Vec<ScmCommitFile> {
    let mut stats: HashMap<String, (Option<u32>, Option<u32>, bool)> = HashMap::new();
    let ns_tokens: Vec<&[u8]> = numstat_z.split(|&b| b == 0).collect();
    let mut idx = 0;
    while idx < ns_tokens.len() {
        let tok = ns_tokens[idx];
        idx += 1;
        if tok.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(tok);
        let parts: Vec<&str> = text.splitn(3, '\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let binary = parts[0] == "-" || parts[1] == "-";
        let additions = if binary { None } else { parts[0].parse().ok() };
        let deletions = if binary { None } else { parts[1].parse().ok() };
        let path = if parts[2].is_empty() {
            if idx + 1 < ns_tokens.len() {
                let new_path = String::from_utf8_lossy(ns_tokens[idx + 1]).into_owned();
                idx += 2;
                new_path
            } else {
                continue;
            }
        } else {
            parts[2].to_string()
        };
        stats.insert(path, (additions, deletions, binary));
    }

    let mut files = Vec::new();
    let st_tokens: Vec<&[u8]> = namestatus_z.split(|&b| b == 0).collect();
    let mut i = 0;
    while i < st_tokens.len() {
        let code_tok = st_tokens[i];
        i += 1;
        if code_tok.is_empty() {
            continue;
        }
        let code_str = String::from_utf8_lossy(code_tok);
        let first = code_str.chars().next().unwrap_or('M');
        let status = change_kind_from_char(first).unwrap_or(ScmChangeKind::Modified);
        let (path, orig_path) = if matches!(first, 'R' | 'C') {
            if i + 1 >= st_tokens.len() {
                break;
            }
            let Ok(old) = std::str::from_utf8(st_tokens[i]) else {
                i += 2;
                continue;
            };
            let Ok(new) = std::str::from_utf8(st_tokens[i + 1]) else {
                i += 2;
                continue;
            };
            i += 2;
            (new.to_string(), Some(old.to_string()))
        } else {
            if i >= st_tokens.len() {
                break;
            }
            let Ok(p) = std::str::from_utf8(st_tokens[i]) else {
                i += 1;
                continue;
            };
            i += 1;
            (p.to_string(), None)
        };
        let (additions, deletions, binary) = stats.get(&path).copied().unwrap_or((None, None, false));
        files.push(ScmCommitFile {
            path,
            orig_path,
            status,
            additions,
            deletions,
            binary,
        });
    }
    files
}

/// Parses NUL-delimited `git stash list --format=%gd%x00%at%x00%gs%x00`.
pub fn parse_stashes_z(raw: &[u8]) -> Vec<ScmStash> {
    let mut stashes = Vec::new();
    let fields: Vec<&[u8]> = raw.split(|&b| b == 0).collect();
    let mut i = 0;
    let mut fallback_idx = 0;
    while i + 2 < fields.len() {
        let reference = String::from_utf8_lossy(fields[i]).trim().to_string();
        let date = String::from_utf8_lossy(fields[i + 1])
            .trim()
            .parse::<i64>()
            .unwrap_or(0);
        let raw_msg = String::from_utf8_lossy(fields[i + 2]).trim().to_string();
        i += 3;

        if reference.is_empty() {
            continue;
        }
        let index = reference
            .strip_prefix("stash@{")
            .and_then(|s| s.strip_suffix('}'))
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(fallback_idx);
        fallback_idx += 1;
        let (branch, message) = if let Some(rest) = raw_msg
            .strip_prefix("WIP on ")
            .or_else(|| raw_msg.strip_prefix("On "))
        {
            if let Some((b, m)) = rest.split_once(": ") {
                (Some(b.to_string()), m.to_string())
            } else {
                (None, raw_msg)
            }
        } else {
            (None, raw_msg)
        };
        stashes.push(ScmStash {
            index,
            reference,
            branch,
            message,
            date,
        });
    }
    stashes
}
