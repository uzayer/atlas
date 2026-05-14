use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// Tracks running claude PIDs by Atlas chat-tab id so we can kill them on demand.
fn pid_registry() -> &'static Mutex<HashMap<String, u32>> {
    static REG: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// macOS GUI apps inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
/// so `claude` (installed in `~/.local/bin` or `/opt/homebrew/bin`) can't be
/// found by `Command::new("claude")`. We augment PATH with common locations.
fn augmented_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let extras = [
        format!("{}/.local/bin", home),
        format!("{}/.bun/bin", home),
        format!("{}/.cargo/bin", home),
        format!("{}/.nvm/versions/node", home), // most likely shadowed but cheap
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/local/sbin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
    ];
    let mut out = base;
    for e in extras.iter().rev() {
        if !out.split(':').any(|p| p == e) {
            out = format!("{}:{}", e, out);
        }
    }
    out
}

/// Resolve the absolute path to the `claude` binary by asking the user's login
/// shell where it lives, so we don't rely on Atlas's process PATH (which is
/// minimal when launched from Finder).
fn resolve_claude_path() -> Option<String> {
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            // First try the augmented PATH ourselves.
            let path = augmented_path();
            for dir in path.split(':') {
                let candidate = Path::new(dir).join("claude");
                if candidate.exists() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
            // Fall back to a login shell — picks up shell-rc PATH exports.
            for shell in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
                if !Path::new(shell).exists() {
                    continue;
                }
                if let Ok(out) = Command::new(shell)
                    .arg("-l")
                    .arg("-c")
                    .arg("command -v claude")
                    .output()
                {
                    if out.status.success() {
                        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                        if !s.is_empty() && Path::new(&s).exists() {
                            return Some(s);
                        }
                    }
                }
            }
            None
        })
        .clone()
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeResponse {
    pub output: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeStreamEvent {
    pub session_id: String,
    pub event_type: String, // "text", "tool_use", "tool_result", "plan", "status", "error", "done", "session"
    pub content: String,    // text content or JSON payload
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeSessionMeta {
    pub id: String,
    pub file_path: String,
    pub started_at: Option<String>,
    pub last_modified: Option<String>,
    pub message_count: usize,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCallDump {
    pub tool_name: String,
    pub input: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ClaudeSessionStats {
    pub session_id: String,
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub request_count: u64,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessageDump {
    pub role: String, // "user" | "assistant"
    pub content: String,
    pub timestamp: Option<String>,
    pub tool_calls: Vec<ToolCallDump>,
}

/// Run claude code in --print mode (non-interactive, single prompt)
#[tauri::command]
pub async fn claude_run(
    prompt: String,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<ClaudeResponse, String> {
    tokio::task::spawn_blocking(move || {
        let claude_bin = resolve_claude_path().unwrap_or_else(|| "claude".to_string());
        let mut cmd = Command::new(&claude_bin);
        cmd.arg("--print");
        cmd.arg(&prompt);

        if let Some(ref m) = model {
            cmd.arg("--model").arg(m);
        }

        if let Some(ref dir) = cwd {
            cmd.current_dir(dir);
        }

        cmd.arg("--output-format").arg("text");
        cmd.env("PATH", augmented_path());

        let output = cmd.output().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
                    .to_string()
            } else {
                format!("Failed to run claude: {}", e)
            }
        })?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let exit_code = output.status.code().unwrap_or(-1);

        let combined = if stderr.is_empty() {
            stdout
        } else {
            format!("{}\n{}", stdout, stderr)
        };

        Ok(ClaudeResponse {
            output: combined,
            exit_code,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run claude code with streaming JSON output, emitting events as they arrive
#[tauri::command]
pub async fn claude_stream(
    app: AppHandle,
    session_id: String,
    prompt: String,
    cwd: Option<String>,
    resume_session_id: Option<String>,
    permission_mode: Option<String>,
) -> Result<(), String> {
    let sid = session_id.clone();

    let _ = app.emit(
        "claude-stream",
        ClaudeStreamEvent {
            session_id: sid.clone(),
            event_type: "status".into(),
            content: "running".into(),
        },
    );

    tokio::task::spawn_blocking(move || {
        // Resolve the absolute path so we work when Atlas was launched from
        // Finder (which strips ~/.local/bin from PATH).
        let claude_bin = resolve_claude_path().unwrap_or_else(|| "claude".to_string());
        let mut cmd = Command::new(&claude_bin);
        cmd.arg("--print");
        cmd.arg("--output-format").arg("stream-json");
        cmd.arg("--verbose"); // stream-json requires --verbose in non-interactive mode

        if let Some(ref rid) = resume_session_id {
            cmd.arg("--resume").arg(rid);
        }

        if let Some(ref mode) = permission_mode {
            // claude CLI accepts: default, acceptEdits, plan, bypassPermissions, delegate, dontAsk
            cmd.arg("--permission-mode").arg(mode);
        }

        cmd.arg(&prompt);

        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Augment PATH so any child the CLI spawns (node, git, etc.) is reachable too.
        cmd.env("PATH", augmented_path());

        // Strip env vars that make Claude Code switch into SDK / agent mode
        // (e.g. when Atlas is launched from a terminal that's already inside another
        // Claude Code session, those vars leak into the child and break --print).
        for k in [
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            "AI_AGENT",
        ] {
            cmd.env_remove(k);
        }

        if let Some(ref dir) = cwd {
            cmd.current_dir(dir);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => {
                // Track the PID so claude_stop can kill it.
                if let Ok(mut reg) = pid_registry().lock() {
                    reg.insert(sid.clone(), c.id());
                }
                c
            }
            Err(e) => {
                let _ = app.emit(
                    "claude-stream",
                    ClaudeStreamEvent {
                        session_id: sid.clone(),
                        event_type: "error".into(),
                        content: format!("Failed to start claude: {}", e),
                    },
                );
                return;
            }
        };

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };

                if line.trim().is_empty() {
                    continue;
                }

                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(cs) = v.get("session_id").and_then(|s| s.as_str()) {
                        let _ = app.emit(
                            "claude-stream",
                            ClaudeStreamEvent {
                                session_id: sid.clone(),
                                event_type: "session".into(),
                                content: cs.to_string(),
                            },
                        );
                    }

                    // Filter sub-agent traffic so the live stream matches the
                    // saved JSONL replay (which drops sidechain events). Events
                    // emitted by a Task sub-agent have parent_tool_use_id !=
                    // null; the top-level agent's events have it null.
                    let is_subagent = v
                        .get("parent_tool_use_id")
                        .map(|p| !p.is_null())
                        .unwrap_or(false);
                    if is_subagent {
                        continue;
                    }

                    let (event_type, content) = parse_claude_event(&v);
                    let _ = app.emit(
                        "claude-stream",
                        ClaudeStreamEvent {
                            session_id: sid.clone(),
                            event_type,
                            content,
                        },
                    );
                } else {
                    let _ = app.emit(
                        "claude-stream",
                        ClaudeStreamEvent {
                            session_id: sid.clone(),
                            event_type: "text".into(),
                            content: line,
                        },
                    );
                }
            }
        }

        let status = child.wait().unwrap_or_else(|_| std::process::ExitStatus::default());
        // Drop the PID entry once the process exits.
        if let Ok(mut reg) = pid_registry().lock() {
            reg.remove(&sid);
        }
        let exit_code = status.code().unwrap_or(-1);

        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            let stderr_text: String = reader
                .lines()
                .filter_map(|l| l.ok())
                .collect::<Vec<_>>()
                .join("\n");
            if !stderr_text.is_empty() {
                let _ = app.emit(
                    "claude-stream",
                    ClaudeStreamEvent {
                        session_id: sid.clone(),
                        event_type: "error".into(),
                        content: stderr_text,
                    },
                );
            }
        }

        let _ = app.emit(
            "claude-stream",
            ClaudeStreamEvent {
                session_id: sid.clone(),
                event_type: "done".into(),
                content: exit_code.to_string(),
            },
        );
    });

    Ok(())
}

fn parse_claude_event(v: &serde_json::Value) -> (String, String) {
    let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("text");

    match event_type {
        "system" => {
            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            ("status".to_string(), format!("system:{}", subtype))
        }
        "assistant" => {
            let text = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .filter_map(|block| {
                            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                block.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                            } else {
                                None
                            }
                        })
                        .next()
                })
                .unwrap_or_default();

            if !text.is_empty() {
                return ("text".to_string(), text);
            }

            // Check for tool_use within an assistant message
            let tool = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
                });
            if let Some(t) = tool {
                let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
                let input = t.get("input").cloned().unwrap_or(serde_json::json!({}));
                return (
                    "tool_use".to_string(),
                    serde_json::json!({ "name": name, "input": input }).to_string(),
                );
            }

            ("text".to_string(), String::new())
        }
        "user" => {
            // tool_result wrapped in a user message
            let result = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                        .and_then(|b| b.get("content"))
                });
            let content = match result {
                Some(c) if c.is_string() => c.as_str().unwrap_or("").to_string(),
                Some(c) => serde_json::to_string(c).unwrap_or_default(),
                None => String::new(),
            };
            ("tool_result".to_string(), content)
        }
        "tool_use" | "tool_use_begin" => {
            let tool_name = v
                .get("tool")
                .and_then(|t| t.get("name"))
                .or_else(|| v.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("unknown");
            let input = v
                .get("tool")
                .and_then(|t| t.get("input"))
                .or_else(|| v.get("input"))
                .cloned()
                .unwrap_or(serde_json::json!({}));
            (
                "tool_use".to_string(),
                serde_json::json!({ "name": tool_name, "input": input }).to_string(),
            )
        }
        "tool_result" => {
            let result = v
                .get("content")
                .or_else(|| v.get("output"))
                .map(|c| {
                    if let Some(s) = c.as_str() {
                        s.to_string()
                    } else {
                        serde_json::to_string(c).unwrap_or_default()
                    }
                })
                .unwrap_or_default();
            ("tool_result".to_string(), result)
        }
        "result" => {
            // Final result envelope — text on success, or error info when subtype is error_*.
            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            let is_error =
                v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false)
                    || subtype.starts_with("error");

            if is_error {
                // Collect any error strings from the `errors` array.
                let errors: Vec<String> = v
                    .get("errors")
                    .and_then(|e| e.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                let mut msg = format!("Claude Code error ({}).", subtype);
                if !errors.is_empty() {
                    msg.push_str(" Details:\n");
                    msg.push_str(&errors.join("\n"));
                }
                return ("error".to_string(), msg);
            }

            let text = v
                .get("result")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string();
            ("text".to_string(), text)
        }
        "content_block_delta" => {
            let delta = v
                .get("delta")
                .and_then(|d| d.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            ("text".to_string(), delta.to_string())
        }
        _ => ("raw".to_string(), serde_json::to_string(v).unwrap_or_default()),
    }
}

