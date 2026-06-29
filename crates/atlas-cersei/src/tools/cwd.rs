//! Working-directory helpers + the `CwdTool` decorator.
//!
//! Atlas's own tools resolve relative paths internally via [`resolve_path`].
//! Retained SDK file tools that resolve a *bare* `file_path` and ignore
//! `ctx.working_dir` (verified: `NotebookEdit`) must stay wrapped in [`CwdTool`],
//! which absolutizes `file_path` against the session cwd before delegating.
//!
//! (Folds the former `src/cwd_tool.rs`.)

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde_json::Value;

/// Resolve a (possibly relative) `file_path` against the session working dir.
/// Absolute paths pass through untouched.
pub fn resolve_path(working_dir: &Path, file_path: &str) -> PathBuf {
    let p = Path::new(file_path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        working_dir.join(p)
    }
}

/// Decorator that absolutizes the wrapped tool's `file_path` against `working_dir`.
pub struct CwdTool(Box<dyn Tool>);

impl CwdTool {
    pub fn wrap(inner: Box<dyn Tool>) -> Box<dyn Tool> {
        Box::new(CwdTool(inner))
    }
}

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
            let abs = obj
                .get("file_path")
                .and_then(|v| v.as_str())
                .filter(|p| Path::new(p).is_relative())
                .map(|p| ctx.working_dir.join(p).to_string_lossy().into_owned());
            if let Some(abs) = abs {
                obj.insert("file_path".to_string(), Value::String(abs));
            }
        }
        self.0.execute(input, ctx).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_resolves_under_cwd() {
        let got = resolve_path(Path::new("/proj"), "src/main.rs");
        assert_eq!(got, PathBuf::from("/proj/src/main.rs"));
    }

    #[test]
    fn absolute_passes_through() {
        let got = resolve_path(Path::new("/proj"), "/etc/hosts");
        assert_eq!(got, PathBuf::from("/etc/hosts"));
    }
}
