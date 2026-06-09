//! Token-aware diff packing, adapted from PR-Agent's compression strategy
//! (`pr_agent/algo/pr_processing.py`).
//!
//! A unified `git diff` is split into per-file patches. We greedily include
//! files in order while they fit the token budget (leaving an output buffer for
//! the model's reply); files that don't fit are dropped and named in an
//! "omitted" list appended to the diff, so the model knows coverage was partial.
//!
//! v1 uses a chars/4 token estimate. A precise tokenizer (`tiktoken-rs`) is a
//! follow-up — the packing logic is independent of how tokens are counted.

/// Tokens reserved for the model's own output, kept free of diff content.
const OUTPUT_BUFFER_TOKENS: usize = 1500;

/// Result of packing a raw diff into a token budget.
pub struct PackedDiff {
    /// The (possibly compressed) diff to send to the model.
    pub text: String,
    /// Repo-relative paths dropped because they exceeded the budget.
    pub omitted: Vec<String>,
    /// Estimated token count of `text`.
    pub estimated_tokens: usize,
}

/// Rough token estimate: ~4 chars per token (OpenAI/Anthropic ballpark).
pub fn estimate_tokens(s: &str) -> usize {
    s.len().div_ceil(4)
}

/// One file's section of a unified diff.
struct FilePatch {
    path: String,
    body: String,
}

/// Split a unified diff into per-file patches on `diff --git` boundaries.
/// Anything before the first boundary (rare preamble) is ignored.
fn split_files(diff: &str) -> Vec<FilePatch> {
    let mut files = Vec::new();
    let mut current: Option<FilePatch> = None;
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if let Some(f) = current.take() {
                files.push(f);
            }
            current = Some(FilePatch {
                path: parse_path(rest),
                body: String::new(),
            });
        }
        if let Some(f) = current.as_mut() {
            f.body.push_str(line);
            f.body.push('\n');
        }
    }
    if let Some(f) = current.take() {
        files.push(f);
    }
    files
}

/// Pull the b-side path out of a `diff --git a/foo b/foo` header tail.
fn parse_path(rest: &str) -> String {
    // rest == "a/foo b/foo". Prefer the b-side; fall back to the whole tail.
    rest.split(" b/")
        .nth(1)
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| rest.trim().to_string())
}

/// Pack `raw_diff` to fit `max_input_tokens` (including the output buffer).
/// Files are kept in original order; overflow files are dropped and listed.
pub fn pack(raw_diff: &str, max_input_tokens: usize) -> PackedDiff {
    let budget = max_input_tokens.saturating_sub(OUTPUT_BUFFER_TOKENS);
    let files = split_files(raw_diff);

    // Fast path: the whole diff fits.
    let whole = estimate_tokens(raw_diff);
    if whole <= budget || files.is_empty() {
        return PackedDiff {
            text: raw_diff.to_string(),
            omitted: Vec::new(),
            estimated_tokens: whole,
        };
    }

    let mut text = String::new();
    let mut used = 0usize;
    let mut omitted = Vec::new();
    for f in files {
        let cost = estimate_tokens(&f.body);
        if used + cost <= budget {
            text.push_str(&f.body);
            used += cost;
        } else {
            omitted.push(f.path);
        }
    }

    if !omitted.is_empty() {
        text.push_str("\n\n### Additional modified files (omitted — too large to include)\n");
        for path in &omitted {
            text.push_str("- ");
            text.push_str(path);
            text.push('\n');
        }
        used += estimate_tokens(&omitted.join("\n")) + 16;
    }

    PackedDiff {
        text,
        omitted,
        estimated_tokens: used,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_FILE_DIFF: &str = "diff --git a/small.rs b/small.rs\n--- a/small.rs\n+++ b/small.rs\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/big.rs b/big.rs\n--- a/big.rs\n+++ b/big.rs\n@@ -1 +200 @@\n+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";

    #[test]
    fn whole_diff_fits_under_large_budget() {
        let packed = pack(TWO_FILE_DIFF, 100_000);
        assert!(packed.omitted.is_empty());
        assert_eq!(packed.text, TWO_FILE_DIFF);
    }

    #[test]
    fn drops_overflow_file_and_lists_it() {
        // Budget tiny: buffer(1500) + room for only the small file.
        let small_tokens = estimate_tokens(
            "diff --git a/small.rs b/small.rs\n--- a/small.rs\n+++ b/small.rs\n@@ -1 +1 @@\n-old\n+new\n",
        );
        let packed = pack(TWO_FILE_DIFF, OUTPUT_BUFFER_TOKENS + small_tokens + 2);
        assert_eq!(packed.omitted, vec!["big.rs".to_string()]);
        assert!(packed.text.contains("small.rs"));
        assert!(packed.text.contains("Additional modified files"));
    }

    #[test]
    fn parses_b_side_path() {
        assert_eq!(parse_path("a/src/foo.rs b/src/foo.rs"), "src/foo.rs");
    }
}
