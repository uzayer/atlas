//! Tauri commands specific to the native Cersei agent.
//!
//! The agent itself is driven entirely through the agent-agnostic `agents_*`
//! surface (spawn / new_session / send / set_mode / set_model / …). The only
//! extra surface it needs is listing its own persisted sessions for the chat
//! session sidebar — model/provider selection reuses the frontend's existing
//! BYOK catalog (`review-agents/lib/model-catalog.ts`) + `agents_set_model`
//! with a `"provider/model"` value.

use atlas_agents::{AgentManager, ReplayItem, SessionMeta};
use tauri::State;

/// Stored native-agent sessions for `project_path`, newest first (sidebar).
#[tauri::command]
pub fn cersei_list_sessions(
    project_path: String,
    manager: State<'_, AgentManager>,
) -> Vec<SessionMeta> {
    manager.cersei_list_sessions(&project_path)
}

/// Full transcript (UI-neutral replay items) for one stored native-agent
/// session — drives the Memory tab's Atlas view (transcripts + plans).
#[tauri::command]
pub fn cersei_session_transcript(
    project_path: String,
    session_id: String,
    manager: State<'_, AgentManager>,
) -> Vec<ReplayItem> {
    manager.cersei_session_transcript(&project_path, &session_id)
}
