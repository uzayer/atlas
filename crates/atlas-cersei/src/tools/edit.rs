//! `Edit` — targeted string replacement with the opencode fallback ladder.
//!
//! Pipeline (see `plans/atlas-cersei-edit-solution.md`):
//!   L0  coerce args (strip fences, dealias keys, unwrap stringified JSON)
//!   →   resolve file_path against ctx.working_dir
//!   →   line-ending + BOM sandwich (normalize to \n for matching, restore on write)
//!   →   per-file lock
//!   →   [`replace`](super::replace::replace) driver (exact+LineTrimmed auto-apply,
//!       guarded fuzzy tail, disproportionate-match guard)
//!   →   on success: write + short diff preview
//!   →   on safe failure: corrective error with real nearby lines (+ Write steer
//!       for small files = L3).

use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use dashmap::DashMap;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;

use super::{coerce, cwd, errors, replace};

const DESCRIPTION: &str = "Performs exact string replacements in files. Prefer this over \
shell tools (sed/awk/perl) for editing — it is grounded in the real file and tolerates minor \
indentation/whitespace drift.\n\n\
Usage:\n\
- Read the file first; copy the text to replace EXACTLY as it appears AFTER the `N: ` line-number \
prefix in Read output. Never include any part of the `N: ` prefix in old_string or new_string.\n\
- old_string must be unique in the file, or the edit is rejected as ambiguous — add surrounding \
context, or set replace_all=true to change every occurrence (useful for renames).\n\
- new_string must differ from old_string. To replace a whole file, use Write instead.\n\
- If old_string is empty and the file does not exist, the file is created with new_string.";

/// Per-file edit lock so concurrent edits to the same file serialize.
static LOCKS: LazyLock<DashMap<PathBuf, Arc<Mutex<()>>>> = LazyLock::new(DashMap::new);

fn file_lock(path: &PathBuf) -> Arc<Mutex<()>> {
    LOCKS.entry(path.clone()).or_default().clone()
}

const BOM: &str = "\u{feff}";

fn detect_crlf(s: &str) -> bool {
    s.contains("\r\n")
}

/// Render `abs` relative to `working_dir` for display, falling back to `abs`.
fn display_path(working_dir: &std::path::Path, abs: &std::path::Path) -> String {
    abs.strip_prefix(working_dir)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| abs.to_string_lossy().into_owned())
}

/// Compact line diff: common prefix/suffix elided, changed region shown -/+.
fn mini_diff(old: &str, new: &str) -> String {
    let o: Vec<&str> = old.split('\n').collect();
    let n: Vec<&str> = new.split('\n').collect();
    let mut p = 0;
    while p < o.len() && p < n.len() && o[p] == n[p] {
        p += 1;
    }
    let mut s = 0;
    while s < o.len() - p && s < n.len() - p && o[o.len() - 1 - s] == n[n.len() - 1 - s] {
        s += 1;
    }
    let removed = &o[p..o.len() - s];
    let added = &n[p..n.len() - s];
    let mut out = Vec::new();
    for l in removed.iter().take(12) {
        out.push(format!("- {l}"));
    }
    if removed.len() > 12 {
        out.push(format!("  … (-{} more)", removed.len() - 12));
    }
    for l in added.iter().take(12) {
        out.push(format!("+ {l}"));
    }
    if added.len() > 12 {
        out.push(format!("  … (+{} more)", added.len() - 12));
    }
    out.join("\n")
}

#[derive(Deserialize)]
struct Input {
    file_path: String,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

pub struct EditTool;

#[async_trait]
impl Tool for EditTool {
    fn name(&self) -> &str {
        "Edit"
    }
    fn description(&self) -> &str {
        DESCRIPTION
    }
    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::FileSystem
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string", "description": "Path to the file (absolute, or relative to the project root)" },
                "old_string": { "type": "string", "description": "The exact text to replace" },
                "new_string": { "type": "string", "description": "The replacement text (must differ from old_string)" },
                "replace_all": { "type": "boolean", "description": "Replace all occurrences (default false)", "default": false }
            },
            "required": ["file_path", "old_string", "new_string"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::coerce_edit_args(input);
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => return ToolResult::error(errors::decode_failure("Edit", &e.to_string())),
        };

        let path = cwd::resolve_path(&ctx.working_dir, &input.file_path);
        let rel = display_path(&ctx.working_dir, &path);

        let lock = file_lock(&path);
        let _guard = lock.lock().await;

        // Create-on-empty-old-string (only when the file does not yet exist).
        if input.old_string.is_empty() {
            if path.exists() {
                return ToolResult::error(format!(
                    "old_string is empty but {rel} already exists. Provide the exact text to \
                     replace, or use Write for an intentional full-file replacement."
                ));
            }
            if let Some(parent) = path.parent() {
                if let Err(e) = tokio::fs::create_dir_all(parent).await {
                    return ToolResult::error(format!("Failed to create {}: {e}", parent.display()));
                }
            }
            return match tokio::fs::write(&path, &input.new_string).await {
                Ok(()) => ToolResult::success(format!("Created {rel} ({} bytes).", input.new_string.len())),
                Err(e) => ToolResult::error(format!("Failed to write {rel}: {e}")),
            };
        }

