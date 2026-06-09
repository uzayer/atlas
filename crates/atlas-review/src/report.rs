//! Multi-file review report types — the CodeRabbit-style output.
//!
//! A report is assembled from N per-file verdicts (one Cersei agent each) plus a
//! synthesis pass that produces the overall summary and a mandatory Mermaid
//! architecture diagram. All structs are `snake_case` to match the model's JSON
//! (see [`crate::verdict`]).

use serde::{Deserialize, Serialize};

use crate::verdict::{extract_json, KeyIssue};

/// Per-file review verdict.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileVerdict {
    /// Repo-relative path of the reviewed file.
    #[serde(default)]
    pub path: String,
    /// One-or-two-sentence summary of what changed in this file.
    #[serde(default)]
    pub summary: String,
    /// "low" | "medium" | "high" — review risk this file introduces.
    #[serde(default = "low")]
    pub risk: String,
    /// Issues flagged in this file.
    #[serde(default)]
    pub key_issues: Vec<KeyIssue>,
    /// Optional per-file quality score 0-100.
    #[serde(default)]
    pub score: Option<u8>,
}

fn low() -> String {
    "low".to_string()
}

/// What the synthesis agent returns (overall fields + the diagram).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SynthesisOut {
    #[serde(default)]
    pub summary: String,
    /// Mermaid source for the architecture diagram (no fences).
    #[serde(default, alias = "mermaid", alias = "architecture")]
    pub architecture_mermaid: String,
    #[serde(default)]
    pub score: Option<u8>,
    #[serde(
        default,
        alias = "estimated_effort_to_review",
        alias = "estimated_effort_to_review_[1-5]"
    )]
    pub estimated_effort_to_review: Option<u8>,
    #[serde(default = "no_concern")]
    pub security_concerns: String,
    #[serde(default = "no")]
    pub relevant_tests: String,
}

fn no() -> String {
    "no".to_string()
}
fn no_concern() -> String {
    "No".to_string()
}

/// The complete review report rendered by the UI and persisted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewReport {
    pub summary: String,
    /// Mermaid architecture diagram source (may be empty if the model refused).
    pub architecture_mermaid: String,
    pub score: Option<u8>,
    pub estimated_effort_to_review: Option<u8>,
    pub security_concerns: String,
    pub relevant_tests: String,
    /// Per-file verdicts, in the diff's file order.
    pub files: Vec<FileVerdict>,
    /// Files changed on the branch but skipped (over the review cap).
    pub not_reviewed: Vec<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: Option<f64>,
}

/// Parse a per-file verdict from model output, defaulting `path` to the file
/// under review (the model may omit or mangle it).
pub fn parse_file_verdict(text: &str, path: &str) -> FileVerdict {
    let mut v: FileVerdict = extract_json(text).unwrap_or_else(|| FileVerdict {
        path: path.to_string(),
        summary: first_line(text),
        risk: low(),
        key_issues: Vec::new(),
        score: None,
    });
    if v.path.trim().is_empty() {
        v.path = path.to_string();
    }
    v
}

/// Parse the synthesis output; falls back to using the raw text as the summary.
pub fn parse_synthesis(text: &str) -> SynthesisOut {
    extract_json(text).unwrap_or_else(|| SynthesisOut {
        summary: text.trim().to_string(),
        architecture_mermaid: String::new(),
        score: None,
        estimated_effort_to_review: None,
        security_concerns: no_concern(),
        relevant_tests: no(),
    })
}

fn first_line(text: &str) -> String {
    text.trim().lines().next().unwrap_or("").to_string()
}
