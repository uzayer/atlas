//! Multi-agent / multi-session orchestrator.
//!
//! Wraps `atlas_acp::AgentRegistry` and adds:
//! - per-session state (`SessionState`)
//! - per-session worker tasks (non-blocking send-prompt)
//! - replay-on-attach for plugins with persistent transcripts
//! - a single `EventSink` impl that routes ACP notifications to the right
//!   session and emits structured `SessionDelta` events to the UI

use std::path::PathBuf;
use std::sync::Arc;

use atlas_acp::{
    AcpEvent, AgentId, AgentInfo, AgentRegistry, AuthMethodWire, EventSink, NewSessionInfo,
    PermissionDecision, SessionId,
};
use dashmap::DashMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::backend::{AcpBackend, AgentBackend, CerseiBackend};
use crate::error::{Error, Result};
use crate::events::{DeltaSink, Emitter, SessionDelta, SessionDeltaEnvelope};
use crate::plugin::{PluginSpec, TranscriptKind, builtin_plugins, find_plugin};
use crate::session::{
    Message, SessionModeInfo, SessionSnapshot, SessionState, SessionStatus, ToolCall,
    ToolCallStatus, new_assistant_text, new_assistant_thinking, new_assistant_tool,
};
use crate::handle::SessionHandle;
use crate::transcript;

/// Per-session key: (`agent_id`, raw acp session id string).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionKey {
    pub agent_id: AgentId,
    pub session_id: String,
}

#[derive(Clone)]
pub struct AgentManager {
    inner: Arc<ManagerInner>,
}

struct ManagerInner {
    acp: AgentRegistry,
    cersei: atlas_cersei::CerseiRuntime,
    sessions: DashMap<SessionKey, Arc<SessionHandle>>,
    agent_plugins: DashMap<AgentId, String>,
    /// Per-agent backend (ACP subprocess vs in-process Cersei), chosen at spawn.
    agent_backends: DashMap<AgentId, Arc<dyn AgentBackend>>,
    /// Single outbound fan-out: publishes every delta to the global event bus
    /// and the host sink.
    emitter: Arc<Emitter>,
}

impl AgentManager {
    /// `config_dir` is the app config dir (holds `byok-keys.json` +
    /// `cersei-sessions/`); the native agent reads keys + persists sessions there.
    pub fn new(sink: Arc<dyn DeltaSink>, config_dir: std::path::PathBuf) -> Self {
        Self {
            inner: Arc::new(ManagerInner {
                acp: AgentRegistry::new(),
                cersei: atlas_cersei::CerseiRuntime::new(config_dir),
                sessions: DashMap::new(),
                agent_plugins: DashMap::new(),
                agent_backends: DashMap::new(),
                emitter: Arc::new(Emitter::new(sink)),
            }),
        }
    }

