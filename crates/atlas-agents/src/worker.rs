//! One tokio task per session. Holds the shared `SessionState`, owns the
//! command queue, and drives the blocking `atlas_acp::AgentRegistry::send_prompt`
//! call so the Tauri command surface returns immediately.

use std::sync::Arc;

use agent_client_protocol::schema::SessionId;
use atlas_acp::AgentId;
use parking_lot::Mutex;
use tokio::sync::mpsc;

use crate::backend::AgentBackend;
use crate::error::{Error, Result};
use crate::events::{DeltaSink, SessionDelta, SessionDeltaEnvelope};
use crate::session::{SessionState, SessionStatus, new_user_message};

/// Commands the worker accepts. All entry points (Tauri commands) drop into
/// this enum so the worker can serialise turn execution against state changes.
///
/// Note: there is intentionally no `Cancel` or `RespondPermission`
/// variant. Both must bypass this queue because the worker spends most
/// of its time `await`ing `send_prompt` for an in-flight turn — a
/// queued cancel would only fire after the turn naturally ended, and a
/// queued permission response would deadlock the turn (`send_prompt`
/// can't return until the permission is resolved on the registry, but
/// the worker can't pop the command until `send_prompt` returns).
/// `AgentManager::cancel` and `AgentManager::respond_permission` both
/// hit `AgentRegistry` directly so the driver's oneshot / cancellation
/// guard fires immediately.
pub enum SessionCommand {
    SendPrompt(String),
    SetMode(String),
    SetModel(String),
    SetEffort(String),
    SetCompress(bool),
}

