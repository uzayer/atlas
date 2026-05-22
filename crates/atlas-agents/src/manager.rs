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

use agent_client_protocol::schema as acp_schema;
use atlas_acp::{
    AcpEvent, AgentId, AgentInfo, AgentRegistry, EventSink, NewSessionInfo, PermissionDecision,
    SessionId,
};
use dashmap::DashMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::events::{DeltaSink, SessionDelta, SessionDeltaEnvelope};
use crate::plugin::{PluginSpec, builtin_plugins, find_plugin};
use crate::session::{
    Message, MessageMode, PlanEntry, SessionSnapshot, SessionState, SessionStatus, ToolCall,
    ToolCallStatus, extract_text_block, format_tool_content, map_tool_status, new_assistant_text,
    new_assistant_thinking, new_assistant_tool, normalise_tool_input,
};
use crate::transcript;
use crate::worker::{SessionCommand, SessionHandle, SessionWorker};

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
    sessions: DashMap<SessionKey, Arc<SessionHandle>>,
    agent_plugins: DashMap<AgentId, String>,
    sink: Arc<dyn DeltaSink>,
}

impl AgentManager {
    pub fn new(sink: Arc<dyn DeltaSink>) -> Self {
        Self {
            inner: Arc::new(ManagerInner {
                acp: AgentRegistry::new(),
                sessions: DashMap::new(),
                agent_plugins: DashMap::new(),
                sink,
            }),
        }
    }

    pub fn list_plugins(&self) -> Vec<PluginSpec> {
        builtin_plugins()
    }

    pub fn list_agents(&self) -> Vec<AgentInfo> {
        self.inner.acp.list()
    }

    /// Spawn a plugin's process and register the resulting agent.
    pub async fn spawn(&self, plugin_id: &str) -> Result<AgentInfo> {
        let plugin = find_plugin(plugin_id).ok_or_else(|| Error::UnknownPlugin(plugin_id.into()))?;
        let event_sink: Arc<dyn EventSink> = Arc::new(self.clone());
        let info = self.inner.acp.spawn(&plugin.plugin_id, event_sink).await?;
        self.inner
            .agent_plugins
            .insert(info.agent_id, plugin.plugin_id);
        Ok(info)
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
        self.inner.acp.kill(agent_id)?;
        Ok(())
    }

    /// Open a fresh session and spawn a worker for it.
    pub async fn new_session(&self, agent_id: AgentId, cwd: PathBuf) -> Result<SessionKey> {
        let cwd_str = cwd.to_string_lossy().into_owned();
        let plugin_id = self.plugin_id_for(agent_id)?;
        let resp: NewSessionInfo = self.inner.acp.new_session(agent_id, cwd).await?;
        let session_id_str = serde_json::to_value(&resp.session_id)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        let key = SessionKey {
            agent_id,
            session_id: session_id_str.clone(),
        };
        self.install_session(key.clone(), resp.session_id, cwd_str, plugin_id, Vec::new());
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

        let seeds = transcript::replay(plugin.transcript, &cwd_str, &session_id_str).await?;

        // ACP load happens after replay so the worker is ready to receive
        // notifications immediately on a follow-up `send_prompt`.
        self.inner.acp.load_session(agent_id, session_id.clone(), cwd).await?;

        // Re-check after the awaits — another concurrent caller may have
        // installed the same session while we were doing I/O.
        if self.inner.sessions.contains_key(&key) {
            return Ok(key);
        }

        self.install_session(key.clone(), session_id, cwd_str, plugin_id, seeds);
        Ok(key)
    }

    pub fn snapshot(&self, key: &SessionKey) -> Result<SessionSnapshot> {
        let handle = self.handle_for(key)?;
        let snap = handle.state.lock().snapshot();
        Ok(snap)
    }

    pub fn send(&self, key: &SessionKey, text: String) -> Result<()> {
        self.handle_for(key)?.send(SessionCommand::SendPrompt(text))
    }

    pub fn cancel(&self, key: &SessionKey) -> Result<()> {
        self.handle_for(key)?.send(SessionCommand::Cancel)
    }

    pub fn set_mode(&self, key: &SessionKey, mode_id: String) -> Result<()> {
        self.handle_for(key)?.send(SessionCommand::SetMode(mode_id))
    }

