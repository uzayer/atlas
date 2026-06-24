//! Working-directory decorator for the SDK file tools.
//!
//! cersei-tools' `Read` / `Write` / `Edit` / `NotebookEdit` resolve their
//! `file_path` argument with a bare `Path::new(&file_path)` — they IGNORE
//! `ctx.working_dir`. So a *relative* path (which the model naturally produces,
//! since the prompt only tells it the cwd) resolves against the **process** cwd
//! — the app bundle, not the project — `.exists()` is false, and the tool errors
//! with "File not found". The model then falls back to `cat <file>` via the
//! shell tool (which DOES honor `ctx.working_dir`), so reads "work" but only the
//! slow, ungrounded way.
//!
//! This wrapper makes the native file tools first-class: it rewrites a relative
//! `file_path` to an absolute path under the session's working directory before
//! delegating to the wrapped tool. Absolute paths pass through untouched, and a
//! tool with no `file_path` field is unaffected.

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde_json::Value;

/// Tools whose `file_path` input needs resolving against the session cwd.
const NEEDS_CWD: &[&str] = &["Read", "Write", "Edit", "NotebookEdit"];

/// Decorator: absolutizes the wrapped tool's `file_path` against `working_dir`.
pub struct CwdTool(Box<dyn Tool>);

#[async_trait]
impl Tool for CwdTool {
    fn name(&self) -> &str {
        self.0.name()
    }
    fn description(&self) -> &str {
        self.0.description()
    }
    fn input_schema(&self) -> Value {
        self.0.input_schema()
    }
    fn permission_level(&self) -> PermissionLevel {
        self.0.permission_level()
    }
    fn category(&self) -> ToolCategory {
        self.0.category()
    }
    async fn execute(&self, mut input: Value, ctx: &ToolContext) -> ToolResult {
        if let Some(obj) = input.as_object_mut() {
            // Compute the absolute path first (owned String) so the immutable
            // borrow of `obj` is released before we insert back into it.
            let abs = obj
                .get("file_path")
                .and_then(|v| v.as_str())
                .filter(|p| std::path::Path::new(p).is_relative())
                .map(|p| ctx.working_dir.join(p).to_string_lossy().into_owned());
            if let Some(abs) = abs {
                obj.insert("file_path".to_string(), Value::String(abs));
            }
        }
        self.0.execute(input, ctx).await
    }
}

/// Wrap the file tools in a toolset so their `file_path` resolves against the
/// session cwd. No-op for every other tool.
pub fn wrap_file_tools(tools: Vec<Box<dyn Tool>>) -> Vec<Box<dyn Tool>> {
    tools
        .into_iter()
        .map(|t| {
            if NEEDS_CWD.contains(&t.name()) {
                Box::new(CwdTool(t)) as Box<dyn Tool>
            } else {
                t
            }
        })
        .collect()
}
