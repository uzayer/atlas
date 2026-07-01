//! Build a structured side-by-side diff model (with word-level change spans)
//! from `git diff` unified output. Word-level spans + line pairing come from the
//! vendored delta `edits::infer_edits`.

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

use crate::parse::{self, RawKind};
use crate::vendor::edits::infer_edits;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Context,
    Added,
    Removed,
    Changed,
}

#[derive(Debug, Clone, Serialize)]
pub struct Segment {
    pub text: String,
    /// True for the word-level changed spans within a modified line.
    pub emph: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub line_no: u32,
    pub kind: LineKind,
    pub segments: Vec<Segment>,
}

/// One visual row of the side-by-side view. Either side may be `None` (a blank
/// filler cell opposite a pure add/remove).
#[derive(Debug, Clone, Serialize)]
pub struct Row {
    pub left: Option<Side>,
    pub right: Option<Side>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Stats {
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub language: String,
    pub is_binary: bool,
    pub rows: Vec<Row>,
    pub stats: Stats,
    /// Row indices that begin a contiguous run of changed rows — drives the
    /// "N differences" count and prev/next navigation in the UI.
    pub change_blocks: Vec<usize>,
}

/// Editor-gutter classification: NEW-file line numbers that are added or
/// modified, plus the new-file line numbers immediately following a deletion.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineStatus {
    pub added: Vec<u32>,
    pub changed: Vec<u32>,
    pub deleted_before: Vec<u32>,
}

/// Word-emphasis tag handed to `infer_edits` (its generic `EditOperation`).
#[derive(Debug, Clone, Copy, PartialEq)]
enum Emph {
    Noop,
    Changed,
}

fn token_re() -> &'static Regex {
    // delta's default `--word-diff-regex`.
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\w+").unwrap())
}

fn segments_from(annotated: &[(Emph, &str)]) -> Vec<Segment> {
    annotated
        .iter()
        .filter(|(_, s)| !s.is_empty())
        .map(|(op, s)| Segment {
            text: (*s).to_string(),
            emph: *op == Emph::Changed,
        })
        .collect()
}

/// Build the full side-by-side model for one file's unified diff.
pub fn build_file_diff(diff: &str, path: &str, language: &str) -> FileDiff {
    let parsed = parse::parse_unified(diff);
    if parsed.is_binary {
        return FileDiff {
            path: path.to_string(),
            language: language.to_string(),
            is_binary: true,
            rows: Vec::new(),
            stats: Stats::default(),
            change_blocks: Vec::new(),
        };
    }

    let mut rows: Vec<Row> = Vec::new();
    let mut stats = Stats::default();

    for hunk in &parsed.hunks {
        let mut old_ln = hunk.old_start;
        let mut new_ln = hunk.new_start;
        let lines = &hunk.lines;
        let mut i = 0;
        while i < lines.len() {
            match lines[i].kind {
                RawKind::Context => {
                    let text = lines[i].text.as_str();
                    rows.push(Row {
                        left: Some(Side {
                            line_no: old_ln,
                            kind: LineKind::Context,
                            segments: one_segment(text),
                        }),
                        right: Some(Side {
                            line_no: new_ln,
                            kind: LineKind::Context,
                            segments: one_segment(text),
                        }),
                    });
                    old_ln += 1;
                    new_ln += 1;
                    i += 1;
                }
                RawKind::Minus | RawKind::Plus => {
                    // Collect the contiguous change block (git groups all `-`
                    // lines then all `+` lines, but we tolerate any interleave).
                    let mut minus: Vec<&str> = Vec::new();
                    let mut plus: Vec<&str> = Vec::new();
                    while i < lines.len()
                        && matches!(lines[i].kind, RawKind::Minus | RawKind::Plus)
                    {
                        match lines[i].kind {
                            RawKind::Minus => minus.push(lines[i].text.as_str()),
                            RawKind::Plus => plus.push(lines[i].text.as_str()),
                            RawKind::Context => unreachable!(),
                        }
                        i += 1;
                    }
                    stats.deletions += minus.len();
                    stats.additions += plus.len();
                    build_block(&minus, &plus, &mut old_ln, &mut new_ln, &mut rows);
                }
            }
        }
    }

    let change_blocks = compute_change_blocks(&rows);
    FileDiff {
        path: path.to_string(),
        language: language.to_string(),
        is_binary: false,
        rows,
        stats,
        change_blocks,
    }
}

fn one_segment(text: &str) -> Vec<Segment> {
    if text.is_empty() {
        Vec::new()
    } else {
        vec![Segment {
            text: text.to_string(),
            emph: false,
        }]
    }
}

