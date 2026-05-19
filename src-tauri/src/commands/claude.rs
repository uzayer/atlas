//! Session-history readers against `~/.claude/projects/<encoded-cwd>/*.jsonl`.
//!
//! Both the legacy Claude Code CLI (no longer wired into Atlas) and the
//! canonical ACP agent (`@zed-industries/claude-code-acp`, which sits on top
//! of the Claude Agent SDK) write their session transcripts here, so the
//! sidebar's history browser keeps working against the ACP-driven flow.
//!
//! Anything related to *running* Claude — `claude_run`, `claude_stream`,
//! `claude_stop`, etc. — was removed once the ACP integration replaced it.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::State;

/// Per-file metadata cache keyed by JSONL path. The cached entry is reused
/// when the file's mtime matches what we last saw — the same path with a
/// newer mtime is re-parsed in a single pass.
///
/// Process-lifetime; the file watcher invalidates *frontend* queries (which
/// causes a re-call into this function), but the cache stays warm for files
/// that didn't actually change. Net effect: rapid sidebar refreshes during a
/// streaming turn only re-parse the one file that's actually growing.
#[derive(Default)]
pub struct ClaudeSessionIndex {
    inner: Mutex<HashMap<PathBuf, CacheEntry>>,
}

impl ClaudeSessionIndex {
    pub fn new() -> Self {
        Self::default()
    }
}

struct CacheEntry {
    mtime: SystemTime,
    meta: ClaudeSessionMeta,
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

fn extract_timestamp(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    v.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string())
}

#[tauri::command]
pub async fn list_claude_sessions(
    cwd: String,
    index: State<'_, ClaudeSessionIndex>,
) -> Result<Vec<ClaudeSessionMeta>, String> {
    // `index` is the Tauri-managed cache. We snapshot the relevant entries
    // out of it before doing any blocking I/O, then re-acquire the lock to
    // store updated results, so the cache mutex is never held across the
    // disk walk.
    let cache_snapshot: HashMap<PathBuf, CacheEntry> = {
        let guard = index.inner.lock();
        guard
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    CacheEntry {
                        mtime: v.mtime,
                        meta: v.meta.clone(),
                    },
                )
            })
            .collect()
    };

    let (out, fresh_entries) = tokio::task::spawn_blocking(
        move || -> Result<(Vec<ClaudeSessionMeta>, Vec<(PathBuf, SystemTime, ClaudeSessionMeta)>), String> {
            let folder = projects_dir()?.join(encode_cwd(&cwd));
            if !folder.exists() {
                return Ok((Vec::new(), Vec::new()));
            }

            let mut out: Vec<ClaudeSessionMeta> = Vec::new();
            let mut fresh: Vec<(PathBuf, SystemTime, ClaudeSessionMeta)> = Vec::new();

            for entry in std::fs::read_dir(&folder).map_err(|e| e.to_string())? {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }

                let id = match path.file_stem().and_then(|s| s.to_str()) {
                    Some(s) if !s.is_empty() => s.to_string(),
                    _ => continue,
                };
                // Skip Claude Code's internal sub-agent / warmup session files.
                if id.starts_with("agent-") {
                    continue;
                }

                let metadata = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let mtime = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);

                // Cache hit on unchanged mtime — reuse the parsed metadata
                // without re-reading the file. This is the win during a
                // streaming turn: only the one growing JSONL re-parses, all
                // the historical ones short-circuit here.
                if let Some(prev) = cache_snapshot.get(&path) {
                    if prev.mtime == mtime {
                        out.push(prev.meta.clone());
                        continue;
                    }
                }

                let Some(meta) = parse_session_file(&path, &id, mtime) else {
                    continue;
                };
                out.push(meta.clone());
                fresh.push((path, mtime, meta));
            }

            out.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
            Ok((out, fresh))
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    // Stuff freshly-parsed entries back into the cache. Entries for files
    // that disappeared get pruned so stale rows don't linger forever.
    {
        let mut guard = index.inner.lock();
        let present_paths: std::collections::HashSet<PathBuf> = out
            .iter()
            .map(|m| PathBuf::from(&m.file_path))
            .collect();
        guard.retain(|k, _| present_paths.contains(k));
        for (path, mtime, meta) in fresh_entries {
            guard.insert(path, CacheEntry { mtime, meta });
        }
    }

    Ok(out)
}

/// Single-pass JSONL parse: started_at, preview, message_count, sidechain
/// detection all from one read of the file. Returns `None` if the file is a
/// sidechain-only transcript (skipped) or unreadable.
fn parse_session_file(
    path: &Path,
    id: &str,
    mtime: SystemTime,
) -> Option<ClaudeSessionMeta> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut started_at: Option<String> = None;
    let mut preview: Option<String> = None;
    let mut message_count = 0usize;
    let mut saw_main = false;
    let mut saw_sidechain = false;
    let mut classified_lines = 0usize;

    for line in reader.lines().flatten() {
        // Sidechain detection samples the first ~30 records, matching the
        // pre-refactor `jsonl_is_sidechain` heuristic.
        if classified_lines < 30 {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                match v.get("isSidechain").and_then(|x| x.as_bool()) {
                    Some(true) => saw_sidechain = true,
                    Some(false) => saw_main = true,
                    None => {}
                }
                classified_lines += 1;
            }
        }
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

    if saw_sidechain && !saw_main {
        return None;
    }

    let last_modified = {
        let dt: chrono::DateTime<chrono::Utc> = mtime.into();
        Some(dt.to_rfc3339())
    };

    Some(ClaudeSessionMeta {
        id: id.to_string(),
        file_path: path.to_string_lossy().to_string(),
        started_at,
        last_modified,
        message_count,
        preview: preview.unwrap_or_else(|| "(no user message)".to_string()),
    })
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
