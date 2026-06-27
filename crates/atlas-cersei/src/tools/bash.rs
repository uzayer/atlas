//! `Bash` — run a shell command in the project root, with a timeout, combined
//! stdout+stderr, and output-capping temp-file spill.
//!
//! v0 semantics (see `plans/atlas-cersei-tools-from-scratch.md` Step 7): each
//! call starts fresh in `ctx.working_dir` — no persisted per-session cwd/env. A
//! model must pass a relative path rather than rely on a prior `cd`.

use std::process::Stdio;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::Value;

use super::{errors, truncate};

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

const DESCRIPTION: &str = "Executes a shell command and returns its combined output. Use this \
for terminal operations like git, npm, cargo, docker — NOT for file operations, which have \
dedicated tools:\n\
- Read a file → use Read (not cat/head/tail)\n\
- Search contents → use Grep (not cat | grep)\n\
- Find files by name → use Glob (not find / ls)\n\
- List a directory → use List (not ls)\n\
- Edit a file → use Edit (not sed/awk/perl), or Write for a full rewrite\n\n\
Each call starts in the project root. Pass a relative path; do NOT rely on a `cd` from a \
previous call (working directory does not persist). timeout is in milliseconds (default \
120000, max 600000).";

#[derive(Deserialize)]
struct Input {
    command: String,
    timeout: Option<u64>,
}

enum Outcome {
    Done { code: i32, output: String },
    TimedOut { ms: u64, output: String },
}

/// Run `command` under `sh -c` in `cwd`, combining stdout+stderr into a temp
/// file (so a full pipe buffer can never deadlock the poll loop) and enforcing
/// a wall-clock timeout. Blocking — call inside `spawn_blocking`.
fn run_blocking(command: &str, cwd: std::path::PathBuf, timeout_ms: u64) -> Result<Outcome, String> {
    let combined = std::env::temp_dir().join(format!("atlas-cersei-bash-{}.out", uuid::Uuid::new_v4()));
    let file = std::fs::File::create(&combined).map_err(|e| format!("temp file: {e}"))?;
    let err_handle = file.try_clone().map_err(|e| format!("temp file: {e}"))?;

    let mut child = std::process::Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(file))
        .stderr(Stdio::from(err_handle))
        .spawn()
        .map_err(|e| format!("Failed to launch shell: {e}"))?;

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(e) => return Err(format!("Failed to wait on shell: {e}")),
        }
    }

    let output = std::fs::read_to_string(&combined).unwrap_or_default();
    let _ = std::fs::remove_file(&combined);

    if timed_out {
        return Ok(Outcome::TimedOut { ms: timeout_ms, output });
    }
    let code = child
        .try_wait()
        .ok()
        .flatten()
        .and_then(|s| s.code())
        .unwrap_or(-1);
    Ok(Outcome::Done { code, output })
}

pub struct BashTool;

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str {
        "Bash"
    }
    fn description(&self) -> &str {
        DESCRIPTION
    }
    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Execute
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::Shell
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "The shell command to execute" },
                "timeout": { "type": "integer", "description": "Optional timeout in milliseconds (default 120000, max 600000)" }
            },
            "required": ["command"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => return ToolResult::error(errors::decode_failure("Bash", &e.to_string())),
        };
        let timeout_ms = input.timeout.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS);
        let cwd = ctx.working_dir.clone();
        let cmd = input.command.clone();

        let result = tokio::task::spawn_blocking(move || run_blocking(&cmd, cwd, timeout_ms)).await;

        match result {
            Ok(Ok(Outcome::Done { code, output })) => {
                let body = truncate::truncate_output(output, truncate::MAX_OUTPUT_BYTES, "Bash output");
                if code == 0 {
                    if body.trim().is_empty() {
                        ToolResult::success("(command completed with no output)")
                    } else {
                        ToolResult::success(body)
                    }
                } else {
                    ToolResult::error(format!("Exit code {code}\n{body}"))
                }
            }
            Ok(Ok(Outcome::TimedOut { ms, output })) => {
                let body = truncate::truncate_output(output, truncate::MAX_OUTPUT_BYTES, "Bash output");
                ToolResult::error(format!(
                    "Command timed out after {ms}ms (process killed). Partial output:\n{body}"
                ))
            }
            Ok(Err(e)) => ToolResult::error(e),
            Err(e) => ToolResult::error(format!("Bash task panicked: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};

    async fn run(dir: &std::path::Path, args: Value) -> ToolResult {
        BashTool.execute(args, &test_ctx(dir.to_path_buf())).await
    }

    #[tokio::test]
    async fn echo_and_exit_zero() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), serde_json::json!({"command": "echo hello"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("hello"));
    }

    #[tokio::test]
    async fn runs_in_working_dir() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("marker.txt"), "x").unwrap();
        let r = run(tmp.path(), serde_json::json!({"command": "ls"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("marker.txt"));
    }

    #[tokio::test]
    async fn nonzero_exit_is_error() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), serde_json::json!({"command": "exit 3"})).await;
        assert!(r.is_error);
        assert!(r.content.contains("Exit code 3"));
    }

    #[tokio::test]
    async fn combined_stderr() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), serde_json::json!({"command": "echo oops 1>&2"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("oops"));
    }

    #[tokio::test]
    async fn timeout_kills_process() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), serde_json::json!({"command": "sleep 5", "timeout": 200})).await;
        assert!(r.is_error);
        assert!(r.content.contains("timed out"));
    }

    #[tokio::test]
    async fn large_output_truncated() {
        let tmp = TmpDir::new();
        // ~50k 'a' characters.
        let r = run(tmp.path(), serde_json::json!({"command": "yes a | head -c 50000"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("truncated"));
    }
}