/// Pair a block of removed + added lines via `infer_edits` and emit aligned rows.
fn build_block(
    minus: &[&str],
    plus: &[&str],
    old_ln: &mut u32,
    new_ln: &mut u32,
    rows: &mut Vec<Row>,
) {
    let (amin, aplus, alignment) = infer_edits(
        minus.to_vec(),
        plus.to_vec(),
        vec![Emph::Noop; minus.len()],
        Emph::Changed,
        vec![Emph::Noop; plus.len()],
        Emph::Changed,
        token_re(),
        0.6, // delta default --max-line-distance
        0.0, // delta default naively-paired threshold
    );

    for (m, p) in alignment {
        let paired = m.is_some() && p.is_some();
        let left = m.map(|mi| {
            let ln = *old_ln;
            *old_ln += 1;
            Side {
                line_no: ln,
                kind: if paired {
                    LineKind::Changed
                } else {
                    LineKind::Removed
                },
                segments: segments_from(&amin[mi]),
            }
        });
        let right = p.map(|pi| {
            let ln = *new_ln;
            *new_ln += 1;
            Side {
                line_no: ln,
                kind: if paired {
                    LineKind::Changed
                } else {
                    LineKind::Added
                },
                segments: segments_from(&aplus[pi]),
            }
        });
        rows.push(Row { left, right });
    }
}

fn is_change_row(row: &Row) -> bool {
    !matches!(
        (&row.left, &row.right),
        (Some(l), Some(r)) if l.kind == LineKind::Context && r.kind == LineKind::Context
    )
}

fn compute_change_blocks(rows: &[Row]) -> Vec<usize> {
    let mut blocks = Vec::new();
    let mut prev = false;
    for (idx, row) in rows.iter().enumerate() {
        let now = is_change_row(row);
        if now && !prev {
            blocks.push(idx);
        }
        prev = now;
    }
    blocks
}

/// Derive editor-gutter line status from a built diff (new-file line numbers).
pub fn line_status(fd: &FileDiff) -> LineStatus {
    let mut out = LineStatus::default();
    let mut pending_delete = false;
    for row in &fd.rows {
        match &row.right {
            Some(r) if r.kind == LineKind::Added => {
                out.added.push(r.line_no);
                pending_delete = false;
            }
            Some(r) if r.kind == LineKind::Changed => {
                out.changed.push(r.line_no);
                pending_delete = false;
            }
            Some(r) => {
                // Context line: if a deletion ran just before it, flag this line
                // so the gutter can draw a "lines removed here" wedge above it.
                if pending_delete {
                    out.deleted_before.push(r.line_no);
                    pending_delete = false;
                }
            }
            None => {
                // Pure removal (left-only row) — remember it for the next
                // new-file line.
                if matches!(&row.left, Some(l) if l.kind == LineKind::Removed) {
                    pending_delete = true;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
diff --git a/foo.rs b/foo.rs
index 111..222 100644
--- a/foo.rs
+++ b/foo.rs
@@ -1,3 +1,3 @@
 fn main() {
-    let x = 1;
+    let x = 2;
 }
";

    #[test]
    fn modified_line_pairs_and_emphasizes() {
        let fd = build_file_diff(SAMPLE, "foo.rs", "rust");
        assert!(!fd.is_binary);
        assert_eq!(fd.stats.additions, 1);
        assert_eq!(fd.stats.deletions, 1);
        // context, changed, context
        assert_eq!(fd.rows.len(), 3);
        let changed = &fd.rows[1];
        let left = changed.left.as_ref().unwrap();
        let right = changed.right.as_ref().unwrap();
        assert_eq!(left.kind, LineKind::Changed);
        assert_eq!(right.kind, LineKind::Changed);
        assert_eq!(left.line_no, 2);
        assert_eq!(right.line_no, 2);
        // The "1" -> "2" word should be emphasized on each side.
        assert!(left.segments.iter().any(|s| s.emph && s.text.contains('1')));
        assert!(right.segments.iter().any(|s| s.emph && s.text.contains('2')));
        assert_eq!(fd.change_blocks, vec![1]);
    }

    #[test]
    fn pure_add_has_blank_left() {
        let diff = "\
diff --git a/n.txt b/n.txt
new file mode 100644
--- /dev/null
+++ b/n.txt
@@ -0,0 +1,2 @@
+alpha
+beta
";
        let fd = build_file_diff(diff, "n.txt", "text");
        assert_eq!(fd.stats.additions, 2);
        assert_eq!(fd.rows.len(), 2);
        assert!(fd.rows[0].left.is_none());
        assert_eq!(fd.rows[0].right.as_ref().unwrap().kind, LineKind::Added);
        let ls = line_status(&fd);
        assert_eq!(ls.added, vec![1, 2]);
    }

    #[test]
    fn binary_flagged() {
        let diff = "diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n";
        let fd = build_file_diff(diff, "x.png", "");
        assert!(fd.is_binary);
        assert!(fd.rows.is_empty());
    }
}
