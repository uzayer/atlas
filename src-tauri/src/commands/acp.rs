//! Tauri command surface for the ACP integration.
//!
//! Phase 1 — minimal surface to drive a single agent / single session: spawn,
//! list, kill, new_session, send_prompt, cancel_turn, respond_permission.
//! Multi-agent / team UX layers on top of this without changes here.

use std::path::PathBuf;
use std::sync::Arc;

use atlas_acp::{
    AcpEvent, AgentId, AgentInfo, AgentRegistry, AgentSpec, EventSink, NewSessionInfo,
    PermissionDecision, SessionId, StopReason,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

/// Bridge atlas-acp events to Tauri window events.
pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[derive(Serialize, Clone)]
struct AcpEventEnvelope<'a> {
    agent_id: AgentId,
    #[serde(flatten)]
    event: &'a AcpEvent,
}

impl EventSink for TauriEventSink {
    fn emit(&self, agent_id: AgentId, event: AcpEvent) {
        let envelope = AcpEventEnvelope {
            agent_id,
            event: &event,
        };
        if let Err(e) = self.app.emit("atlas:acp", &envelope) {
            tracing::error!(target: "atlas_acp::emit", "failed to emit atlas:acp event: {e}");
        }
    }
}

// -- Commands -----------------------------------------------------------------

#[tauri::command]
pub fn acp_known_specs() -> Vec<AgentSpec> {
    AgentRegistry::known_specs()
}

#[tauri::command]
pub fn acp_list_agents(registry: State<'_, AgentRegistry>) -> Vec<AgentInfo> {
    registry.list()
}

#[tauri::command]
pub async fn acp_spawn_agent(
    spec_id: String,
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
) -> Result<AgentInfo, String> {
    let sink: Arc<dyn EventSink> = Arc::new(TauriEventSink::new(app));
    registry
        .spawn(&spec_id, sink)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn acp_kill_agent(
    agent_id: AgentId,
    registry: State<'_, AgentRegistry>,
) -> Result<(), String> {
    registry.kill(agent_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn acp_new_session(
    agent_id: AgentId,
    cwd: PathBuf,
    registry: State<'_, AgentRegistry>,
) -> Result<NewSessionInfo, String> {
    registry
        .new_session(agent_id, cwd)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn acp_send_prompt(
    agent_id: AgentId,
    session_id: SessionId,
    text: String,
    registry: State<'_, AgentRegistry>,
) -> Result<StopReason, String> {
    registry
        .send_prompt(agent_id, session_id, text)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn acp_cancel_turn(
    agent_id: AgentId,
    session_id: SessionId,
    registry: State<'_, AgentRegistry>,
) -> Result<(), String> {
    registry
        .cancel_turn(agent_id, session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn acp_respond_permission(
    agent_id: AgentId,
    request_id: Uuid,
    decision: PermissionDecision,
    registry: State<'_, AgentRegistry>,
) -> Result<(), String> {
    registry
        .respond_permission(agent_id, request_id, decision)
        .map_err(|e| e.to_string())
}
