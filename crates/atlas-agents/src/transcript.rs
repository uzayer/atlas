//! Transcript replay — claude-code JSONL parser, used by `load_session` to
//! hydrate `SessionState` from disk before the UI ever attaches.
//!
//! Mirrors the parsing logic that previously lived in
//! `src-tauri/src/commands/claude.rs:402-463`. v1 supports only the canonical
//! Claude Code JSONL format; new transcript kinds plug in by adding variants
//! to `plugin::TranscriptKind` and a corresponding replay function here.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use crate::error::{Error, Result};
use crate::plugin::TranscriptKind;
use crate::session::{
    Message, MessageMode, MessageRole, ToolCall, ToolCallStatus, new_message_id,
};
use chrono::{DateTime, Utc};

/// Replay an agent's on-disk transcript for `(cwd, session_id)` into a list of
/// seed messages. Returns `Ok(Vec::new())` for transcript-less plugins or when
/// the file doesn't exist (fresh session).
///
/// Runs the actual read+parse on `tokio::task::spawn_blocking`. JSONL files
/// hit 10k+ lines for long-lived projects; parsing them on a runtime worker
/// thread would stall every other agent in the manager.
pub async fn replay(
    kind: TranscriptKind,
    cwd: &str,
    session_id: &str,
) -> Result<Vec<Message>> {
    match kind {
        TranscriptKind::None => Ok(Vec::new()),
        TranscriptKind::ClaudeJsonl => {
            let cwd = cwd.to_string();
            let session_id = session_id.to_string();
            tokio::task::spawn_blocking(move || replay_claude_jsonl(&cwd, &session_id))
                .await
                .map_err(|e| Error::Other(format!("transcript replay join: {e}")))?
        }
    }
}

fn replay_claude_jsonl(cwd: &str, session_id: &str) -> Result<Vec<Message>> {
    let Some(path) = claude_jsonl_path(cwd, session_id) else {
        return Ok(Vec::new());
    };
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = std::fs::File::open(&path).map_err(|e| Error::Io(e.to_string()))?;
    let reader = BufReader::new(file);

    let mut out: Vec<Message> = Vec::new();
    for line in reader.lines().flatten() {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let timestamp = parse_timestamp(v.get("timestamp").and_then(|t| t.as_str()));
        match kind {
            "user" => {
                if let Some(text) = extract_user_message_text(&v) {
                    out.push(Message {
                        id: new_message_id(),
                        role: MessageRole::User,
                        mode: MessageMode::Text,
                        content: text,
                        thinking: String::new(),
                        tool_calls: Vec::new(),
                        plan: None,
                        timestamp,
                    });
                }
            }
            "assistant" => {
                let (text, tool_calls) = extract_assistant_blocks(&v);
                if !tool_calls.is_empty() {
                    for tc in tool_calls {
                        out.push(Message {
                            id: new_message_id(),
                            role: MessageRole::Assistant,
                            mode: MessageMode::Tool,
                            content: String::new(),
                            thinking: String::new(),
                            tool_calls: vec![tc],
                            plan: None,
                            timestamp,
                        });
                    }
                }
                if !text.trim().is_empty() {
                    out.push(Message {
                        id: new_message_id(),
                        role: MessageRole::Assistant,
                        mode: MessageMode::Text,
                        content: text,
                        thinking: String::new(),
                        tool_calls: Vec::new(),
                        plan: None,
                        timestamp,
                    });
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

fn parse_timestamp(raw: Option<&str>) -> DateTime<Utc> {
    raw.and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now)
}

pub fn claude_jsonl_path(cwd: &str, session_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let folder = home.join(".claude").join("projects").join(encode_cwd(cwd));
    Some(folder.join(format!("{session_id}.jsonl")))
}

/// Claude Code encodes the project cwd as a folder name by replacing `/` with
/// `-`. E.g. `/Users/adib/Desktop/atlas` → `-Users-adib-Desktop-atlas`.
pub fn encode_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches('/');
    trimmed.replace('/', "-")
}

/// Identify user content injected by Claude Code itself (system tags,
/// interruption notices, warmup pings) rather than typed by the user. Shared
/// with the session-history reader in `src-tauri/commands/claude.rs`.
pub fn is_injected_user_text(t: &str) -> bool {
    let trimmed = t.trim();
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.starts_with('<') {
        return true;
    }
    if trimmed.starts_with("[Request interrupted") {
        return true;
    }
    if trimmed.eq_ignore_ascii_case("warmup") {
        return true;
    }
    false
}

fn extract_user_message_text(v: &serde_json::Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    if let Some(s) = content.as_str() {
        if is_injected_user_text(s) {
            return None;
        }
        return Some(s.trim().to_string());
    }
    if let Some(arr) = content.as_array() {
        let has_tool_result = arr
            .iter()
            .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"));
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

/// Map a Claude Code tool name (as stored in the JSONL transcript) to the ACP
/// `kind` the live stream would have set. Lets reloaded sessions recognise
/// bash/execute calls the same way live ones do (the frontend's bash panel +
/// bash-styled cards key off `kind == "execute"`).
fn tool_kind_for(name: &str) -> Option<String> {
    let k = match name {
        "Bash" | "BashOutput" | "KillShell" => "execute",
        "Read" | "NotebookRead" => "read",
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "edit",
        "Glob" | "Grep" => "search",
        "WebFetch" | "WebSearch" => "fetch",
        _ => return None,
    };
    Some(k.to_string())
}

fn extract_assistant_blocks(v: &serde_json::Value) -> (String, Vec<ToolCall>) {
    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let content = match v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
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
                let name = block
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                let id = block
                    .get("id")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("tc-{}", uuid::Uuid::new_v4().simple()));
                let kind = tool_kind_for(&name);
                tool_calls.push(ToolCall {
                    id,
                    tool_name: name.clone(),
                    title: Some(name),
                    kind,
                    status: ToolCallStatus::Completed,
                    arguments: input,
                    result: None,
                    locations: Vec::new(),
                });
            }
            _ => {}
        }
    }
    (text_parts.join("\n"), tool_calls)
}