    pub fn set_model(&self, key: &SessionKey, model_id: String) -> Result<()> {
        self.handle_for(key)?.send(SessionCommand::SetModel(model_id))
    }

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
        self.handle_for(&key)?.send(SessionCommand::RespondPermission {
            request_id,
            decision,
        })
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
    ) {
        let mut state = SessionState::new(
            key.agent_id,
            key.session_id.clone(),
            cwd,
            plugin_id.clone(),
        );
        state.messages = seed_messages;
        let state = Arc::new(Mutex::new(state));

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();

        let worker = SessionWorker {
            state: state.clone(),
            agent_id: key.agent_id,
            acp_session_id: acp_session_id.clone(),
            registry: self.inner.acp.clone(),
            sink: self.inner.sink.clone(),
            rx: cmd_rx,
        };
        worker.spawn();

        let handle = Arc::new(SessionHandle {
            state,
            agent_id: key.agent_id,
            acp_session_id,
            plugin_id,
            cmd_tx,
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
        self.inner.sink.emit(envelope);
    }

    fn dispatch(&self, agent_id: AgentId, event: AcpEvent) {
        match event {
            AcpEvent::AgentDisconnected { reason } => {
                // Fan out to all sessions of the dead agent.
                let keys: Vec<SessionKey> = self
                    .inner
                    .sessions
                    .iter()
                    .filter(|e| e.value().agent_id == agent_id)
                    .map(|e| e.key().clone())
                    .collect();
                for key in keys {
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
            }
            AcpEvent::SessionUpdate { session_id, update } => {
                if let Some(handle) = self.find_session_by_acp_id(agent_id, &session_id) {
                    self.apply_session_update(&handle, update);
                }
            }
            AcpEvent::PermissionRequest {
                request_id,
                session_id,
                tool_call,
                options,
            } => {
                if let Some(handle) = self.find_session_by_acp_id(agent_id, &session_id) {
                    let st = handle.state.lock();
                    self.emit(SessionDeltaEnvelope {
                        agent_id,
                        session_id: st.session_id.clone(),
                        delta: SessionDelta::PermissionRequest {
                            request_id,
                            tool_call: serde_json::to_value(&tool_call).unwrap_or_default(),
                            options: serde_json::to_value(&options).unwrap_or_default(),
                        },
                    });
                }
            }
            AcpEvent::TurnStopped {
                session_id,
                turn_id: _,
                stop_reason,
            } => {
                if let Some(handle) = self.find_session_by_acp_id(agent_id, &session_id) {
                    let mut st = handle.state.lock();
                    st.status = SessionStatus::Idle;
                    let sid = st.session_id.clone();
                    drop(st);
                    self.emit(SessionDeltaEnvelope {
                        agent_id,
                        session_id: sid,
                        delta: SessionDelta::TurnFinished {
                            stop_reason: format!("{stop_reason:?}").to_ascii_lowercase(),
                        },
                    });
                }
            }
            AcpEvent::TurnFailed {
                session_id,
                turn_id: _,
                error,
            } => {
                if let Some(handle) = self.find_session_by_acp_id(agent_id, &session_id) {
                    let mut st = handle.state.lock();
                    st.status = SessionStatus::Error;
                    let sid = st.session_id.clone();
                    drop(st);
                    self.emit(SessionDeltaEnvelope {
                        agent_id,
                        session_id: sid,
                        delta: SessionDelta::TurnFailed { error },
                    });
                }
            }
        }
    }

    fn apply_session_update(&self, handle: &SessionHandle, update: acp_schema::SessionUpdate) {
        // Decode through JSON — `SessionUpdate` is `#[non_exhaustive]` and its
        // variants carry schema types that are awkward to match directly. The
        // wire form is stable, so going through serde_json gives us a clean
        // dispatch on `sessionUpdate`.
        let Ok(v) = serde_json::to_value(&update) else {
            return;
        };
        let Some(kind) = v.get("sessionUpdate").and_then(|s| s.as_str()) else {
            return;
        };
        match kind {
            "agent_message_chunk" => {
                let Some(content) = v.get("content") else { return };
                let Ok(block) = serde_json::from_value::<acp_schema::ContentBlock>(content.clone()) else {
                    return;
                };
                if let Some(text) = extract_text_block(&block) {
                    self.append_text_chunk(handle, text);
                }
            }
            "agent_thought_chunk" => {
                let Some(content) = v.get("content") else { return };
                let Ok(block) = serde_json::from_value::<acp_schema::ContentBlock>(content.clone()) else {
                    return;
                };
                if let Some(text) = extract_text_block(&block) {
                    self.append_thinking_chunk(handle, text);
                }
            }
            "tool_call" | "tool_call_update" => {
                self.apply_tool_call(handle, &v, kind == "tool_call_update");
            }
            "plan" => {
                let entries: Vec<PlanEntry> = v
                    .get("entries")
                    .and_then(|e| serde_json::from_value(e.clone()).ok())
                    .unwrap_or_default();
                let mut st = handle.state.lock();
                st.plan = entries.clone();
                // Attach to the trailing assistant message, or seed a fresh one.
                let attached = if let Some(last) = st.messages.last_mut() {
                    if matches!(last.role, crate::session::MessageRole::Assistant) {
                        last.plan = Some(entries.clone());
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                if !attached {
                    let mut msg = new_assistant_text(String::new());
                    msg.plan = Some(entries.clone());
                    st.messages.push(msg);
                }
                st.touch();
                let sid = st.session_id.clone();
                let agent_id = st.agent_id;
                drop(st);
                self.emit(SessionDeltaEnvelope {
                    agent_id,
                    session_id: sid,
                    delta: SessionDelta::PlanUpdated { plan: entries },
                });
            }
            "available_commands_update" => {
                let commands: Vec<serde_json::Value> = v
                    .get("availableCommands")
                    .and_then(|c| c.as_array().cloned())
                    .unwrap_or_default();
                let mut st = handle.state.lock();
                st.available_commands = commands.clone();
                let sid = st.session_id.clone();
                let agent_id = st.agent_id;
                drop(st);
                self.emit(SessionDeltaEnvelope {
                    agent_id,
                    session_id: sid,
                    delta: SessionDelta::AvailableCommands { commands },
                });
            }
            "current_mode_update" => {
                let Some(mode_id) = v.get("currentModeId").and_then(|s| s.as_str()) else { return };
                let mut st = handle.state.lock();
                st.current_mode = Some(mode_id.to_string());
                let sid = st.session_id.clone();
                let agent_id = st.agent_id;
                drop(st);
                self.emit(SessionDeltaEnvelope {
                    agent_id,
                    session_id: sid,
                    delta: SessionDelta::ModeChanged {
                        mode_id: mode_id.to_string(),
                    },
                });
            }
            "current_model_update" => {
                let Some(model_id) = v.get("currentModelId").and_then(|s| s.as_str()) else { return };
                let mut st = handle.state.lock();
                st.current_model = Some(model_id.to_string());
                let sid = st.session_id.clone();
                let agent_id = st.agent_id;
                drop(st);
                self.emit(SessionDeltaEnvelope {
                    agent_id,
                    session_id: sid,
                    delta: SessionDelta::ModelChanged {
                        model_id: model_id.to_string(),
                    },
                });
            }
            _ => {}
        }
    }

    fn append_text_chunk(&self, handle: &SessionHandle, text: String) {
        let mut st = handle.state.lock();
        let (delta, agent_id, sid) = match st.messages.last_mut() {
            Some(last)
                if last.role == crate::session::MessageRole::Assistant
                    && last.mode == MessageMode::Text
                    && last.tool_calls.is_empty() =>
            {
                last.content.push_str(&text);
                let msg_id = last.id.clone();
                let agent_id = st.agent_id;
                let sid = st.session_id.clone();
                st.touch();
                (
                    SessionDelta::TextChunk {
                        message_id: msg_id,
                        delta: text,
                    },
                    agent_id,
                    sid,
                )
            }
            _ => {
                let msg = new_assistant_text(text);
                let cloned = msg.clone();
                st.messages.push(msg);
                let agent_id = st.agent_id;
                let sid = st.session_id.clone();
                st.touch();
                (SessionDelta::MessageAppended { message: cloned }, agent_id, sid)
            }
        };
        drop(st);
        self.emit(SessionDeltaEnvelope {
            agent_id,
            session_id: sid,
            delta,
        });
    }

    fn append_thinking_chunk(&self, handle: &SessionHandle, text: String) {
        let mut st = handle.state.lock();
        let (delta, agent_id, sid) = match st.messages.last_mut() {
            Some(last)
                if last.role == crate::session::MessageRole::Assistant
                    && last.mode == MessageMode::Thinking =>
            {
                last.thinking.push_str(&text);
                let msg_id = last.id.clone();
                let agent_id = st.agent_id;
                let sid = st.session_id.clone();
                st.touch();
                (
                    SessionDelta::ThinkingChunk {
                        message_id: msg_id,
                        delta: text,
                    },
                    agent_id,
                    sid,
                )
            }
            _ => {
                let msg = new_assistant_thinking(text);
                let cloned = msg.clone();
                st.messages.push(msg);
                let agent_id = st.agent_id;
                let sid = st.session_id.clone();
                st.touch();
                (SessionDelta::MessageAppended { message: cloned }, agent_id, sid)
            }
        };
        drop(st);
        self.emit(SessionDeltaEnvelope {
            agent_id,
            session_id: sid,
            delta,
        });
    }

    fn apply_tool_call(&self, handle: &SessionHandle, v: &serde_json::Value, is_update: bool) {
        let Some(tool_call_id) = v.get("toolCallId").and_then(|s| s.as_str()) else {
            return;
        };
        let raw_input_val = v.get("rawInput");
        let title = v.get("title").and_then(|s| s.as_str()).map(|s| s.to_string());
        let kind = v.get("kind").and_then(|s| s.as_str()).map(|s| s.to_string());
        let status_raw = v.get("status").and_then(|s| s.as_str());
        let content_val = v.get("content").cloned();
        let formatted = content_val
            .as_ref()
            .and_then(format_tool_content);

        let mut st = handle.state.lock();

        // Upsert by toolCallId across existing messages.
        for msg in st.messages.iter_mut().rev() {
            if let Some(tc) = msg.tool_calls.iter_mut().find(|t| t.id == tool_call_id) {
                tc.status = map_tool_status(status_raw, tc.status);
                if let Some(input) = raw_input_val {
                    tc.arguments = normalise_tool_input(Some(input));
                }
                if let Some(t) = title.clone() {
                    tc.tool_name = t.clone();
                    tc.title = Some(t);
                }
                if let Some(k) = kind.clone() {
                    tc.kind = Some(k);
                }
                if let Some(result) = formatted.clone() {
                    tc.result = Some(result);
                }
                let updated = tc.clone();
                let msg_id = msg.id.clone();
                let agent_id = st.agent_id;
                let sid = st.session_id.clone();
                st.touch();
                drop(st);
                self.emit(SessionDeltaEnvelope {
                    agent_id,
                    session_id: sid,
                    delta: SessionDelta::ToolCallUpserted {
                        message_id: msg_id,
                        tool_call: updated,
                    },
                });
                return;
            }
        }

        // First sighting — only the initial `tool_call` event creates a new
        // message; lone `tool_call_update` for an unknown id is ignored to
        // match the existing frontend's behaviour.
        if is_update {
            return;
        }

        let tool_call = ToolCall {
            id: tool_call_id.to_string(),
            tool_name: title
                .clone()
                .or_else(|| kind.clone())
                .unwrap_or_else(|| "tool".to_string()),
            title: title.clone(),
            kind: kind.clone(),
            status: map_tool_status(status_raw, ToolCallStatus::Running),
            arguments: normalise_tool_input(raw_input_val),
            result: formatted,
            locations: v
                .get("locations")
                .and_then(|l| l.as_array().cloned())
                .unwrap_or_default(),
        };
        let msg = new_assistant_tool(tool_call.clone());
        let msg_id = msg.id.clone();
        st.messages.push(msg);
        let agent_id = st.agent_id;
        let sid = st.session_id.clone();
        st.touch();
        drop(st);
        self.emit(SessionDeltaEnvelope {
            agent_id,
            session_id: sid,
            delta: SessionDelta::ToolCallUpserted {
                message_id: msg_id,
                tool_call,
            },
        });
    }
}

impl EventSink for AgentManager {
    fn emit(&self, agent_id: AgentId, event: AcpEvent) {
        self.dispatch(agent_id, event);
    }
}