    /// Subscribe to the global event bus — every session delta, in wire order,
    /// for any in-process (or, later, cloud) consumer. The host's window
    /// fan-out and the ACP-sink path are unaffected.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<SessionDeltaEnvelope> {
        self.inner.emitter.subscribe()
    }

    pub fn list_plugins(&self) -> Vec<PluginSpec> {
        builtin_plugins()
    }

    pub fn list_agents(&self) -> Vec<AgentInfo> {
        self.inner.acp.list()
    }

    /// Spawn a plugin and register the resulting agent. ACP plugins launch a
    /// subprocess; the native `cersei` plugin is registered in-process.
    pub async fn spawn(&self, plugin_id: &str) -> Result<AgentInfo> {
        let plugin = find_plugin(plugin_id).ok_or_else(|| Error::UnknownPlugin(plugin_id.into()))?;
        let event_sink: Arc<dyn EventSink> = Arc::new(self.clone());

        let (info, backend): (AgentInfo, Arc<dyn AgentBackend>) =
            if plugin.plugin_id == atlas_cersei::CERSEI_PLUGIN_ID {
                let info = self.inner.cersei.spawn(event_sink);
                (info, Arc::new(CerseiBackend(self.inner.cersei.clone())))
            } else {
                let info = self.inner.acp.spawn(&plugin.plugin_id, event_sink).await?;
                (info, Arc::new(AcpBackend(self.inner.acp.clone())))
            };

        self.inner
            .agent_plugins
            .insert(info.agent_id, plugin.plugin_id);
        self.inner.agent_backends.insert(info.agent_id, backend);
        Ok(info)
    }

    fn backend_for(&self, agent_id: AgentId) -> Result<Arc<dyn AgentBackend>> {
        self.inner
            .agent_backends
            .get(&agent_id)
            .map(|e| e.value().clone())
            .ok_or(Error::Acp(atlas_acp::AcpError::UnknownAgent))
    }

    /// Auth methods the agent advertised during `initialize` — surfaced
    /// to the UI so it can render a chooser populated from whatever the
    /// adapter actually supports (Claude Subscription, Anthropic Console,
    /// SSO, etc.) without hard-coding labels.
    pub fn auth_methods(&self, agent_id: AgentId) -> Result<Vec<AuthMethodWire>> {
        Ok(self.backend_for(agent_id)?.auth_methods(agent_id)?)
    }

    /// Run the agent's ACP `authenticate` flow for `method_id` (e.g. Codex's
    /// "chatgpt" browser OAuth). Used by agents whose auth methods don't ship a
    /// terminal command (so the terminal-subprocess path doesn't apply).
    pub async fn authenticate(&self, agent_id: AgentId, method_id: String) -> Result<()> {
        self.backend_for(agent_id)?.authenticate(agent_id, method_id).await?;
        Ok(())
    }

    pub fn kill(&self, agent_id: AgentId) -> Result<()> {
        // Tear down any sessions owned by this agent first (drops their cmd
        // channels which makes the worker tasks exit).
        let to_remove: Vec<SessionKey> = self
            .inner
            .sessions
            .iter()
            .filter(|e| e.value().agent_id == agent_id)
            .map(|e| e.key().clone())
            .collect();
        for key in to_remove {
            self.inner.sessions.remove(&key);
        }
        self.inner.agent_plugins.remove(&agent_id);
        let backend = self.backend_for(agent_id)?;
        self.inner.agent_backends.remove(&agent_id);
        backend.kill(agent_id)?;
        Ok(())
    }

    /// Open a fresh session and spawn a worker for it.
    pub async fn new_session(&self, agent_id: AgentId, cwd: PathBuf) -> Result<SessionKey> {
        let cwd_str = cwd.to_string_lossy().into_owned();
        let plugin_id = self.plugin_id_for(agent_id)?;
        let resp: NewSessionInfo = self.backend_for(agent_id)?.new_session(agent_id, cwd).await?;
        let session_id_str = serde_json::to_value(&resp.session_id)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        let key = SessionKey {
            agent_id,
            session_id: session_id_str.clone(),
        };
        self.install_session(
            key.clone(),
            resp.session_id,
            cwd_str,
            plugin_id,
            Vec::new(),
            resp.modes,
            resp.models,
        );
        Ok(key)
    }

    /// Resume a previously-saved session; replays its transcript into the new
    /// `SessionState` so the UI sees full history immediately.
    ///
    /// **Idempotent.** If a session with this `(agent_id, session_id)` is
    /// already loaded, returns the existing key without re-replaying the
    /// transcript or re-issuing `acp.load_session`. This is what makes the
    /// manager the canonical transcript cache: the second sidebar click on
    /// the same session is a `DashMap::get` away from instant, with no disk
    /// I/O and no ACP round-trip. Frontend can call `agents.loadSession`
    /// freely without worrying about duplicate work.
    pub async fn load_session(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        cwd: PathBuf,
    ) -> Result<SessionKey> {
        let session_id_str = serde_json::to_value(&session_id)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        let key = SessionKey {
            agent_id,
            session_id: session_id_str.clone(),
        };

        // Cache hit: session is already loaded — return immediately.
        if self.inner.sessions.contains_key(&key) {
            return Ok(key);
        }

        let cwd_str = cwd.to_string_lossy().into_owned();
        let plugin_id = self.plugin_id_for(agent_id)?;
        let plugin = find_plugin(&plugin_id).ok_or_else(|| Error::UnknownPlugin(plugin_id.clone()))?;

        if plugin.transcript == TranscriptKind::CerseiJson {
            // Native agent: the runtime persists its own JSON transcript. Build
            // the UI seed messages from it, restore the runtime's history (so a
            // follow-up turn keeps context), then install.
            let seeds = cersei_replay_to_messages(
                self.inner.cersei.replay_session(&cwd_str, &session_id_str),
            );
            let modes = self
                .backend_for(agent_id)?
                .load_session(agent_id, session_id.clone(), cwd)
                .await?;
            if self.inner.sessions.contains_key(&key) {
                return Ok(key);
            }
            self.install_session(key.clone(), session_id, cwd_str, plugin_id, seeds, modes, None);
            return Ok(key);
        }

        if plugin.transcript == TranscriptKind::None {
            // Transcript-less plugins (Codex) have no on-disk format Atlas can
            // parse. Instead the agent REPLAYS the conversation to us via
            // `session/update` notifications DURING `acp.load_session` — and
            // those are dropped unless a `SessionState` already exists to route
            // them to (`dispatch` → `find_session_by_acp_id`). So install the
            // session FIRST (empty), then load: the replay lands in the state.
            self.install_session(
                key.clone(),
                session_id.clone(),
                cwd_str,
                plugin_id,
                Vec::new(),
                None,
                None,
            );
            match self.backend_for(agent_id)?.load_session(agent_id, session_id, cwd).await {
                Ok(modes) => {
                    self.seed_modes(&key, modes);
                    Ok(key)
                }
                Err(e) => {
                    // Roll back the phantom session so a failed resume doesn't
                    // leave a dead, message-less tab bound to nothing.
                    self.inner.sessions.remove(&key);
                    Err(e.into())
                }
            }
        } else {
            // Disk-backed (Claude): replay the JSONL synchronously into seed
            // messages, THEN install. ACP load happens after replay so the
            // worker is ready for a follow-up `send_prompt`; the resumed
            // session's advertised modes come back here.
            let seeds = transcript::replay(plugin.transcript, &cwd_str, &session_id_str).await?;
            let modes = self
                .backend_for(agent_id)?
                .load_session(agent_id, session_id.clone(), cwd)
                .await?;

            // Re-check after the awaits — another concurrent caller may have
            // installed the same session while we were doing I/O.
            if self.inner.sessions.contains_key(&key) {
                return Ok(key);
            }

            self.install_session(key.clone(), session_id, cwd_str, plugin_id, seeds, modes, None);
            Ok(key)
        }
    }

    /// Apply a `session/load` | `session/new` `modes` blob onto an
    /// already-installed session's state (used by the transcript-less resume
    /// path, where the session is installed before the modes are known).
    fn seed_modes(&self, key: &SessionKey, modes: Option<serde_json::Value>) {
        let (Some(modes), Ok(handle)) = (modes, self.handle_for(key)) else {
            return;
        };
        let (current, available) = parse_session_modes(&modes);
        let mut st = handle.state.lock();
        if let Some(c) = current {
            st.current_mode = Some(c);
        }
        if !available.is_empty() {
            st.available_modes = available;
        }
    }

    /// Stored native-agent sessions for a project (chat session sidebar).
    ///
    /// The stored first-user message carries Atlas-injected context (memory
    /// blocks, mention bodies). Strip that scaffolding from the preview/title
    /// here — on the FULL text — then truncate, so the sidebar shows the user's
    /// actual question instead of a "New session" fallback.
    pub fn cersei_list_sessions(&self, cwd: &str) -> Vec<atlas_cersei::SessionMeta> {
        let mut metas = self.inner.cersei.list_sessions(cwd);
        for m in &mut metas {
            let cleaned = crate::transcript::strip_injected_context(&m.preview);
            let cleaned = cleaned.trim();
            if !cleaned.is_empty() {
                m.preview = cleaned.chars().take(80).collect();
            } else {
                // Nothing but injected scaffolding — keep a sane truncation of
                // the raw text rather than an empty title.
                m.preview = m.preview.chars().take(80).collect();
            }
        }
        metas
    }

    /// UI-neutral transcript for a stored native-agent session (Memory tab).
    pub fn cersei_session_transcript(&self, cwd: &str, session_id: &str) -> Vec<atlas_cersei::ReplayItem> {
        self.inner.cersei.replay_session(cwd, session_id)
    }

    /// Delete a stored native-agent session's transcript (sidebar delete).
    pub fn cersei_delete_session(
        &self,
        cwd: &str,
        session_id: &str,
    ) -> std::result::Result<(), String> {
        self.inner.cersei.delete_session(cwd, session_id)
    }

    pub fn snapshot(&self, key: &SessionKey) -> Result<SessionSnapshot> {
        let handle = self.handle_for(key)?;
        let snap = handle.state.lock().snapshot();
        Ok(snap)
    }

    pub fn send(&self, key: &SessionKey, text: String) -> Result<()> {
        self.handle_for(key)?.send_prompt(text)
    }

    /// Cancel an in-flight turn. The actor services this on its control channel
    /// ahead of any queued work (`biased` select), calls the connection's
    /// `cancel`, and the turn's own terminal (`stop_reason = "cancelled"`) then
    /// flows through the FIFO and finalizes the UI.
    pub fn cancel(&self, key: &SessionKey) -> Result<()> {
        self.handle_for(key)?.cancel()
    }

    pub fn set_mode(&self, key: &SessionKey, mode_id: String) -> Result<()> {
        self.handle_for(key)?.set_mode(mode_id)
    }

    pub fn set_model(&self, key: &SessionKey, model_id: String) -> Result<()> {
        self.handle_for(key)?.set_model(model_id)
    }

    pub fn set_effort(&self, key: &SessionKey, effort: String) -> Result<()> {
        self.handle_for(key)?.set_effort(effort)
    }

    pub fn set_compress(&self, key: &SessionKey, on: bool) -> Result<()> {
        self.handle_for(key)?.set_compress(on)
    }

    /// Resolve a pending permission request.
    ///
    /// MUST bypass the worker's command queue. The worker spends an
    /// in-flight turn `await`ing `send_prompt`, and `send_prompt` won't
    /// return until *this* permission is resolved on the registry side —
    /// queueing the response would deadlock the turn (the worker can't
    /// pop the command until send_prompt returns, send_prompt can't
    /// return until the permission is responded). Same reasoning the
    /// worker.rs comment documents for `cancel`.
    ///
    /// Side effects:
    ///   - Hit the registry directly so the driver's oneshot wakes up
    ///     and `send_prompt` resumes streaming.
    ///   - Emit `PermissionResolved` via the manager's sink so any
    ///     cold-attach observer sees the resolution land (the chat
    ///     panel already pops its local queue optimistically on click,
    ///     so the live UI doesn't depend on this).
    pub fn respond_permission(
        &self,
        agent_id: AgentId,
        session_id: &str,
        request_id: Uuid,
        decision: PermissionDecision,
    ) -> Result<()> {
        let key = SessionKey {
            agent_id,
            session_id: session_id.to_string(),
        };
        // The actor resolves the permission on its control channel and emits
        // `PermissionResolved` + the resumed `Running` status itself.
        self.handle_for(&key)?
            .respond_permission(request_id, decision)
    }

    fn handle_for(&self, key: &SessionKey) -> Result<Arc<SessionHandle>> {
        self.inner
            .sessions
            .get(key)
            .map(|e| e.value().clone())
            .ok_or(Error::UnknownSession)
    }

    // ── internals ────────────────────────────────────────────────────────────

    fn plugin_id_for(&self, agent_id: AgentId) -> Result<String> {
        self.inner
            .agent_plugins
            .get(&agent_id)
            .map(|e| e.value().clone())
            .ok_or(Error::Acp(atlas_acp::AcpError::UnknownAgent))
    }

    fn install_session(
        &self,
        key: SessionKey,
        acp_session_id: SessionId,
        cwd: String,
        plugin_id: String,
        seed_messages: Vec<Message>,
        modes: Option<serde_json::Value>,
        models: Option<serde_json::Value>,
    ) {
        let mut state = SessionState::new(
            key.agent_id,
            key.session_id.clone(),
            cwd,
            plugin_id.clone(),
        );
        state.messages = seed_messages;
        // Seed the advertised modes (Codex: read-only / auto / full-access) and
        // the initial current mode from the `session/new` | `session/load`
        // `modes` blob.
        if let Some(modes) = &modes {
            let (current, available) = parse_session_modes(modes);
            if let Some(c) = current {
                state.current_mode = Some(c);
            }
            if !available.is_empty() {
                state.available_modes = available;
            }
        }
        // Seed the advertised models + current model from the `session/new`
        // `models` blob (Claude Code / Codex model picking, ACP first-party).
        if let Some(models) = &models {
            let (current, available) = parse_session_models(models);
            if let Some(c) = current {
                state.current_model = Some(c);
            }
            if !available.is_empty() {
                state.available_models = available;
            }
        }
        let state = Arc::new(Mutex::new(state));

        // Backend was registered at spawn(); fall back to ACP defensively.
        let backend: Arc<dyn AgentBackend> = self
            .inner
            .agent_backends
            .get(&key.agent_id)
            .map(|e| e.value().clone())
            .unwrap_or_else(|| Arc::new(AcpBackend(self.inner.acp.clone())));

        // Every session is driven by the single-owner actor. It applies inbound
        // events and finalizes the turn in one FIFO, so the idle/ordering race
        // is gone by construction (no quiesce poll).
        let conn: Arc<dyn atlas_agentkit::AgentConnection> =
            Arc::new(crate::connection::BackendConnection::new(backend, key.agent_id));
        let actor = crate::actor::SessionActor::spawn(
            state.clone(),
            key.agent_id,
            acp_session_id.clone(),
            conn,
            self.inner.emitter.clone(),
        );

        let handle = Arc::new(SessionHandle {
            state,
            agent_id: key.agent_id,
            acp_session_id,
            plugin_id,
            actor,
        });
        self.inner.sessions.insert(key, handle);
    }

    fn find_session_by_acp_id(&self, agent_id: AgentId, acp_id: &SessionId) -> Option<Arc<SessionHandle>> {
        let target = serde_json::to_value(acp_id)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))?;
        let key = SessionKey {
            agent_id,
            session_id: target,
        };
        self.inner.sessions.get(&key).map(|e| e.value().clone())
    }

    fn emit(&self, envelope: SessionDeltaEnvelope) {
        self.inner.emitter.emit(envelope);
    }

    fn dispatch(&self, agent_id: AgentId, event: AcpEvent) {
        // Agent-wide: fan the disconnect out to every one of the dead agent's
        // sessions (this stays in the manager because it spans sessions).
        let session_id = match &event {
            AcpEvent::AgentDisconnected { reason } => {
                let keys: Vec<SessionKey> = self
                    .inner
                    .sessions
                    .iter()
                    .filter(|e| e.value().agent_id == agent_id)
                    .map(|e| e.key().clone())
                    .collect();
                for key in keys {
                    // If a turn was live on this session, its in-flight `prompt`
                    // future may never resolve now that the agent is gone — the
                    // actor's `TurnDone` would never arrive, leaving the composer
                    // stuck "running". Emit an explicit terminal before removing
                    // the session so the UI always leaves the busy state.
                    if let Some(entry) = self.inner.sessions.get(&key) {
                        let (busy, turn_seq) = {
                            let st = entry.value().state.lock();
                            (
                                matches!(
                                    st.status,
                                    SessionStatus::Running | SessionStatus::Waiting
                                ),
                                st.turn_seq,
                            )
                        };
                        if busy {
                            self.emit(SessionDeltaEnvelope {
                                agent_id,
                                session_id: key.session_id.clone(),
                                delta: SessionDelta::TurnFailed {
                                    error: format!("agent disconnected: {reason}"),
                                    turn_seq,
                                },
                            });
                            self.emit(SessionDeltaEnvelope {
                                agent_id,
                                session_id: key.session_id.clone(),
                                delta: SessionDelta::Status {
                                    status: SessionStatus::Error,
                                    turn_seq,
                                },
                            });
                        }
                    }
                    self.emit(SessionDeltaEnvelope {
                        agent_id,
                        session_id: key.session_id.clone(),
                        delta: SessionDelta::AgentDisconnected {
                            reason: reason.clone(),
                        },
                    });
                    self.inner.sessions.remove(&key);
                }
                self.inner.agent_plugins.remove(&agent_id);
                return;
            }
            AcpEvent::SessionUpdate { session_id, .. }
            | AcpEvent::PermissionRequest { session_id, .. }
            | AcpEvent::TurnFailed { session_id, .. }
            | AcpEvent::Usage { session_id, .. }
            | AcpEvent::Compaction { session_id, .. }
            | AcpEvent::CompressionSaved { session_id, .. } => session_id.clone(),
        };

        // Per-session: push the event onto the target actor's FIFO, where it is
        // applied on the actor's task ordered before the turn terminal.
        if let Some(handle) = self.find_session_by_acp_id(agent_id, &session_id) {
            handle.route_event(event);
        }
    }
}