#[tauri::command]
pub fn claude_stop(session_id: String) -> Result<(), String> {
    let pid = match pid_registry().lock() {
        Ok(reg) => reg.get(&session_id).copied(),
        Err(_) => None,
    };
    if let Some(pid) = pid {
        // Send SIGTERM via the system `kill` command (Unix). On macOS this
        // gracefully stops claude; if it ignores SIGTERM, it'll respond to
        // a follow-up SIGKILL too.
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .output();
    }
    Ok(())
}

#[tauri::command]
pub fn claude_check() -> Result<bool, String> {
    Ok(resolve_claude_path().is_some())
}

#[tauri::command]
pub fn claude_version() -> Result<String, String> {
    let bin = resolve_claude_path().ok_or_else(|| "claude not found".to_string())?;
    let output = Command::new(bin)
        .arg("--version")
        .env("PATH", augmented_path())
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// ───────────────────────── Session management ─────────────────────────

fn projects_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home.join(".claude").join("projects"))
}

/// Claude Code encodes the project cwd as folder name by replacing `/` with `-`.
/// E.g. `/Users/adib/Desktop/atlas` → `-Users-adib-Desktop-atlas`.
fn encode_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches('/');
    trimmed.replace('/', "-")
}

/// Identify user content that's injected by Claude Code itself rather than typed by the user.
fn is_injected_user_text(t: &str) -> bool {
    let trimmed = t.trim();
    if trimmed.is_empty() {
        return true;
    }
    // System tags (e.g. <system-reminder>, <command-name>, <local-command-...>)
    if trimmed.starts_with('<') {
        return true;
    }
    // Claude Code interruption notice
    if trimmed.starts_with("[Request interrupted") {
        return true;
    }
    // Warmup pings issued by sub-agents
    if trimmed.eq_ignore_ascii_case("warmup") {
        return true;
    }
    false
}

