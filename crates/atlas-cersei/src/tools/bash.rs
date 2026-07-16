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
use tokio_util::sync::CancellationToken;

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
    /// The turn's cancel token fired: the process group was killed, its exit
    /// awaited, and whatever output landed is returned as a REAL result — the
    /// model (and history) see a settled tool call, not a dropped future.
    Cancelled { output: String },
}

/// Kill the child's whole process group (the shell AND its descendants —
/// `child.kill()` alone orphans grandchildren like `cargo build`'s rustc
/// processes), then reap. Unix-only; falls back to killing the shell.
fn kill_process_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        // Negative pid = the process group created by `process_group(0)`.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Run `command` under `sh -c` in `cwd`, combining stdout+stderr into a temp
/// file (so a full pipe buffer can never deadlock the poll loop) and enforcing
/// a wall-clock timeout. Blocking — call inside `spawn_blocking`.
fn run_blocking(
    command: &str,
    cwd: std::path::PathBuf,
    timeout_ms: u64,
    cancel: Option<CancellationToken>,
) -> Result<Outcome, String> {
    let combined = std::env::temp_dir().join(format!("atlas-cersei-bash-{}.out", uuid::Uuid::new_v4()));
    let file = std::fs::File::create(&combined).map_err(|e| format!("temp file: {e}"))?;
    let err_handle = file.try_clone().map_err(|e| format!("temp file: {e}"))?;

    let mut cmd = std::process::Command::new("sh");
    cmd.arg("-c")
        .arg(command)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(file))
        .stderr(Stdio::from(err_handle));
    // Own process group so cancel/timeout can kill the whole tree, and so the
    // group keeps being reaped by THIS loop even if the runner's cancel race
    // drops the async wrapper (spawn_blocking threads are not abortable —
    // this loop always runs to completion and cleans up).
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch shell: {e}"))?;

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    let mut cancelled = false;
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if cancel.as_ref().is_some_and(|t| t.is_cancelled()) {
                    kill_process_group(&mut child);
                    cancelled = true;
                    break;
                }
                if Instant::now() >= deadline {
                    kill_process_group(&mut child);
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

    if cancelled {
        return Ok(Outcome::Cancelled { output });
    }
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

#[derive(Default)]
pub struct BashTool {
    /// The turn's cancel token. When set, a Stop kills the running command's
    /// whole process group, awaits its exit, and returns the partial output
    /// as a real (error) result. `None` = uncancellable (delegate children,
    /// tests) — the wall-clock timeout still bounds it.
    pub cancel: Option<CancellationToken>,
}

impl BashTool {
    pub fn cancellable(token: CancellationToken) -> Self {
        Self { cancel: Some(token) }
    }
}

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
            Err(e) => {
                return ToolResult::error(errors::decode_failure(
                    "Bash",
                    &e.to_string(),
                    r#"{"command": "cargo build"}"#,
                ))
            }
        };
        let timeout_ms = input.timeout.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS);
        let cwd = ctx.working_dir.clone();
        let cmd = input.command.clone();
        let cancel = self.cancel.clone();

        let result =
            tokio::task::spawn_blocking(move || run_blocking(&cmd, cwd, timeout_ms, cancel)).await;

        match result {
            Ok(Ok(Outcome::Done { code, output })) => {
                let body = truncate::truncate_output(output, truncate::MAX_OUTPUT_BYTES, "Bash output");
                if code == 0 {
                    if body.trim().is_empty() {
                        ToolResult::success("(command completed with no output)")
                    } else {
                        ToolResult::success(body)
                    }
                } else if body.trim().is_empty() {
                    // Nonzero AND silent → a genuine failure with nothing to act on.
                    ToolResult::error(format!(
                        "Command failed with exit code {code} and produced no output."
                    ))
                } else {
                    // Nonzero WITH output is normal for many tools (grep no-match,
                    // diff, test, find on an unreadable entry). Surface it as a
                    // non-error result — the output (and any error text) is visible
                    // and the model decides — rather than flagging a failed call.
                    ToolResult::success(format!("{body}\n\n(Command exited with code {code}.)"))
                }
            }
            Ok(Ok(Outcome::Cancelled { output })) => {
                let body = truncate::truncate_output(output, truncate::MAX_OUTPUT_BYTES, "Bash output");
                ToolResult::error(format!(
                    "Command cancelled by user (process group killed). Partial output:\n{body}"
                ))
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
        BashTool::default().execute(args, &test_ctx(dir.to_path_buf())).await
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
    async fn nonzero_exit_no_output_is_error() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), serde_json::json!({"command": "exit 3"})).await;
        assert!(r.is_error);
        assert!(r.content.contains("exit code 3"));
    }

    #[tokio::test]
    async fn nonzero_exit_with_output_is_not_error() {
        let tmp = TmpDir::new();
        // grep no-match exits 1 but is a normal outcome — must not flag a failure.
        let r = run(tmp.path(), serde_json::json!({"command": "echo found; exit 1"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("found"));
        assert!(r.content.contains("exited with code 1"));
    }

    #[tokio::test]
    async fn combined_stderr() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), serde_json::json!({"command": "echo oops 1>&2"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("oops"));
    }

    #[tokio::test]
    async fn cancel_kills_process_group_and_settles_with_partial_output() {
        let tmp = TmpDir::new();
        let token = CancellationToken::new();
        let tool = BashTool::cancellable(token.clone());
        // Emits early output, then sleeps, then would WRITE A FILE — the write
        // must never land once the user cancels mid-sleep.
        let ctx = test_ctx(tmp.path().to_path_buf());
        let fut = tool.execute(
            serde_json::json!({
                "command": "echo started; sleep 20; echo late > after-cancel.txt",
                "timeout": 60000
            }),
            &ctx,
        );
        let killer = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            killer.cancel();
        });
        let started = std::time::Instant::now();
        let r = fut.await;
        // Settled promptly (not after the 20s sleep), as a REAL result…
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("cancelled"), "{}", r.content);
        // …carrying the partial output produced before the kill…
        assert!(r.content.contains("started"), "{}", r.content);
        // …and the whole process group is dead: the post-sleep write must
        // never appear, even after giving any survivor time to reach it.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(
            !tmp.path().join("after-cancel.txt").exists(),
            "process group must be killed — no writes after the settled result"
        );
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