impl EventSink for AgentManager {
    fn emit(&self, agent_id: AgentId, event: AcpEvent) {
        self.dispatch(agent_id, event);
    }
}

/// Convert the native agent's UI-neutral replay items into `Message`s for the
/// resumed session's transcript (mirrors what the ACP replay paths produce).
fn cersei_replay_to_messages(items: Vec<atlas_cersei::ReplayItem>) -> Vec<Message> {
    use atlas_cersei::ReplayItem;
    items
        .into_iter()
        .map(|it| match it {
            ReplayItem::User { text } => crate::session::new_user_message(text),
            ReplayItem::Assistant { text } => new_assistant_text(text),
            ReplayItem::Thinking { text } => new_assistant_thinking(text),
            ReplayItem::Tool {
                id,
                name,
                input,
                result,
                is_error,
            } => new_assistant_tool(ToolCall {
                id,
                tool_name: name.clone(),
                title: Some(name),
                kind: None,
                status: if is_error {
                    ToolCallStatus::Failed
                } else {
                    ToolCallStatus::Completed
                },
                arguments: input,
                result,
                locations: Vec::new(),
            }),
        })
        .collect()
}

/// Parse the ACP `SessionModeState` blob (from `session/new` | `session/load`)
/// into `(current_mode_id, available_modes)`. The schema serialises camelCase
/// (`currentModeId`, `availableModes`), each mode as `{id, name, description}`.
fn parse_session_modes(modes: &serde_json::Value) -> (Option<String>, Vec<SessionModeInfo>) {
    let current = modes
        .get("currentModeId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let available = modes
        .get("availableModes")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(|v| v.as_str())?.to_string();
                    let name = m
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    let description = m
                        .get("description")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    Some(SessionModeInfo {
                        id,
                        name,
                        description,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (current, available)
}

/// Parse the ACP `SessionModelState` blob (from `session/new`) into
/// `(current_model_id, available_models)`. The schema serialises camelCase
/// (`currentModelId`, `availableModels`), each model as `{modelId, name,
/// description}`. Reuses `SessionModeInfo` (identical id/name/description shape).
fn parse_session_models(models: &serde_json::Value) -> (Option<String>, Vec<SessionModeInfo>) {
    let current = models
        .get("currentModelId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let available = models
        .get("availableModels")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let id = m.get("modelId").and_then(|v| v.as_str())?.to_string();
                    let name = m
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    let description = m
                        .get("description")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    Some(SessionModeInfo {
                        id,
                        name,
                        description,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (current, available)
}
