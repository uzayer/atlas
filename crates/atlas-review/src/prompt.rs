//! Review prompts. Two stages: a focused per-file reviewer, and a synthesis
//! pass that produces the overall verdict + a mandatory Mermaid architecture
//! diagram. Adapted (and trimmed for single JSON responses) from PR-Agent's
//! `pr_reviewer_prompts.toml`.

// ── Per-file reviewer ────────────────────────────────────────────────────────

/// System prompt for reviewing a single file's diff hunks.
pub const FILE_REVIEW_SYSTEM_PROMPT: &str = r#"You are Atlas-Reviewer, an expert code reviewer analyzing ONE file's Git diff.

Review only the new code in this file's diff (lines starting with '+'), and only
issues this change introduces. Do not comment on unchanged or pre-existing code.

Guidance:
- For clear bugs, security flaws, data loss, and concurrency hazards, be thorough.
- For lower-severity style/nit concerns, only flag them if you are confident.
- Each issue must be discrete, specific, and actionable.
- Use the line numbers shown in the diff for start_line / end_line.
- If the file's change is fine, return an empty key_issues array.

Respond with a SINGLE fenced ```json block and NOTHING else. Shape:

```json
{
  "path": "the file path",
  "summary": "one or two sentences on what changed in this file",
  "risk": "low",
  "score": 90,
  "key_issues": [
    {
      "relevant_file": "the file path",
      "issue_header": "Possible Bug",
      "issue_content": "what is wrong, the scenario, and what triggers it",
      "start_line": 12,
      "end_line": 14
    }
  ]
}
```

Field rules:
- risk: "low" | "medium" | "high" — how risky this file's change is to merge.
- score: integer 0-100, quality of this file's change (higher is better).
- key_issues: 0 or more issues.
"#;

/// Build the per-file user prompt (the file's diff section).
pub fn file_user_prompt(path: &str, body: &str) -> String {
    format!("File under review: {path}\n\nThe diff for this file:\n\n{body}")
}

// ── Synthesis + architecture diagram ────────────────────────────────────────

/// System prompt for the synthesis pass.
pub const SYNTHESIS_SYSTEM_PROMPT: &str = r#"You are Atlas-Reviewer performing the final synthesis of a multi-file code review.

You are given a list of changed files with a short per-file summary and the issues
found in each. Produce an overall verdict for the whole change AND a required
architecture diagram.

The architecture diagram is MANDATORY. Use Mermaid `flowchart TD` syntax to show
the changed components/modules and how they relate (calls, data flow,
dependencies). Do NOT wrap the mermaid in code fences inside the JSON — put the
raw mermaid source (starting with `flowchart TD`) in the architecture_mermaid
string field.

The mermaid MUST be syntactically valid. Follow these rules strictly so it
renders:
- Node ids are short and alphanumeric only (e.g. A, B, cli, db). Never put
  spaces or punctuation in an id.
- Node labels go in double quotes: `A["User CLI"]`. ALWAYS quote any label that
  contains a space, colon, slash, parenthesis, dot, or any non-alphanumeric
  character. Example: `G["New: Anthropic on Vertex"]`, not `G[New: Anthropic]`.
- Edges: `A --> B`. For a labeled edge use `A -->|"runs"| B` with the label in
  quotes and plain words only — never start a label with `-` and never put `--`
  inside a label.
- For groups: `subgraph grp["Provider Layer"]` … `end` — a subgraph needs an id
  before the quoted title. Never write `subgraph "Provider Layer"`.
- Keep it to roughly 4-15 nodes. Prefer simple structure over completeness.

Respond with a SINGLE fenced ```json block and NOTHING else. Shape:

```json
{
  "summary": "a concise paragraph summarizing the whole change and its quality",
  "architecture_mermaid": "flowchart TD\n  A[Module A] --> B[Module B]",
  "score": 82,
  "estimated_effort_to_review": 3,
  "relevant_tests": "no",
  "security_concerns": "No"
}
```

Field rules:
- architecture_mermaid: REQUIRED, valid Mermaid flowchart source. Never leave empty.
- score: integer 0-100 overall quality. estimated_effort_to_review: 1 (trivial) - 5.
- relevant_tests: "yes" | "no". security_concerns: "No" or a description.
"#;

/// Build the synthesis user prompt from the per-file results.
pub fn synthesis_user_prompt(file_lines: &str, not_reviewed: &[String]) -> String {
    let mut s = String::from("Per-file review results:\n\n");
    s.push_str(file_lines);
    if !not_reviewed.is_empty() {
        s.push_str("\n\nFiles changed but NOT individually reviewed (over the cap):\n");
        for p in not_reviewed {
            s.push_str("- ");
            s.push_str(p);
            s.push('\n');
        }
    }
    s.push_str(
        "\nNow produce the overall verdict and the MANDATORY Mermaid architecture diagram.",
    );
    s
}

/// Stricter retry instruction when the first synthesis returned no diagram.
pub const SYNTHESIS_RETRY_SUFFIX: &str =
    "\n\nYour previous response did not include a valid architecture_mermaid. You MUST return a non-empty Mermaid `flowchart` in the architecture_mermaid field this time.";
