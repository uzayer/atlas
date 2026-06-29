//! `Write` — create or overwrite a whole file. Use `Edit` for targeted changes.

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::Value;

use super::{coerce, cwd, errors};

const DESCRIPTION: &str = "Writes a file to the local filesystem, creating parent directories \
as needed and overwriting any existing file. Use this for a full-file write; for a targeted \
change to an existing file, prefer Edit. Do not use shell redirection (`>`/`tee`) to write files.";

const ALIASES: &[(&str, &str)] = &[
    ("filePath", "file_path"),
    ("path", "file_path"),
    ("filename", "file_path"),
    ("file", "file_path"),
    ("text", "content"),
    ("contents", "content"),
    ("data", "content"),
];

#[derive(Deserialize)]
struct Input {
    file_path: String,
    content: String,
}

pub struct WriteTool;

#[async_trait]
impl Tool for WriteTool {
    fn name(&self) -> &str {
        "Write"
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
                "content": { "type": "string", "description": "The full content to write" }
            },
            "required": ["file_path", "content"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::dealias(coerce::unwrap_stringified(input), ALIASES);
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => return ToolResult::error(errors::decode_failure("Write", &e.to_string())),
        };

        let path = cwd::resolve_path(&ctx.working_dir, &input.file_path);
        let rel = path
            .strip_prefix(&ctx.working_dir)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_string_lossy().into_owned());

        if let Some(parent) = path.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return ToolResult::error(format!("Failed to create {}: {e}", parent.display()));
            }
        }
        let existed = path.exists();
        match tokio::fs::write(&path, input.content.as_bytes()).await {
            Ok(()) => ToolResult::success(format!(
                "{} {rel} ({} bytes).",
                if existed { "Overwrote" } else { "Created" },
                input.content.len()
            )),
            Err(e) => ToolResult::error(format!("Failed to write {rel}: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};

    async fn run(dir: &std::path::Path, args: Value) -> ToolResult {
        WriteTool.execute(args, &test_ctx(dir.to_path_buf())).await
    }

    #[tokio::test]
    async fn creates_nested_file() {
        let tmp = TmpDir::new();
        let r = run(
            tmp.path(),
            serde_json::json!({"file_path": "a/b/c.txt", "content": "hi"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("Created"));
        assert_eq!(std::fs::read_to_string(tmp.path().join("a/b/c.txt")).unwrap(), "hi");
    }

    #[tokio::test]
    async fn overwrites_existing() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("x.txt"), "old").unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "x.txt", "content": "new"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("Overwrote"));
        assert_eq!(std::fs::read_to_string(tmp.path().join("x.txt")).unwrap(), "new");
    }

    #[tokio::test]
    async fn bad_input_errors() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), serde_json::json!({"file_path": "x.txt"})).await;
        assert!(r.is_error);
        assert!(r.content.contains("Invalid input"));
    }
}
