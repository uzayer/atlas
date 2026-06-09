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
use std::process::Stdio;
use std::sync::Arc;

use atlas_agents::{
    AgentId, AgentInfo, AgentManager, AuthMethodWire, DeltaSink, PermissionDecision, PluginSpec,
    SessionDeltaEnvelope, SessionId, SessionKey, SessionSnapshot,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as AsyncCommand;
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

/// Whether Codex has stored credentials (`~/.codex/auth.json` exists). Drives
/// the "Sign in with ChatGPT" prompt on a Codex chat. Cheap file check.
#[tauri::command]
pub fn codex_status() -> bool {
    dirs::home_dir()
        .map(|h| h.join(".codex").join("auth.json").is_file())
        .unwrap_or(false)
}

/// Run an agent's ACP `authenticate` flow (e.g. Codex's "chatgpt" browser
/// OAuth). Awaits until the agent reports success — for Codex this resolves
/// once the OpenAI sign-in completes and `~/.codex/auth.json` is written.
#[tauri::command]
pub async fn agents_authenticate(
    agent_id: AgentId,
    method_id: String,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager
        .authenticate(agent_id, method_id)
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

// ── Auth methods ────────────────────────────────────────────────────────────
//
// The ACP adapter (claude-agent-acp) advertises its supported auth methods
// in the `initialize` response. We pull those out of the driver and let the
// frontend render a chooser populated from whatever the adapter actually
// supports. When the user picks one, `agents_run_auth_method` spawns the
// adapter-supplied subprocess (`process.execPath ... --cli auth login
// --claudeai` for the Subscription path) — that vendored CLI runs the
// localhost-loopback OAuth flow, opens the browser, catches the callback,
// writes credentials. The host's only job is to spawn the spec.

#[tauri::command]
pub fn agents_list_auth_methods(
    agent_id: AgentId,
    manager: State<'_, AgentManager>,
) -> Result<Vec<AuthMethodWire>, String> {
    manager.auth_methods(agent_id).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
struct AuthRunDone {
    success: bool,
    exit_code: Option<i32>,
    message: Option<String>,
}

#[tauri::command]
pub async fn agents_run_auth_method(
    agent_id: AgentId,
    method_id: String,
    app: AppHandle,
) -> Result<(), String> {
    let manager: State<'_, AgentManager> = app.state();
    let methods = manager.auth_methods(agent_id).map_err(|e| e.to_string())?;
    let method = methods
        .into_iter()
        .find(|m| m.id == method_id)
        .ok_or_else(|| format!("auth method not found: {method_id}"))?;

    let command = method
        .terminal_command
        .ok_or_else(|| format!("auth method {method_id} has no terminal-auth spec"))?;
    let args = method.terminal_args.unwrap_or_default();

    tracing::info!(
        target: "atlas::agents",
        "running auth method `{method_id}` via `{command}` (args: {args:?})"
    );

    let mut cmd = AsyncCommand::new(&command);
    cmd.args(&args);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn `{command}`: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_for_stdout = app.clone();
    if let Some(out) = stdout {
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "atlas::agents::auth_stdout", "{line}");
                let _ = app_for_stdout.emit(
                    "atlas:auth-run:progress",
                    serde_json::json!({ "stream": "stdout", "line": line }),
                );
            }
        });
    }
    let app_for_stderr = app.clone();
    if let Some(err) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "atlas::agents::auth_stderr", "{line}");
                let _ = app_for_stderr.emit(
                    "atlas:auth-run:progress",
                    serde_json::json!({ "stream": "stderr", "line": line }),
                );
            }
        });
    }

    let app_for_wait = app.clone();
    tokio::spawn(async move {
        let result = child.wait().await;
        let payload = match result {
            Ok(status) => AuthRunDone {
                success: status.success(),
                exit_code: status.code(),
                message: if status.success() {
                    None
                } else {
                    Some(format!(
                        "auth subprocess exited with code {}",
                        status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into())
                    ))
                },
            },
            Err(e) => AuthRunDone {
                success: false,
                exit_code: None,
                message: Some(format!("wait failed: {e}")),
            },
        };
        let _ = app_for_wait.emit("atlas:auth-run:done", payload);
    });

    Ok(())
}
