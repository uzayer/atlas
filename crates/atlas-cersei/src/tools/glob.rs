//! `Glob` — filename pattern matching backed by ripgrep (gitignore-aware).

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::Value;

use super::{coerce, cwd, errors, run_rg};

const LIMIT: usize = 200;

const DESCRIPTION: &str = "Finds files by name using a glob pattern, via ripgrep. Prefer this \
over shell tools (find / ls). Honors .gitignore.\n\n\
- pattern: a glob like \"**/*.rs\" or \"src/**/*.ts\".\n\
- path: optional directory to search in (defaults to the project root). Omit it for the \
default — do not pass \"undefined\" or \"null\".\n\
Returns matching file paths.";

const ALIASES: &[(&str, &str)] = &[("glob", "pattern"), ("dir", "path"), ("directory", "path")];

#[derive(Deserialize)]
struct Input {
    pattern: String,
    path: Option<String>,
}

pub struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn name(&self) -> &str {
        "Glob"
    }
    fn description(&self) -> &str {
        DESCRIPTION
    }
    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::FileSystem
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Glob pattern, e.g. \"**/*.rs\"" },
                "path": { "type": "string", "description": "Directory to search in (default: project root)" }
            },
            "required": ["pattern"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::dealias(coerce::unwrap_stringified(input), ALIASES);
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => {
                return ToolResult::error(errors::decode_failure(
                    "Glob",
                    &e.to_string(),
                    r#"{"pattern": "**/*.rs", "path": "src"}"#,
                ))
            }
        };
        if input.pattern.is_empty() {
            return ToolResult::error("pattern is required and must be non-empty.".to_string());
        }

        let mut args = vec!["--files".to_string(), "--glob".to_string(), input.pattern.clone()];
        if let Some(p) = &input.path {
            args.push(cwd::resolve_path(&ctx.working_dir, p).to_string_lossy().into_owned());
        }

        let out = match run_rg(args, ctx.working_dir.clone()).await {
            Ok(o) => o,
            Err(e) => return ToolResult::error(e),
        };

        let mut files: Vec<&str> = out.lines().collect();
        files.sort_unstable();
        if files.is_empty() {
            return ToolResult::success(format!("No files match {}.", input.pattern));
        }
        let truncated = files.len() > LIMIT;
        let shown: Vec<&str> = files.iter().take(LIMIT).copied().collect();
        let mut body = shown.join("\n");
        if truncated {
            body.push_str(&format!(
                "\n\n(Showing first {LIMIT} of {}. Use a more specific pattern or path.)",
                files.len()
            ));
        }
        ToolResult::success(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};

    async fn run(dir: &std::path::Path, args: Value) -> ToolResult {
        GlobTool.execute(args, &test_ctx(dir.to_path_buf())).await
    }

    #[tokio::test]
    async fn matches_by_extension() {
        let tmp = TmpDir::new();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/a.rs"), "").unwrap();
        std::fs::write(tmp.path().join("src/b.rs"), "").unwrap();
        std::fs::write(tmp.path().join("c.txt"), "").unwrap();
        let r = run(tmp.path(), serde_json::json!({"pattern": "**/*.rs"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("a.rs"));
        assert!(r.content.contains("b.rs"));
        assert!(!r.content.contains("c.txt"));
    }

    #[tokio::test]
    async fn no_matches() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "").unwrap();
        let r = run(tmp.path(), serde_json::json!({"pattern": "**/*.zzz"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("No files match"));
    }
}
