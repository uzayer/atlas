//! Per-session state owned by the Rust side.
//!
//! `SessionState` is mutable, lives behind a `parking_lot::Mutex`, and is
//! mutated by:
//! - the manager's `EventSink` impl when ACP notifications arrive
//! - the per-session worker when send / cancel / mode-change commands run
//!
//! `SessionSnapshot` is the serialisable wire shape — produced on demand for
//! tab-activate, never streamed.

use agent_client_protocol::schema as acp_schema;
use atlas_acp::AgentId;
use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    Running,
    Waiting,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageMode {
    Text,
    Tool,
    Thinking,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCall {
    pub id: String,
    pub tool_name: String,
    pub title: Option<String>,
    pub kind: Option<String>,
    pub status: ToolCallStatus,
    pub arguments: serde_json::Value,
    pub result: Option<String>,
    pub locations: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct PlanEntry {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub priority: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub id: String,
    pub role: MessageRole,
    pub mode: MessageMode,
    pub content: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub thinking: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<Vec<PlanEntry>>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    /// Estimated cumulative cost in USD (native agent; 0 when unknown).
    #[serde(default)]
    pub cost: f64,
}

/// One ACP-advertised session mode (e.g. Codex's read-only / auto / full-access).
/// Sourced from the `modes` blob in `session/new` and `session/load` responses.
#[derive(Debug, Clone, Serialize)]
pub struct SessionModeInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSnapshot {
    pub agent_id: AgentId,
    pub session_id: String,
    pub cwd: String,
    pub plugin_id: String,
    pub status: SessionStatus,
    pub current_mode: Option<String>,
    pub current_model: Option<String>,
    /// The full set of modes the agent advertised for this session. Empty for
    /// agents that don't expose modes; drives the composer's mode picker.
    pub available_modes: Vec<SessionModeInfo>,
    /// Models the agent advertised (ACP `session/new` `models` blob, reused
    /// shape: id/name/description). Empty when the agent exposes no model
    /// selection; drives the composer's model picker for Claude Code / Codex.
    pub available_models: Vec<SessionModeInfo>,
    pub available_commands: Vec<serde_json::Value>,
    pub plan: Vec<PlanEntry>,
    pub messages: Vec<Message>,
    pub usage: Usage,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Mutable session state. Held inside `Arc<Mutex<SessionState>>`.
pub struct SessionState {
    pub agent_id: AgentId,
    pub session_id: String,
    pub cwd: String,
    pub plugin_id: String,
    pub status: SessionStatus,
    pub current_mode: Option<String>,
    pub current_model: Option<String>,
    pub available_modes: Vec<SessionModeInfo>,
    pub available_models: Vec<SessionModeInfo>,
    pub available_commands: Vec<serde_json::Value>,
    pub plan: Vec<PlanEntry>,
    pub messages: Vec<Message>,
    pub usage: Usage,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Monotonic counter bumped each time an inbound agent update is applied
    /// (text/thinking chunk, tool call, plan, …). The worker samples it after
    /// `send_prompt` returns to detect when the ACP notification stream has
    /// gone quiet before flipping the turn to idle — closing the cross-task
    /// race where the prompt response resolves a beat before the agent's final
    /// streamed chunk lands. Not part of the serialised snapshot.
    pub activity_seq: u64,
    /// Monotonic turn identity, bumped at the START of every turn (worker's
    /// `handle_send`). Stamped onto every emitted delta so the frontend can
    /// reject a stale terminal (idle/error) delta belonging to a turn that has
    /// already been superseded by a newer send — the real safety net against
    /// premature-idle under parallel / queued / wake-timing races. Not
    /// serialised into the snapshot.
    pub turn_seq: u64,
    /// Set by the manager's ACP dispatch when the agent reports a turn failure
    /// out-of-band (an `AcpEvent::TurnFailed` that isn't already surfaced as the
    /// `send_prompt` `Err`). The worker drains it when emitting terminal state
    /// so terminal status has a single writer (the worker). Not serialised.
    pub pending_turn_error: Option<String>,
}

impl SessionState {
    pub fn new(agent_id: AgentId, session_id: String, cwd: String, plugin_id: String) -> Self {
        let now = Utc::now();
        Self {
            agent_id,
            session_id,
            cwd,
            plugin_id,
            status: SessionStatus::Idle,
            current_mode: None,
            current_model: None,
            available_modes: Vec::new(),
            available_models: Vec::new(),
            available_commands: Vec::new(),
            plan: Vec::new(),
            messages: Vec::new(),
            usage: Usage::default(),
            created_at: now,
            updated_at: now,
            activity_seq: 0,
            turn_seq: 0,
            pending_turn_error: None,
        }
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            agent_id: self.agent_id,
            session_id: self.session_id.clone(),
            cwd: self.cwd.clone(),
            plugin_id: self.plugin_id.clone(),
            status: self.status,
            current_mode: self.current_mode.clone(),
            current_model: self.current_model.clone(),
            available_modes: self.available_modes.clone(),
            available_models: self.available_models.clone(),
            available_commands: self.available_commands.clone(),
            plan: self.plan.clone(),
            messages: self.messages.clone(),
            usage: self.usage.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = Utc::now();
    }
}

// ── Helpers reused by the manager + worker ───────────────────────────────────

pub fn new_message_id() -> String {
    format!("msg-{}", Uuid::new_v4().simple())
}

pub fn new_assistant_text(content: String) -> Message {
    Message {
        id: new_message_id(),
        role: MessageRole::Assistant,
        mode: MessageMode::Text,
        content,
        thinking: String::new(),
        tool_calls: Vec::new(),
        plan: None,
        timestamp: Utc::now(),
    }
}

pub fn new_assistant_thinking(thinking: String) -> Message {
    Message {
        id: new_message_id(),
        role: MessageRole::Assistant,
        mode: MessageMode::Thinking,
        content: String::new(),
        thinking,
        tool_calls: Vec::new(),
        plan: None,
        timestamp: Utc::now(),
    }
}

pub fn new_assistant_tool(tool_call: ToolCall) -> Message {
    Message {
        id: new_message_id(),
        role: MessageRole::Assistant,
        mode: MessageMode::Tool,
        content: String::new(),
        thinking: String::new(),
        tool_calls: vec![tool_call],
        plan: None,
        timestamp: Utc::now(),
    }
}

pub fn new_user_message(content: String) -> Message {
    Message {
        id: new_message_id(),
        role: MessageRole::User,
        mode: MessageMode::Text,
        content,
        thinking: String::new(),
        tool_calls: Vec::new(),
        plan: None,
        timestamp: Utc::now(),
    }
}

pub fn map_tool_status(raw: Option<&str>, fallback: ToolCallStatus) -> ToolCallStatus {
    match raw {
        Some("pending") => ToolCallStatus::Pending,
        Some("in_progress") => ToolCallStatus::Running,
        Some("completed") => ToolCallStatus::Completed,
        Some("failed") => ToolCallStatus::Failed,
        _ => fallback,
    }
}

/// `rawInput` from the canonical Claude Code agent is sometimes a JSON object,
/// sometimes a stringified object. Normalise to a `Value`.
pub fn normalise_tool_input(raw: Option<&serde_json::Value>) -> serde_json::Value {
    match raw {
        Some(serde_json::Value::String(s)) => {
            serde_json::from_str(s).unwrap_or_else(|_| serde_json::json!({ "raw": s }))
        }
        Some(v) => v.clone(),
        None => serde_json::Value::Object(serde_json::Map::new()),
    }
}

/// Tool-call `content` blocks → flat string suitable for the existing
/// ToolCallCard "result" display. Mirrors the frontend's `formatToolContent`.
pub fn format_tool_content(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().filter_map(format_tool_content).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        serde_json::Value::Object(o) => {
            if let Some(inner) = o.get("content") {
                if let Some(s) = format_tool_content(inner) {
                    return Some(s);
                }
            }
            if let Some(serde_json::Value::String(s)) = o.get("text") {
                return Some(s.clone());
            }
            if let Some(serde_json::Value::String(s)) = o.get("output") {
                return Some(s.clone());
            }
            if let Some(serde_json::Value::String(p)) = o.get("path") {
                if o.contains_key("oldText") || o.contains_key("newText") {
                    return Some(p.clone());
                }
            }
            None
        }
        _ => None,
    }
}

/// Pull the `text` field out of an `agent_message_chunk` / `agent_thought_chunk`
/// ContentBlock. Returns `None` for non-text blocks (images, etc.).
pub fn extract_text_block(content: &acp_schema::ContentBlock) -> Option<String> {
    // ContentBlock is #[non_exhaustive] in the schema; round-trip through JSON.
    let v = serde_json::to_value(content).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("text") {
        return None;
    }
    v.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
}