        let raw = match tokio::fs::read_to_string(&path).await {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return ToolResult::error(format!("File not found: {rel}"));
            }
            Err(e) => return ToolResult::error(format!("Failed to read {rel}: {e}")),
        };

        // Line-ending + BOM sandwich: normalize to \n for matching, restore on write.
        let had_bom = raw.starts_with(BOM);
        let content = raw.strip_prefix(BOM).unwrap_or(&raw);
        let crlf = detect_crlf(content);
        let content_lf = content.replace("\r\n", "\n");
        let old_lf = input.old_string.replace("\r\n", "\n");
        let new_lf = input.new_string.replace("\r\n", "\n");

        let result_lf = match replace::replace(&content_lf, &old_lf, &new_lf, input.replace_all) {
            Ok(s) => s,
            Err(replace::ReplaceError::Identical) => {
                return ToolResult::error(
                    "No changes to apply: old_string and new_string are identical.".to_string(),
                );
            }
            Err(replace::ReplaceError::EmptyOldString) => {
                return ToolResult::error(
                    "old_string is empty. Provide the exact text to replace, or use Write."
                        .to_string(),
                );
            }
            Err(replace::ReplaceError::NotFound) => {
                return ToolResult::error(errors::edit_not_found(&rel, &old_lf, &content_lf));
            }
            Err(replace::ReplaceError::MultipleMatches) => {
                return ToolResult::error(errors::edit_ambiguous(&rel));
            }
            Err(replace::ReplaceError::Disproportionate) => {
                return ToolResult::error(errors::edit_disproportionate(&rel));
            }
        };

        let diff = mini_diff(&content_lf, &result_lf);

        // Restore line endings + BOM.
        let mut to_write = if crlf {
            result_lf.replace('\n', "\r\n")
        } else {
            result_lf
        };
        if had_bom {
            to_write.insert_str(0, BOM);
        }

        match tokio::fs::write(&path, to_write).await {
            Ok(()) => ToolResult::success(format!("The file {rel} has been updated.\n{diff}")),
            Err(e) => ToolResult::error(format!("Failed to write {rel}: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};

    async fn run(dir: &std::path::Path, args: Value) -> ToolResult {
        EditTool.execute(args, &test_ctx(dir.to_path_buf())).await
    }

    #[tokio::test]
    async fn exact_edit() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "fn a() {}\nfn b() {}\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "fn a() {}", "new_string": "fn z() {}"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "fn z() {}\nfn b() {}\n");
    }

    #[tokio::test]
    async fn drifted_indent_edit_succeeds() {
        // File is tab-indented; the model sent spaces. Exact byte match misses
        // it (tab != spaces, and the line is not a substring); LineTrimmed
        // rescues it and yields the verbatim (tab-indented) slice.
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "fn main() {\n\tlet x = 1;\n}\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "    let x = 1;", "new_string": "\tlet x = 2;"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "fn main() {\n\tlet x = 2;\n}\n");
    }

    #[tokio::test]
    async fn ambiguous_returns_corrective_error() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "x = 1\ny = 2\nx = 1\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "x = 1", "new_string": "x = 9"}),
        )
        .await;
        assert!(r.is_error);
        assert!(r.content.contains("multiple matches"));
        // File unchanged.
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "x = 1\ny = 2\nx = 1\n");
    }

    #[tokio::test]
    async fn replace_all_renames() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "foo();\nfoo();\nbar();\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "foo", "new_string": "baz", "replace_all": true}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "baz();\nbaz();\nbar();\n");
    }

    #[tokio::test]
    async fn create_guard_empty_old_existing_file() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.rs");
        std::fs::write(&f, "data\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.rs", "old_string": "", "new_string": "new"}),
        )
        .await;
        assert!(r.is_error);
        assert!(r.content.contains("already exists"));
    }

    #[tokio::test]
    async fn empty_old_creates_new_file() {
        let tmp = TmpDir::new();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "sub/new.txt", "old_string": "", "new_string": "hello"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(tmp.path().join("sub/new.txt")).unwrap(), "hello");
    }

    #[tokio::test]
    async fn crlf_preserved() {
        let tmp = TmpDir::new();
        let f = tmp.path().join("a.txt");
        std::fs::write(&f, "a\r\nb\r\nc\r\n").unwrap();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a.txt", "old_string": "b", "new_string": "B"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "a\r\nB\r\nc\r\n");
    }

    #[tokio::test]
    async fn missing_file_errors() {
        let tmp = TmpDir::new();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "nope.rs", "old_string": "x", "new_string": "y"}),
        )
        .await;
        assert!(r.is_error);
        assert!(r.content.contains("File not found"));
    }
}
