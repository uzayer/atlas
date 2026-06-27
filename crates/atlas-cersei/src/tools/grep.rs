//! `Grep` — regex content search backed by ripgrep (gitignore-aware).

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::Value;

use super::{coerce, cwd, errors, run_rg};

const LIMIT: usize = 200;

const DESCRIPTION: &str = "Searches file contents with a regular expression, via ripgrep. \
Prefer this over shell tools (cat | grep). Honors .gitignore.\n\n\
- pattern: a regex (e.g. \"log.*Error\", \"fn\\s+\\w+\").\n\
- path: optional file or directory to search (defaults to the project root).\n\
- include: optional file glob filter (e.g. \"*.rs\", \"*.{ts,tsx}\").\n\
Returns matching lines as `path:line:text`.";

const ALIASES: &[(&str, &str)] = &[("glob", "include"), ("filter", "include"), ("dir", "path")];

#[derive(Deserialize)]
struct Input {
    pattern: String,
    path: Option<String>,
    include: Option<String>,
}

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str {
        "Grep"
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
                "pattern": { "type": "string", "description": "Regex pattern to search for in file contents" },
                "path": { "type": "string", "description": "File or directory to search in (default: project root)" },
                "include": { "type": "string", "description": "File glob filter, e.g. \"*.rs\"" }
            },
            "required": ["pattern"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::dealias(coerce::unwrap_stringified(input), ALIASES);
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => return ToolResult::error(errors::decode_failure("Grep", &e.to_string())),
        };
        if input.pattern.is_empty() {
            return ToolResult::error("pattern is required and must be non-empty.".to_string());
        }

        let mut args = vec![
            "--line-number".to_string(),
            "--no-heading".to_string(),
            "--color".to_string(),
            "never".to_string(),
        ];
        if let Some(inc) = &input.include {
            args.push("--glob".to_string());
            args.push(inc.clone());
        }
        args.push("--regexp".to_string());
        args.push(input.pattern.clone());
        let target = input
            .path
            .as_deref()
            .map(|p| cwd::resolve_path(&ctx.working_dir, p).to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string());
        args.push(target);

        let out = match run_rg(args, ctx.working_dir.clone()).await {
            Ok(o) => o,
            Err(e) => return ToolResult::error(e),
        };

        let lines: Vec<&str> = out.lines().collect();
        if lines.is_empty() {
            return ToolResult::success(format!("No matches for /{}/.", input.pattern));
        }
        let truncated = lines.len() > LIMIT;
        let shown: Vec<&str> = lines.iter().take(LIMIT).copied().collect();
        let mut body = format!("Found {} match(es):\n{}", lines.len(), shown.join("\n"));
        if truncated {
            body.push_str(&format!(
                "\n\n(Showing first {LIMIT}. Narrow the pattern, path, or include filter.)"
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
        GrepTool.execute(args, &test_ctx(dir.to_path_buf())).await
    }

    #[tokio::test]
    async fn finds_regex_matches() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "fn alpha() {}\nfn beta() {}\n").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "fn gamma() {}\n").unwrap();
        let r = run(tmp.path(), serde_json::json!({"pattern": "fn \\w+", "include": "*.rs"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("alpha"));
        assert!(r.content.contains("beta"));
        // include filter excludes the .txt file
        assert!(!r.content.contains("gamma"));
    }

    #[tokio::test]
    async fn no_matches() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.rs"), "hello\n").unwrap();
        let r = run(tmp.path(), serde_json::json!({"pattern": "zzz_nomatch"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("No matches"));
    }

    #[tokio::test]
    async fn empty_pattern_errors() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), serde_json::json!({"pattern": ""})).await;
        assert!(r.is_error);
        assert!(r.content.contains("pattern is required"));
    }
}
