//! Typed structured review output, modeled on PR-Agent's `Review` schema
//! (`pr_agent/settings/pr_reviewer_prompts.toml`).
//!
//! The agent is instructed to emit a single fenced ```json block matching
//! [`ReviewVerdict`]. [`parse`] extracts it tolerantly: a fenced block first,
//! then a best-effort outermost-brace match, so a model that wraps the JSON in
//! prose still yields a verdict. On total failure the caller falls back to
//! rendering the raw streamed markdown.

use serde::{Deserialize, Serialize};

/// One discrete, actionable issue the reviewer flagged.
///
/// Fields stay `snake_case` (no rename): this struct is deserialized directly
/// from the model's JSON, which uses the snake_case PR-Agent schema. The
/// frontend reads these same snake_case keys.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyIssue {
    /// Repo-relative path the issue lives in.
    #[serde(default)]
    pub relevant_file: String,
    /// 1-3 word label, e.g. "Possible Bug", "Race Condition".
    #[serde(default)]
    pub issue_header: String,
    /// Concise description: what, the scenario, and the trigger.
    #[serde(default)]
    pub issue_content: String,
    /// First line of the relevant hunk (for click-to-open).
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub end_line: Option<u32>,
}

/// Full structured verdict for one review. Fields stay `snake_case` to match
/// the model's JSON output (see [`KeyIssue`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewVerdict {
    /// One-paragraph summary of the change under review.
    #[serde(default)]
    pub summary: String,
    /// Reviewer effort estimate, 1 (trivial) – 5 (demanding).
    #[serde(
        default,
        alias = "estimated_effort_to_review",
        alias = "estimated_effort_to_review_[1-5]"
    )]
    pub estimated_effort_to_review: Option<u8>,
    /// Overall quality score 0-100 (higher is better).
    #[serde(default)]
    pub score: Option<u8>,
    /// "yes" | "no" — whether the change includes relevant tests.
    #[serde(default = "no")]
    pub relevant_tests: String,
    /// Flagged issues. Empty means the reviewer found nothing actionable.
    #[serde(default, alias = "key_issues_to_review")]
    pub key_issues: Vec<KeyIssue>,
    /// "No" or a description of any security concern introduced by the change.
    #[serde(default = "no_concern")]
    pub security_concerns: String,
}

fn no() -> String {
    "no".to_string()
}
fn no_concern() -> String {
    "No".to_string()
}

/// Extract a [`ReviewVerdict`] from model output. Tries a fenced ```json block
/// first, then the outermost `{...}` span. Returns `None` if nothing parses.
pub fn parse(text: &str) -> Option<ReviewVerdict> {
    extract_json(text)
}

/// Tolerantly extract a JSON value of type `T` from model output: try a fenced
/// ```json block first, then the outermost balanced `{...}` span. Returns
/// `None` if nothing parses. Shared by every structured-output parser.
pub fn extract_json<T: serde::de::DeserializeOwned>(text: &str) -> Option<T> {
    for candidate in candidates(text) {
        if let Ok(v) = serde_json::from_str::<T>(&candidate) {
            return Some(v);
        }
    }
    None
}

/// Ordered JSON candidate strings to attempt, most-specific first.
fn candidates(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(block) = fenced_json(text) {
        out.push(block);
    }
    if let Some(span) = brace_span(text) {
        out.push(span);
    }
    out
}

/// Contents of the first ```json ... ``` (or bare ``` ... ```) fence.
fn fenced_json(text: &str) -> Option<String> {
    let start = text.find("```")?;
    let after = &text[start + 3..];
    // Skip an optional language tag on the same line (e.g. `json`).
    let body_start = after.find('\n').map(|i| i + 1).unwrap_or(0);
    let body = &after[body_start..];
    let end = body.find("```")?;
    Some(body[..end].trim().to_string())
}

/// The outermost balanced `{...}` span, ignoring braces inside strings.
fn brace_span(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let start = text.find('{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for i in start..bytes.len() {
        let c = bytes[i] as char;
        if in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fenced_json() {
        let text = "Here is the review:\n```json\n{\n  \"summary\": \"adds a cache\",\n  \"score\": 80,\n  \"key_issues\": [{\"relevant_file\": \"a.rs\", \"issue_header\": \"Possible Bug\", \"issue_content\": \"x\", \"start_line\": 12, \"end_line\": 14}]\n}\n```\nthanks";
        let v = parse(text).expect("should parse");
        assert_eq!(v.summary, "adds a cache");
        assert_eq!(v.score, Some(80));
        assert_eq!(v.key_issues.len(), 1);
        assert_eq!(v.key_issues[0].start_line, Some(12));
    }

    #[test]
    fn parses_bare_object_with_prose() {
        let text = "I reviewed it. {\"summary\": \"ok\", \"security_concerns\": \"No\"} Done.";
        let v = parse(text).expect("should parse");
        assert_eq!(v.summary, "ok");
        assert_eq!(v.security_concerns, "No");
        // Defaults applied for absent fields.
        assert_eq!(v.relevant_tests, "no");
        assert!(v.key_issues.is_empty());
    }

    #[test]
    fn accepts_pr_agent_aliases() {
        let text = "```json\n{\"summary\": \"s\", \"estimated_effort_to_review_[1-5]\": 3, \"key_issues_to_review\": []}\n```";
        let v = parse(text).expect("should parse");
        assert_eq!(v.estimated_effort_to_review, Some(3));
    }

    #[test]
    fn returns_none_on_garbage() {
        assert!(parse("no json here at all").is_none());
    }
}
