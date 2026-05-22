//! One tokio task per session. Holds the shared `SessionState`, owns the
//! command queue, and drives the blocking `atlas_acp::AgentRegistry::send_prompt`
//! call so the Tauri command surface returns immediately.

use std::sync::Arc;

use agent_client_protocol::schema::SessionId;
use atlas_acp::{AgentId, AgentRegistry, PermissionDecision};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::events::{DeltaSink, SessionDelta, SessionDeltaEnvelope};
use crate::session::{SessionState, SessionStatus, new_user_message};

/// Commands the worker accepts. All entry points (Tauri commands) drop into
/// this enum so the worker can serialise turn execution against state changes.
pub enum SessionCommand {
    SendPrompt(String),
    Cancel,
    SetMode(String),
    SetModel(String),
    RespondPermission {
        request_id: Uuid,
        decision: PermissionDecision,
    },
}

pub struct SessionWorker {
    pub state: Arc<Mutex<SessionState>>,
    pub agent_id: AgentId,
    pub acp_session_id: SessionId,
    pub registry: AgentRegistry,
    pub sink: Arc<dyn DeltaSink>,
    pub rx: mpsc::UnboundedReceiver<SessionCommand>,
}

impl SessionWorker {
    pub fn spawn(self) {
        tokio::spawn(self.run());
    }

    async fn run(mut self) {
        while let Some(cmd) = self.rx.recv().await {
            match cmd {
                SessionCommand::SendPrompt(text) => {
                    self.handle_send(text).await;
                }
                SessionCommand::Cancel => {
                    if let Err(e) =
                        self.registry.cancel_turn(self.agent_id, self.acp_session_id.clone())
                    {
                        tracing::warn!(target: "atlas_agents::worker", "cancel failed: {e}");
                    }
                }
                SessionCommand::SetMode(mode_id) => {
                    if let Err(e) = self
                        .registry
                        .set_session_mode(self.agent_id, self.acp_session_id.clone(), mode_id)
                        .await
                    {
                        tracing::warn!(target: "atlas_agents::worker", "set_mode failed: {e}");
                    }
                }
                SessionCommand::SetModel(model_id) => {
                    // The protocol doesn't have a generic set_model call we can
                    // hit through atlas-acp yet — surface the desired value to
                    // state so the UI keeps the selection. Model changes from
                    // the agent come back via `current_model_update`.
                    let mut st = self.state.lock();
                    st.current_model = Some(model_id.clone());
                    st.touch();
                    drop(st);
                    self.emit(SessionDelta::ModelChanged { model_id });
                }
                SessionCommand::RespondPermission {
                    request_id,
                    decision,
                } => {
                    if let Err(e) =
                        self.registry.respond_permission(self.agent_id, request_id, decision)
                    {
                        tracing::warn!(target: "atlas_agents::worker", "respond_permission failed: {e}");
                    }
                    self.emit(SessionDelta::PermissionResolved { request_id });
                }
            }
        }
    }

    async fn handle_send(&self, text: String) {
        // 1. Append the user message to state.
        let user_msg = new_user_message(text.clone());
        {
            let mut st = self.state.lock();
            st.messages.push(user_msg.clone());
            st.status = SessionStatus::Running;
            st.touch();
        }
        self.emit(SessionDelta::MessageAppended { message: user_msg });
        self.emit(SessionDelta::Status {
            status: SessionStatus::Running,
        });

        // 2. Drive the prompt. Notifications during the turn arrive via the
        // manager's EventSink, mutate state, and emit their own deltas — we
        // don't see them here.
        let result = self
            .registry
            .send_prompt(self.agent_id, self.acp_session_id.clone(), text)
            .await;

        // 3. Reflect terminal state.
        let (status, delta) = match result {
            Ok(stop_reason) => (
                SessionStatus::Idle,
                SessionDelta::TurnFinished {
                    stop_reason: format!("{stop_reason:?}").to_ascii_lowercase(),
                },
            ),
            Err(e) => (SessionStatus::Error, SessionDelta::TurnFailed { error: e.to_string() }),
        };
        {
            let mut st = self.state.lock();
            st.status = status;
            st.touch();
        }
        self.emit(delta);
        self.emit(SessionDelta::Status { status });
    }

    fn emit(&self, delta: SessionDelta) {
        let st = self.state.lock();
        let envelope = SessionDeltaEnvelope {
            agent_id: st.agent_id,
            session_id: st.session_id.clone(),
            delta,
        };
        drop(st);
        self.sink.emit(envelope);
    }
}

/// Handle held inside the manager — gives non-worker code (the EventSink path)
/// access to the state mutex and a command sender.
pub struct SessionHandle {
    pub state: Arc<Mutex<SessionState>>,
    pub agent_id: AgentId,
    pub acp_session_id: SessionId,
    pub plugin_id: String,
    pub cmd_tx: mpsc::UnboundedSender<SessionCommand>,
}

impl SessionHandle {
    pub fn send(&self, cmd: SessionCommand) -> Result<()> {
        self.cmd_tx.send(cmd).map_err(|_| Error::WorkerGone)
    }
}
