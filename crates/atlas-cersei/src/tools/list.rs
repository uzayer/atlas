//! `List` — gitignore-aware recursive file listing backed by ripgrep.

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::Value;

use super::{coerce, cwd, errors, run_rg};

const LIMIT: usize = 400;

const DESCRIPTION: &str = "Lists the files under a directory (recursively), via ripgrep, \
honoring .gitignore. Prefer this over shell tools (ls / find) to see what files exist.\n\n\
- path: optional directory (defaults to the project root).";

const ALIASES: &[(&str, &str)] = &[("dir", "path"), ("directory", "path"), ("file_path", "path")];

#[derive(Deserialize)]
struct Input {
    path: Option<String>,
}

pub struct ListTool;

#[async_trait]
impl Tool for ListTool {
    fn name(&self) -> &str {
        "List"
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
                "path": { "type": "string", "description": "Directory to list (default: project root)" }
            }
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::dealias(coerce::unwrap_stringified(input), ALIASES);
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => return ToolResult::error(errors::decode_failure("List", &e.to_string())),
        };

        let mut args = vec!["--files".to_string()];
        let target = input
            .path
            .as_deref()
            .map(|p| cwd::resolve_path(&ctx.working_dir, p).to_string_lossy().into_owned());
        if let Some(t) = &target {
            args.push(t.clone());
        }

        let out = match run_rg(args, ctx.working_dir.clone()).await {
            Ok(o) => o,
            Err(e) => return ToolResult::error(e),
        };

        let mut files: Vec<&str> = out.lines().collect();
        files.sort_unstable();
        if files.is_empty() {
            return ToolResult::success("No files found.".to_string());
        }
        let truncated = files.len() > LIMIT;
        let shown: Vec<&str> = files.iter().take(LIMIT).copied().collect();
        let mut body = format!("{} file(s):\n{}", files.len(), shown.join("\n"));
        if truncated {
            body.push_str(&format!("\n\n(Showing first {LIMIT}. Narrow with a subdirectory path.)"));
        }
        ToolResult::success(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};

    async fn run(dir: &std::path::Path, args: Value) -> ToolResult {
        ListTool.execute(args, &test_ctx(dir.to_path_buf())).await
    }

    #[tokio::test]
    async fn lists_files() {
        let tmp = TmpDir::new();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/a.rs"), "").unwrap();
        std::fs::write(tmp.path().join("README.md"), "").unwrap();
        let r = run(tmp.path(), serde_json::json!({})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("a.rs"));
        assert!(r.content.contains("README.md"));
    }

    #[tokio::test]
    async fn empty_dir() {
        let tmp = TmpDir::new();
        std::fs::create_dir_all(tmp.path().join("empty")).unwrap();
        let r = run(tmp.path(), serde_json::json!({"path": "empty"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("No files found"));
    }
}
