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
use std::time::Duration;

use atlas_agents::{
    AgentId, AgentInfo, AgentManager, AuthMethodWire, DeltaSink, PermissionDecision, PluginSpec,
    SessionDelta, SessionDeltaEnvelope, SessionId, SessionKey, SessionSnapshot,
};

use super::memory_chat::MemoryChatState;
use super::memory_inject;
use super::memory_pack;
use super::memory_retrieve;
use super::memory_sharing::{MemorySharingState, SummarizerPref};
use super::memory_summarize;
use super::shared_memory::SharedMemoryStore;
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
        // Shared Cross-Agent Memory (v2): capture this delta into the shared
        // event log. Best-effort; a delta for an unregistered session (i.e.
        // before its first `agents_send`) is a silent no-op.
        let store = self.app.state::<SharedMemoryStore>();
        super::memory_delta::ingest(&envelope, store.inner());

        // On turn completion, distill the reply's prose into typed
        // decision/fact/failure/architecture events (off the hot path; no-op
        // unless the project's summarizer is set to a BYOK provider).
        if matches!(envelope.delta, SessionDelta::TurnFinished { .. }) {
            let app = self.app.clone();
            let agent_id = envelope.agent_id.clone();
            let session_id = envelope.session_id.clone();
            tauri::async_runtime::spawn(async move {
                super::memory_compile::compile_finished_turn(&app, agent_id, session_id).await;
            });
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

/// Hard cap on the whole memory-injection path (pack + handoff + summarize) so a
/// slow disk or provider can never stall the user's first message.
const INJECT_BUDGET_SECS: u64 = 8;

/// Send a user message to an agent session.
///
/// On the **first send** of a session — when Shared Cross-Agent Memory is
/// enabled for the project — Atlas prepends a curated memory pack + recent
/// Claude-session handoff so a freshly-switched agent inherits prior context.
/// The injection is best-effort and time-bounded ([`INJECT_BUDGET_SECS`]); on
/// any timeout/error the original `text` is sent unchanged. Turns 2..N skip the
/// build entirely (see [`MemorySharingState::already_sent`]).
#[tauri::command]
pub async fn agents_send(
    key: SessionKey,
    text: String,
    manager: State<'_, AgentManager>,
    sharing: State<'_, MemorySharingState>,
    app: AppHandle,
) -> Result<(), String> {
    // Resolve the project cwd. Unknown session → just send as-is (don't fail
    // the turn on a snapshot miss).
    let Ok(snapshot) = manager.snapshot(&key) else {
        return manager.send(&key, text).map_err(|e| e.to_string());
    };
    let cwd = snapshot.cwd;

    // No cwd or sharing disabled → bare send (no capture, no injection).
    if cwd.is_empty() || !sharing.is_enabled(&cwd) {
        return manager.send(&key, text).map_err(|e| e.to_string());
    }

    // Register this session so the capture path (`TauriDeltaSink::emit`) can
    // route its deltas into the shared event log for the project.
    let store = app.state::<SharedMemoryStore>();
    store.register_session(&key.session_id, &cwd, &snapshot.plugin_id);

    // v2 push: per-turn shared-memory block, gated by this session's sync clock
    // (0 ⇒ first sync = full current state; >0 ⇒ delta since last turn). Cheap
    // in-memory read, so no timeout needed here.
    let clock = sharing.clock_for(&key);
    let shared_block = memory_inject::build_shared_block(store.inner(), &cwd, clock);
    sharing.advance_clock(&key, store.last_seq(&cwd));

    // v3 Tier 2 — retrieval-augmented push: RAG the project's memory index by
    // the user's message, keep only docs not already injected this session, and
    // compose a budgeted `--- RELEVANT PROJECT MEMORY ---` block. `retrieve` is
    // best-effort + time-bounded; a missing embedding model / unbuilt index
    // yields nothing, so this is a no-op until the index exists.
    const INDEX_TOP_K: usize = 3;
    let chat_state = app.state::<MemoryChatState>();
    let mut index_docs =
        memory_retrieve::retrieve(&app, chat_state.inner(), &cwd, &text, INDEX_TOP_K).await;
    index_docs.retain(|d| sharing.note_index_doc(&key, &d.id));
    let index_block = memory_retrieve::compose_index_block(&index_docs);

    // v1 bootstrap: on the very first send only, also prepend the curated pack +
    // recent-session handoff (retained as the clock-0 onboarding layer, bounded
    // by INJECT_BUDGET_SECS inside `build_injection`).
    let base = if !sharing.already_sent(&key) {
        let pref = sharing.summarizer_pref(&cwd);
        let built = build_injection(&app, &cwd, &key.session_id, &pref, &text).await;
        sharing.mark_sent(&key);
        built
    } else {
        text
    };

    // Compose: [working memory] + [relevant index] + (bootstrap +) user text.
    let mut parts: Vec<String> = Vec::new();
    if let Some(b) = shared_block {
        parts.push(b);
    }
    if let Some(b) = index_block {
        parts.push(b);
    }
    let prefixed = if parts.is_empty() {
        base
    } else {
        format!("{}\n\n{}", parts.join("\n\n"), base)
    };
    manager.send(&key, prefixed).map_err(|e| e.to_string())
}

/// Assemble the memory-prefixed message. Everything runs inside a single
/// [`INJECT_BUDGET_SECS`] timeout; on elapse it falls back to the bare text.
async fn build_injection(
    app: &AppHandle,
    cwd: &str,
    session_id: &str,
    pref: &SummarizerPref,
    user_text: &str,
) -> String {
    let cwd = cwd.to_string();
    let session_id = session_id.to_string();

    let built = tokio::time::timeout(Duration::from_secs(INJECT_BUDGET_SECS), async {
        // Curated pack (collect_corpus is async + does its own spawn_blocking).
        let pack = memory_pack::build_memory_pack(&cwd).await;

        // Recent-session handoff: pure disk I/O on a blocking thread.
        let handoff_raw = {
            let cwd = cwd.clone();
            let sid = session_id.clone();
            tokio::task::spawn_blocking(move || memory_pack::build_session_handoff(&cwd, &sid))
                .await
                .ok()
                .flatten()
        };

        let handoff_block = if let Some((raw_body, turns)) = handoff_raw {
            let (body, attribution) = if pref.mode == "provider"
                && !pref.provider.is_empty()
                && !pref.model.is_empty()
            {
                let summary =
                    memory_summarize::summarize(app, &raw_body, &pref.provider, &pref.model).await;
                if summary == raw_body {
                    (raw_body, "raw".to_string())
                } else {
                    (summary, format!("summarized by {}/{}", pref.provider, pref.model))
                }
            } else {
                (raw_body, "raw".to_string())
            };
            Some(memory_pack::wrap_handoff(&body, turns, &attribution))
        } else {
            None
        };

        memory_pack::compose_injection(pack.as_deref(), handoff_block.as_deref(), user_text)
    })
    .await;

    match built {
        Ok(s) => s,
        Err(_) => {
            tracing::warn!(
                target: "atlas::memory_sharing",
                "memory injection exceeded {INJECT_BUDGET_SECS}s budget; sending bare text"
            );
            user_text.to_string()
        }
    }
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
