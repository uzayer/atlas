//! Tauri command surface for `atlas-agents`.
//!
//! Mirrors the high-level multi-agent manager API. The Tauri host owns:
//! - the singleton `AgentManager`
//! - the `DeltaSink` impl that fans `SessionDeltaEnvelope`s out as
//!   `"atlas:agents"` window events
//!
//! The lower-level `acp_*` commands remain registered for now so the legacy
//! direct-ACP frontend keeps working during migration; they will be dropped
//! once the renderer is fully on the new surface.

use std::path::PathBuf;
use std::sync::Arc;

use atlas_agents::{
    AgentId, AgentInfo, AgentManager, DeltaSink, PermissionDecision, PluginSpec, SessionDeltaEnvelope,
    SessionId, SessionKey, SessionSnapshot,
};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

/// Bridge atlas-agents deltas to a single Tauri window event channel.
pub struct TauriDeltaSink {
    app: AppHandle,
}

impl TauriDeltaSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl DeltaSink for TauriDeltaSink {
    fn emit(&self, envelope: SessionDeltaEnvelope) {
        if let Err(e) = self.app.emit("atlas:agents", &envelope) {
            tracing::error!(target: "atlas_agents::emit", "failed to emit atlas:agents event: {e}");
        }
    }
}

/// Initialise the `AgentManager` once the Tauri app is up so the sink has a
/// real `AppHandle` to emit through. Called from `setup`.
pub fn install_manager(app: &AppHandle) {
    let sink: Arc<dyn DeltaSink> = Arc::new(TauriDeltaSink::new(app.clone()));
    let manager = AgentManager::new(sink);
    app.manage(manager);
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn agents_list_plugins(manager: State<'_, AgentManager>) -> Vec<PluginSpec> {
    manager.list_plugins()
}

#[tauri::command]
pub fn agents_list_running(manager: State<'_, AgentManager>) -> Vec<AgentInfo> {
    manager.list_agents()
}

#[tauri::command]
pub async fn agents_spawn(
    plugin_id: String,
    manager: State<'_, AgentManager>,
) -> Result<AgentInfo, String> {
    manager.spawn(&plugin_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_kill(agent_id: AgentId, manager: State<'_, AgentManager>) -> Result<(), String> {
    manager.kill(agent_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agents_new_session(
    agent_id: AgentId,
    cwd: PathBuf,
    manager: State<'_, AgentManager>,
) -> Result<SessionKey, String> {
    manager
        .new_session(agent_id, cwd)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agents_load_session(
    agent_id: AgentId,
    session_id: SessionId,
    cwd: PathBuf,
    manager: State<'_, AgentManager>,
) -> Result<SessionKey, String> {
    manager
        .load_session(agent_id, session_id, cwd)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_snapshot(
    key: SessionKey,
    manager: State<'_, AgentManager>,
) -> Result<SessionSnapshot, String> {
    manager.snapshot(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_send(
    key: SessionKey,
    text: String,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager.send(&key, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_cancel(key: SessionKey, manager: State<'_, AgentManager>) -> Result<(), String> {
    manager.cancel(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_set_mode(
    key: SessionKey,
    mode_id: String,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager.set_mode(&key, mode_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_set_model(
    key: SessionKey,
    model_id: String,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager.set_model(&key, model_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_respond_permission(
    agent_id: AgentId,
    session_id: String,
    request_id: Uuid,
    decision: PermissionDecision,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager
        .respond_permission(agent_id, &session_id, request_id, decision)
        .map_err(|e| e.to_string())
}
