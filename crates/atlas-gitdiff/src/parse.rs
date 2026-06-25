//! Minimal unified-diff parser: turns `git diff` text into hunks of classified
//! lines. Just enough to feed the side-by-side engine — header lines (diff
//! --git, index, ---/+++, rename/mode) are skipped; binary diffs are flagged.

use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawKind {
    Context,
    Minus,
    Plus,
}

#[derive(Debug, Clone)]
pub struct RawLine {
    pub kind: RawKind,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct Hunk {
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<RawLine>,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedDiff {
    pub is_binary: bool,
    pub hunks: Vec<Hunk>,
}

fn hunk_header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@").unwrap())
}

/// Parse `git diff` (single- or multi-file) unified output into hunks. Lines
/// before the first `@@` (file headers) are ignored.
pub fn parse_unified(diff: &str) -> ParsedDiff {
    let mut out = ParsedDiff::default();
    let mut cur: Option<Hunk> = None;

    for line in diff.lines() {
        if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            out.is_binary = true;
            continue;
        }
        if let Some(caps) = hunk_header_re().captures(line) {
            if let Some(h) = cur.take() {
                out.hunks.push(h);
            }
            let old_start = caps[1].parse().unwrap_or(0);
            let new_start = caps[2].parse().unwrap_or(0);
            cur = Some(Hunk {
                old_start,
                new_start,
                lines: Vec::new(),
            });
            continue;
        }
        let Some(hunk) = cur.as_mut() else {
            // Still in the file header preamble (diff --git / index / --- / +++ /
            // rename / new file …) — nothing to collect until the first hunk.
            continue;
        };
        // "\ No newline at end of file" markers carry no content.
        if line.starts_with('\\') {
            continue;
        }
        let (kind, rest) = match line.as_bytes().first() {
            Some(b'+') => (RawKind::Plus, &line[1..]),
            Some(b'-') => (RawKind::Minus, &line[1..]),
            Some(b' ') => (RawKind::Context, &line[1..]),
            // A truly empty line inside a hunk = a blank context line.
            None => (RawKind::Context, ""),
            _ => continue,
        };
        hunk.lines.push(RawLine {
            kind,
            text: rest.to_string(),
        });
    }
    if let Some(h) = cur.take() {
        out.hunks.push(h);
    }
    out
}