fn extract_first_user_text(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("user") {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    let text = if let Some(s) = content.as_str() {
        s.to_string()
    } else if let Some(arr) = content.as_array() {
        arr.iter()
            .find_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })?
    } else {
        return None;
    };
    if is_injected_user_text(&text) {
        return None;
    }
    Some(text.trim().to_string())
}

/// Is this whole jsonl file a sub-agent / warmup conversation rather than a real chat?
fn jsonl_is_sidechain(path: &Path) -> bool {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let reader = BufReader::new(file);
    // Inspect the first ~20 records; if every classified line is a sidechain we treat it as a warmup.
    let mut saw_main = false;
    let mut saw_sidechain = false;
    for (i, line) in reader.lines().flatten().enumerate() {
        if i > 30 {
            break;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("isSidechain").and_then(|x| x.as_bool()) {
            Some(true) => saw_sidechain = true,
            Some(false) => saw_main = true,
            None => {}
        }
    }
    saw_sidechain && !saw_main
}

fn extract_timestamp(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    v.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string())
}

#[tauri::command]
pub async fn list_claude_sessions(cwd: String) -> Result<Vec<ClaudeSessionMeta>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<ClaudeSessionMeta>, String> {
        let folder = projects_dir()?.join(encode_cwd(&cwd));
        if !folder.exists() {
            return Ok(Vec::new());
        }

        let mut out: Vec<ClaudeSessionMeta> = Vec::new();
        for entry in std::fs::read_dir(&folder).map_err(|e| e.to_string())? {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }

            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if id.is_empty() {
                continue;
            }
            // Skip Claude Code's internal sub-agent / warmup session files.
            if id.starts_with("agent-") {
                continue;
            }
            if jsonl_is_sidechain(&path) {
                continue;
            }

            let metadata = entry.metadata().ok();
            let last_modified = metadata
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| {
                    let dt: chrono::DateTime<chrono::Utc> = t.into();
                    Some(dt.to_rfc3339())
                });

            let file = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let reader = BufReader::new(file);

            let mut started_at: Option<String> = None;
            let mut preview: Option<String> = None;
            let mut message_count = 0usize;

            for line in reader.lines().flatten() {
                if started_at.is_none() {
                    started_at = extract_timestamp(&line);
                }
                if preview.is_none() {
                    if let Some(p) = extract_first_user_text(&line) {
                        let p = p.replace('\n', " ");
                        let truncated: String = if p.chars().count() > 80 {
                            p.chars().take(80).collect::<String>() + "…"
                        } else {
                            p
                        };
                        preview = Some(truncated);
                    }
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if t == "user" || t == "assistant" {
                        message_count += 1;
                    }
                }
            }

            out.push(ClaudeSessionMeta {
                id,
                file_path: path.to_string_lossy().to_string(),
                started_at,
                last_modified,
                message_count,
                preview: preview.unwrap_or_else(|| "(no user message)".to_string()),
            });
        }

        out.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_claude_session(file_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let base = projects_dir()?;
        let p = Path::new(&file_path);
        if !p.starts_with(&base) {
            return Err("refusing to delete: path outside ~/.claude/projects".into());
        }
        std::fs::remove_file(p).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Pricing per 1M tokens: (input, output, cache_write, cache_read)
// Approximate Anthropic public pricing.
fn pricing_for(model: &str) -> (f64, f64, f64, f64) {
    let m = model.to_lowercase();
    if m.contains("opus") {
        (15.0, 75.0, 18.75, 1.50)
    } else if m.contains("haiku") {
        (0.80, 4.0, 1.00, 0.08)
    } else if m.contains("sonnet") {
        (3.0, 15.0, 3.75, 0.30)
    } else {
        // Unknown — assume sonnet-class pricing as a safe default.
        (3.0, 15.0, 3.75, 0.30)
    }
}

#[tauri::command]
pub async fn claude_session_stats(
    cwd: String,
    session_id: String,
) -> Result<ClaudeSessionStats, String> {
    tokio::task::spawn_blocking(move || -> Result<ClaudeSessionStats, String> {
        let folder = projects_dir()?.join(encode_cwd(&cwd));
        let path = folder.join(format!("{}.jsonl", session_id));
        if !path.exists() {
            return Ok(ClaudeSessionStats {
                session_id,
                ..Default::default()
            });
        }
        let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let reader = BufReader::new(file);

        let mut stats = ClaudeSessionStats {
            session_id: session_id.clone(),
            ..Default::default()
        };

        for line in reader.lines().flatten() {
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // Only assistant messages carry usage.
            if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                continue;
            }
            // Don't bill sub-agent warmup turns to the user-visible session.
            if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
                continue;
            }
            let msg = match v.get("message") {
                Some(m) => m,
                None => continue,
            };
            // Capture model (latest wins)
            if let Some(model) = msg.get("model").and_then(|m| m.as_str()) {
                stats.model = Some(model.to_string());
            }
            let usage = match msg.get("usage") {
                Some(u) => u,
                None => continue,
            };
            let input = usage.get("input_tokens").and_then(|n| n.as_u64()).unwrap_or(0);
            let output = usage.get("output_tokens").and_then(|n| n.as_u64()).unwrap_or(0);
            let cache_w = usage
                .get("cache_creation_input_tokens")
                .and_then(|n| n.as_u64())
                .unwrap_or(0);
            let cache_r = usage
                .get("cache_read_input_tokens")
                .and_then(|n| n.as_u64())
                .unwrap_or(0);

            stats.input_tokens += input;
            stats.output_tokens += output;
            stats.cache_creation_tokens += cache_w;
            stats.cache_read_tokens += cache_r;
            stats.request_count += 1;
        }

        let model = stats.model.clone().unwrap_or_default();
        let (p_in, p_out, p_cw, p_cr) = pricing_for(&model);
        let m = 1_000_000.0;
        stats.total_cost_usd = (stats.input_tokens as f64 / m) * p_in
            + (stats.output_tokens as f64 / m) * p_out
            + (stats.cache_creation_tokens as f64 / m) * p_cw
            + (stats.cache_read_tokens as f64 / m) * p_cr;

        Ok(stats)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_claude_session(file_path: String) -> Result<Vec<ChatMessageDump>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<ChatMessageDump>, String> {
        let base = projects_dir()?;
        let p = Path::new(&file_path);
        if !p.starts_with(&base) {
            return Err("refusing to read: path outside ~/.claude/projects".into());
        }
        let file = std::fs::File::open(p).map_err(|e| e.to_string())?;
        let reader = BufReader::new(file);

        let mut out: Vec<ChatMessageDump> = Vec::new();
        for line in reader.lines().flatten() {
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let ts = v.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string());

            // Skip sub-agent traffic entirely.
            if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
                continue;
            }
            match kind {
                "user" => {
                    if let Some(text) = extract_user_message_text(&v) {
                        out.push(ChatMessageDump {
                            role: "user".into(),
                            content: text,
                            timestamp: ts,
                            tool_calls: Vec::new(),
                        });
                    }
                }
                "assistant" => {
                    let (text, tool_calls) = extract_assistant_blocks(&v);
                    if !text.trim().is_empty() || !tool_calls.is_empty() {
                        out.push(ChatMessageDump {
                            role: "assistant".into(),
                            content: text,
                            timestamp: ts,
                            tool_calls,
                        });
                    }
                }
                _ => {}
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn extract_user_message_text(v: &serde_json::Value) -> Option<String> {
    // Skip sub-agent / warmup user lines entirely.
    if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    if let Some(s) = content.as_str() {
        if is_injected_user_text(s) {
            return None;
        }
        return Some(s.trim().to_string());
    }
    if let Some(arr) = content.as_array() {
        // Skip blocks that are tool_result (they're tool replies, not real user input)
        let has_tool_result = arr.iter().any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"));
        if has_tool_result {
            return None;
        }
        let text: String = arr
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        if is_injected_user_text(&text) {
            return None;
        }
        return Some(text.trim().to_string());
    }
    None
}

fn extract_assistant_blocks(v: &serde_json::Value) -> (String, Vec<ToolCallDump>) {
    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCallDump> = Vec::new();
    let content = match v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
        Some(c) => c,
        None => return (String::new(), tool_calls),
    };
    for block in content {
        let btype = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match btype {
            "text" => {
                if let Some(s) = block.get("text").and_then(|t| t.as_str()) {
                    text_parts.push(s.to_string());
                }
            }
            "tool_use" => {
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                tool_calls.push(ToolCallDump { tool_name: name, input });
            }
            _ => {}
        }
    }
    (text_parts.join("\n"), tool_calls)
}