pub struct SessionWorker {
    pub state: Arc<Mutex<SessionState>>,
    pub agent_id: AgentId,
    pub acp_session_id: SessionId,
    pub backend: Arc<dyn AgentBackend>,
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
                SessionCommand::SetMode(mode_id) => {
                    if let Err(e) = self
                        .backend
                        .set_session_mode(self.agent_id, self.acp_session_id.clone(), mode_id)
                        .await
                    {
                        tracing::warn!(target: "atlas_agents::worker", "set_mode failed: {e}");
                    }
                }
                SessionCommand::SetModel(model_id) => {
                    // Push to the backend: ACP agents now support `session/set_model`
                    // (Claude Code / Codex); the native backend applies it to the
                    // next turn. We also mirror the selection into state so the UI
                    // keeps it — the agent may echo a `current_model_update`, which
                    // is idempotent.
                    if let Err(e) = self
                        .backend
                        .set_session_model(self.agent_id, self.acp_session_id.clone(), model_id.clone())
                        .await
                    {
                        tracing::warn!(target: "atlas_agents::worker", "set_model failed: {e}");
                    }
                    let mut st = self.state.lock();
                    st.current_model = Some(model_id.clone());
                    st.touch();
                    drop(st);
                    self.emit(SessionDelta::ModelChanged { model_id });
                }
                SessionCommand::SetEffort(effort) => {
                    // Native-agent only (no-op for ACP backends); applied to the
                    // next turn's thinking budget. No delta — the UI owns the
                    // pill state optimistically.
                    if let Err(e) =
                        self.backend
                            .set_effort(self.agent_id, &self.acp_session_id, effort)
                    {
                        tracing::warn!(target: "atlas_agents::worker", "set_effort failed: {e}");
                    }
                }
                SessionCommand::SetCompress(on) => {
                    // Native-agent only; applied to the next turn's RTK
                    // compression. UI owns the toggle state optimistically.
                    if let Err(e) =
                        self.backend
                            .set_compress(self.agent_id, &self.acp_session_id, on)
                    {
                        tracing::warn!(target: "atlas_agents::worker", "set_compress failed: {e}");
                    }
                }
            }
        }
    }

    async fn handle_send(&self, text: String) {
        // 1. Append the user message to local state for replay parity
        // (snapshot / cold-attach callers read state.messages). The
        // frontend already added the same message optimistically in
        // chat-panel's handleSend before invoking agents.send, so we
        // deliberately do NOT emit a MessageAppended delta here —
        // doing so would render the user message twice in the chat
        // thread. The Status delta below is still emitted so the UI
        // can flip the spinner / disable send.
        let user_msg = new_user_message(text.clone());
        let turn_seq = {
            let mut st = self.state.lock();
            st.messages.push(user_msg);
            // New turn identity — stamped on this turn's status/terminal deltas
            // so the frontend can reject a stale terminal from a superseded turn.
            st.turn_seq = st.turn_seq.wrapping_add(1);
            st.pending_turn_error = None;
            st.status = SessionStatus::Running;
            st.touch();
            st.turn_seq
        };
        self.emit(SessionDelta::Status {
            status: SessionStatus::Running,
            turn_seq,
        });

        // 2. Re-arm the session's lifecycle guard. If the previous turn
        // was cancelled, the driver was dropping all inbound traffic
        // for this session id; this clears that flag so events for the
        // new turn flow through. Cheap (an `AtomicBool` store + an
        // `AtomicU64` increment).
        if let Err(e) = self
            .backend
            .mark_turn_started(self.agent_id, &self.acp_session_id)
        {
            tracing::warn!(target: "atlas_agents::worker", "mark_turn_started failed: {e}");
        }

        // 3. Drive the prompt. Notifications during the turn arrive via the
        // manager's EventSink, mutate state, and emit their own deltas — we
        // don't see them here. The backend returns the lowercased stop-reason
        // token directly.
        let result = self
            .backend
            .send_prompt(self.agent_id, self.acp_session_id.clone(), text)
            .await;

        // 3. Reflect terminal state.
        let (status, delta) = match result {
            Ok(stop_reason) => {
                // Cross-task quiesce. For ACP agents, streamed content arrives
                // as notifications on the driver task while this worker awaits
                // the prompt response on its own task — the two aren't ordered,
                // so the response can resolve a beat before the agent's final
                // `agent_message_chunk` is dispatched, flipping the UI to idle
                // while text is still landing. Wait for the inbound update
                // stream to go quiet first. Skipped for the native backend
                // (chunks are emitted inline before `send_prompt` returns) and
                // on cancellation (Stop must feel instant; the driver gate is
                // already dropping further updates anyway).
                if self.backend.quiesce_turn_end() && stop_reason != "cancelled" {
                    self.await_quiescence().await;
                }
                // Single terminal-status writer: an out-of-band agent failure
                // recorded by the manager dispatch (`pending_turn_error`) wins
                // over a nominal success so the worker still emits exactly one
                // terminal delta for the turn.
                match self.state.lock().pending_turn_error.take() {
                    Some(error) => (
                        SessionStatus::Error,
                        SessionDelta::TurnFailed { error, turn_seq },
                    ),
                    None => (
                        SessionStatus::Idle,
                        SessionDelta::TurnFinished { stop_reason, turn_seq },
                    ),
                }
            }
            Err(e) => (
                SessionStatus::Error,
                SessionDelta::TurnFailed { error: e.to_string(), turn_seq },
            ),
        };
        {
            let mut st = self.state.lock();
            st.status = status;
            st.touch();
        }
        self.emit(delta);
        self.emit(SessionDelta::Status { status, turn_seq });
    }

    /// Wait until inbound agent updates for this session stop arriving, so the
    /// turn-end signal is ordered after the last streamed chunk. Polls the
    /// session's `activity_seq` (bumped by the manager on each applied update):
    /// once it holds steady for `QUIET`, the stream is treated as drained.
    /// Bounded by `MAX` so a still-streaming or misbehaving agent can't wedge
    /// the turn indefinitely.
    async fn await_quiescence(&self) {
        use std::time::Duration;
        const QUIET: Duration = Duration::from_millis(90);
        const POLL: Duration = Duration::from_millis(15);
        const MAX: Duration = Duration::from_millis(1500);

        let mut last = self.state.lock().activity_seq;
        let mut stable = Duration::ZERO;
        let mut waited = Duration::ZERO;
        while waited < MAX {
            tokio::time::sleep(POLL).await;
            waited += POLL;
            let now = self.state.lock().activity_seq;
            if now == last {
                stable += POLL;
                if stable >= QUIET {
                    break;
                }
            } else {
                last = now;
                stable = Duration::ZERO;
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_acp::{AuthMethodWire, NewSessionInfo, PermissionDecision};
    use std::path::PathBuf;
    use uuid::Uuid;

    /// Captures every emitted delta so a test can assert on turn identity.
    #[derive(Default)]
    struct CollectingSink(Mutex<Vec<SessionDeltaEnvelope>>);
    impl DeltaSink for CollectingSink {
        fn emit(&self, envelope: SessionDeltaEnvelope) {
            self.0.lock().push(envelope);
        }
    }

    /// Minimal backend: only `send_prompt` / `mark_turn_started` are exercised by
    /// `handle_send`; everything else is unreachable in these tests.
    struct MockBackend {
        state: Arc<Mutex<SessionState>>,
        /// Set `pending_turn_error` mid-prompt (simulates the manager's
        /// out-of-band `AcpEvent::TurnFailed`) while still returning success.
        inject_error: Option<String>,
        /// Make `send_prompt` itself fail (the RPC-error path).
        fail: bool,
    }

    #[async_trait::async_trait]
    impl AgentBackend for MockBackend {
        async fn new_session(&self, _a: AgentId, _c: PathBuf) -> atlas_acp::Result<NewSessionInfo> {
            unimplemented!()
        }
        async fn load_session(
            &self,
            _a: AgentId,
            _s: SessionId,
            _c: PathBuf,
        ) -> atlas_acp::Result<Option<serde_json::Value>> {
            unimplemented!()
        }
        async fn send_prompt(
            &self,
            _a: AgentId,
            _s: SessionId,
            _t: String,
        ) -> atlas_acp::Result<String> {
            if self.fail {
                return Err(atlas_acp::AcpError::other("boom"));
            }
            if let Some(e) = &self.inject_error {
                self.state.lock().pending_turn_error = Some(e.clone());
            }
            Ok("end_turn".to_string())
        }
        async fn set_session_mode(
            &self,
            _a: AgentId,
            _s: SessionId,
            _m: String,
        ) -> atlas_acp::Result<()> {
            Ok(())
        }
        fn mark_turn_started(&self, _a: AgentId, _s: &SessionId) -> atlas_acp::Result<()> {
            Ok(())
        }
        fn cancel_turn(&self, _a: AgentId, _s: SessionId) -> atlas_acp::Result<()> {
            Ok(())
        }
        fn respond_permission(
            &self,
            _a: AgentId,
            _r: Uuid,
            _d: PermissionDecision,
        ) -> atlas_acp::Result<()> {
            Ok(())
        }
        fn register_session(&self, _a: AgentId, _s: SessionId) -> atlas_acp::Result<()> {
            Ok(())
        }
        fn drop_session(&self, _a: AgentId, _s: &SessionId) -> atlas_acp::Result<()> {
            Ok(())
        }
        fn auth_methods(&self, _a: AgentId) -> atlas_acp::Result<Vec<AuthMethodWire>> {
            Ok(vec![])
        }
        async fn authenticate(&self, _a: AgentId, _m: String) -> atlas_acp::Result<()> {
            Ok(())
        }
        fn kill(&self, _a: AgentId) -> atlas_acp::Result<()> {
            Ok(())
        }
    }

    fn setup(inject_error: Option<String>, fail: bool) -> (SessionWorker, Arc<CollectingSink>) {
        let agent_id = AgentId(Uuid::new_v4());
        let state = Arc::new(Mutex::new(SessionState::new(
            agent_id,
            "sess".into(),
            "/tmp".into(),
            "claude".into(),
        )));
        let sink = Arc::new(CollectingSink::default());
        let backend = Arc::new(MockBackend {
            state: state.clone(),
            inject_error,
            fail,
        });
        let (_tx, rx) = mpsc::unbounded_channel();
        let worker = SessionWorker {
            state,
            agent_id,
            acp_session_id: SessionId::new("sess"),
            backend,
            sink: sink.clone(),
            rx,
        };
        (worker, sink)
    }

    #[tokio::test]
    async fn success_turn_stamps_seq_and_finishes() {
        let (worker, sink) = setup(None, false);
        worker.handle_send("hi".into()).await;
        let deltas = sink.0.lock();
        // Turn start.
        assert!(matches!(
            deltas[0].delta,
            SessionDelta::Status {
                status: SessionStatus::Running,
                turn_seq: 1,
            }
        ));
        // Terminal carries the same turn identity.
        assert!(deltas
            .iter()
            .any(|e| matches!(&e.delta, SessionDelta::TurnFinished { turn_seq: 1, .. })));
        assert!(matches!(
            deltas.last().unwrap().delta,
            SessionDelta::Status {
                status: SessionStatus::Idle,
                turn_seq: 1,
            }
        ));
        assert!(!deltas
            .iter()
            .any(|e| matches!(e.delta, SessionDelta::TurnFailed { .. })));
    }

    #[tokio::test]
    async fn pending_turn_error_wins_over_success() {
        let (worker, sink) = setup(Some("agent failed".into()), false);
        worker.handle_send("hi".into()).await;
        let deltas = sink.0.lock();
        assert!(deltas
            .iter()
            .any(|e| matches!(&e.delta, SessionDelta::TurnFailed { turn_seq: 1, .. })));
        assert!(!deltas
            .iter()
            .any(|e| matches!(e.delta, SessionDelta::TurnFinished { .. })));
        assert!(matches!(
            deltas.last().unwrap().delta,
            SessionDelta::Status {
                status: SessionStatus::Error,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn send_prompt_error_emits_single_terminal() {
        let (worker, sink) = setup(None, true);
        worker.handle_send("hi".into()).await;
        let deltas = sink.0.lock();
        assert!(deltas
            .iter()
            .any(|e| matches!(&e.delta, SessionDelta::TurnFailed { turn_seq: 1, .. })));
        // Exactly one terminal delta (single writer).
        let terminals = deltas
            .iter()
            .filter(|e| {
                matches!(
                    e.delta,
                    SessionDelta::TurnFinished { .. } | SessionDelta::TurnFailed { .. }
                )
            })
            .count();
        assert_eq!(terminals, 1);
    }

    #[tokio::test]
    async fn turn_seq_increments_each_turn() {
        let (worker, sink) = setup(None, false);
        worker.handle_send("one".into()).await;
        worker.handle_send("two".into()).await;
        let deltas = sink.0.lock();
        let runnings: Vec<u64> = deltas
            .iter()
            .filter_map(|e| match &e.delta {
                SessionDelta::Status {
                    status: SessionStatus::Running,
                    turn_seq,
                } => Some(*turn_seq),
                _ => None,
            })
            .collect();
        assert_eq!(runnings, vec![1, 2]);
        assert!(deltas
            .iter()
            .any(|e| matches!(&e.delta, SessionDelta::TurnFinished { turn_seq: 2, .. })));
    }
}
