//! The single-owner session actor.
//!
//! One tokio task per session multiplexes, in a single `tokio::select!` loop,
//! two inputs:
//!
//! - `control_rx` — user intents (send / cancel / respond-permission / set-*),
//! - `stream_rx`  — a FIFO of `ActorMsg`: inbound agent events (`Acp`) pushed by
//!   the manager's event routing, AND the turn-completion signal (`TurnDone`)
//!   pushed by the spawned prompt task when `AgentConnection::prompt` resolves.
//!
//! Because both the streamed events and the completion travel through the **same
//! FIFO**, and (for ACP) the driver reads all of a turn's `session/update`
//! frames before the `session/prompt` response frame, `TurnDone` is guaranteed
//! to sit *behind* the last content event. So the actor finalizes the turn only
//! after applying every streamed event — the idle/ordering race is gone **by
//! construction**, with no `activity_seq` poll and no quiescence heuristic.
//!
//! A monotonic [`TurnId`] + `is_same_turn` check makes preemption safe: a new
//! `Send` bumps the id, so a superseded turn's late `TurnDone` is dropped and
//! can't flip a fresh turn's status.

use std::sync::Arc;

use atlas_acp::{AcpEvent, AgentId, PermissionDecision, Result as AcpResult, SessionId};
use atlas_agentkit::{AgentConnection, TurnId};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::apply::apply_event;
use crate::events::{Emitter, SessionDelta, SessionDeltaEnvelope};
use crate::session::{SessionState, SessionStatus, new_user_message};

/// User intents routed to the actor. Unlike the legacy worker, `Cancel` and
/// `RespondPermission` come through this same channel — the actor never blocks
/// on `prompt` (it spawns the turn and returns to the `select!`), so there is no
/// deadlock forcing them to bypass the queue.
pub enum Control {
    Send(String),
    Cancel,
    RespondPermission {
        request_id: Uuid,
        decision: PermissionDecision,
    },
    SetMode(String),
    SetModel(String),
    SetEffort(String),
    SetCompress(bool),
}

/// The single ordered stream feeding the actor: inbound agent events and the
/// turn-completion signal, in wire order.
pub enum ActorMsg {
    /// An inbound agent event, routed from the manager's event sink.
    Acp(AcpEvent),
    /// The turn's `prompt` future resolved. Enqueued by the spawned prompt task
    /// AFTER all of the turn's events, so the actor drains content first.
    TurnDone {
        turn: TurnId,
        result: AcpResult<String>,
    },
}

/// Handle held by the manager to talk to a running actor.
#[derive(Clone)]
pub struct ActorHandle {
    pub control_tx: mpsc::UnboundedSender<Control>,
    /// Push inbound agent events here; the actor applies them in FIFO order.
    pub stream_tx: mpsc::UnboundedSender<ActorMsg>,
}

pub struct SessionActor {
    state: Arc<Mutex<SessionState>>,
    agent_id: AgentId,
    session_id: SessionId,
    conn: Arc<dyn AgentConnection>,
    emitter: Arc<Emitter>,
    control_rx: mpsc::UnboundedReceiver<Control>,
    stream_rx: mpsc::UnboundedReceiver<ActorMsg>,
    /// Cloned into each turn's prompt task so it can post `TurnDone`.
    stream_tx: mpsc::UnboundedSender<ActorMsg>,
    turn_id: TurnId,
    /// The currently-running turn, if any. `None` between turns.
    running: Option<TurnId>,
}

impl SessionActor {
    /// Spawn the actor task and return the handle the manager drives it with.
    pub fn spawn(
        state: Arc<Mutex<SessionState>>,
        agent_id: AgentId,
        session_id: SessionId,
        conn: Arc<dyn AgentConnection>,
        emitter: Arc<Emitter>,
    ) -> ActorHandle {
        let (control_tx, control_rx) = mpsc::unbounded_channel();
        let (stream_tx, stream_rx) = mpsc::unbounded_channel();
        let actor = SessionActor {
            state,
            agent_id,
            session_id,
            conn,
            emitter,
            control_rx,
            stream_rx,
            stream_tx: stream_tx.clone(),
            turn_id: TurnId::default(),
            running: None,
        };
        tokio::spawn(actor.run());
        ActorHandle {
            control_tx,
            stream_tx,
        }
    }

    async fn run(mut self) {
        loop {
            tokio::select! {
                biased; // control wins ties → Stop feels instant
                ctrl = self.control_rx.recv() => {
                    match ctrl {
                        Some(c) => self.handle_control(c).await,
                        // Control channel closed = the session handle was dropped.
                        None => break,
                    }
                }
                msg = self.stream_rx.recv() => {
                    // `self` always holds a `stream_tx` clone, so this never
                    // yields `None` while the actor is alive.
                    if let Some(m) = msg {
                        self.handle_stream(m);
                    }
                }
            }
        }
    }

    async fn handle_control(&mut self, ctrl: Control) {
        match ctrl {
            Control::Send(text) => self.start_turn(text),
            Control::Cancel => {
                // The turn's own `TurnDone` (stop_reason = "cancelled") still
                // flows through `stream_rx` and finalizes the UI — we only nudge
                // the connection here. `running` is left as-is so that terminal
                // is accepted (not dropped as stale).
                let _ = self.conn.cancel(self.session_id.clone());
            }
            Control::RespondPermission { request_id, decision } => {
                let _ = self.conn.respond_permission(request_id, decision);
                // The turn resumes — flip Waiting back to Running so the UI shows
                // work again (a terminal will supersede this if the answer ended
                // the turn). Mirrors `AgentManager::respond_permission`.
                let (sid, turn_seq) = {
                    let mut st = self.state.lock();
                    if st.status == SessionStatus::Waiting {
                        st.status = SessionStatus::Running;
                    }
                    (st.session_id.clone(), st.turn_seq)
                };
                self.emit_for(sid.clone(), SessionDelta::PermissionResolved { request_id });
                self.emit_for(
                    sid,
                    SessionDelta::Status {
                        status: SessionStatus::Running,
                        turn_seq,
                    },
                );
            }
            Control::SetMode(mode_id) => {
                if let Some(modes) = self.conn.session_modes() {
                    if let Err(e) = modes.set(&self.session_id, mode_id).await {
                        tracing::warn!(target: "atlas_agents::actor", "set_mode failed: {e}");
                    }
                }
            }
            Control::SetModel(model_id) => {
                if let Some(sel) = self.conn.model_selector() {
                    if let Err(e) = sel.select(&self.session_id, model_id.clone()).await {
                        tracing::warn!(target: "atlas_agents::actor", "set_model failed: {e}");
                    }
                }
                let sid = {
                    let mut st = self.state.lock();
                    st.current_model = Some(model_id.clone());
                    st.touch();
                    st.session_id.clone()
                };
                self.emit_for(sid, SessionDelta::ModelChanged { model_id });
            }
            Control::SetEffort(effort) => {
                if let Some(ctl) = self.conn.effort_control() {
                    if let Err(e) = ctl.set(&self.session_id, effort) {
                        tracing::warn!(target: "atlas_agents::actor", "set_effort failed: {e}");
                    }
                }
            }
            Control::SetCompress(on) => {
                if let Some(ctl) = self.conn.compression() {
                    if let Err(e) = ctl.set(&self.session_id, on) {
                        tracing::warn!(target: "atlas_agents::actor", "set_compress failed: {e}");
                    }
                }
            }
        }
    }

    fn start_turn(&mut self, text: String) {
        self.turn_id = self.turn_id.next();
        let turn = self.turn_id;
        self.running = Some(turn);

        // Append the user message for replay parity but do NOT emit
        // MessageAppended — the frontend already added it optimistically. Only
        // the Running status flip is emitted (matches the legacy worker).
        let turn_seq = {
            let mut st = self.state.lock();
            st.messages.push(new_user_message(text.clone()));
            st.turn_seq = st.turn_seq.wrapping_add(1);
            st.pending_turn_error = None;
            st.status = SessionStatus::Running;
            st.touch();
            st.turn_seq
        };
        let sid = self.session_id_str();
        self.emit_for(
            sid,
            SessionDelta::Status {
                status: SessionStatus::Running,
                turn_seq,
            },
        );

        // Re-arm the lifecycle guard so a prior cancel doesn't drop this turn.
        if let Err(e) = self.conn.mark_turn_started(&self.session_id) {
            tracing::warn!(target: "atlas_agents::actor", "mark_turn_started failed: {e}");
        }

        // Drive the prompt off-task; its completion re-enters the FIFO as
        // `TurnDone`, ordered after every event this turn produced.
        let conn = self.conn.clone();
        let session = self.session_id.clone();
        let tx = self.stream_tx.clone();
        tokio::spawn(async move {
            let result = conn.prompt(session, text).await;
            let _ = tx.send(ActorMsg::TurnDone { turn, result });
        });
    }

    fn handle_stream(&mut self, msg: ActorMsg) {
        match msg {
            ActorMsg::Acp(event) => {
                // Apply every event in FIFO order (same logic as the legacy
                // dispatch path). Ordering vs. the terminal is guaranteed by the
                // channel, so there is nothing to gate here.
                apply_event(&self.emitter, &self.state, self.agent_id, event);
            }
            ActorMsg::TurnDone { turn, result } => {
                // Drop a terminal from a superseded turn (a newer Send bumped the
                // id) — the crux of race-safe preemption.
                if self.running != Some(turn) {
                    return;
                }
                self.running = None;

                let turn_seq = self.state.lock().turn_seq;
                let (status, delta) = match result {
                    Ok(stop_reason) => {
                        // An out-of-band `TurnFailed` recorded by `apply_event`
                        // wins over a nominal success (single terminal writer).
                        match self.state.lock().pending_turn_error.take() {
                            Some(error) => (
                                SessionStatus::Error,
                                SessionDelta::TurnFailed { error, turn_seq },
                            ),
                            None => (
                                SessionStatus::Idle,
                                SessionDelta::TurnFinished {
                                    stop_reason,
                                    turn_seq,
                                },
                            ),
                        }
                    }
                    Err(e) => (
                        SessionStatus::Error,
                        SessionDelta::TurnFailed {
                            error: e.to_string(),
                            turn_seq,
                        },
                    ),
                };
                {
                    let mut st = self.state.lock();
                    st.status = status;
                    st.touch();
                }
                let sid = self.session_id_str();
                self.emit_for(sid.clone(), delta);
                self.emit_for(sid, SessionDelta::Status { status, turn_seq });
            }
        }
    }

    fn session_id_str(&self) -> String {
        self.state.lock().session_id.clone()
    }

    fn emit_for(&self, session_id: String, delta: SessionDelta) {
        self.emitter.emit(SessionDeltaEnvelope {
            agent_id: self.agent_id,
            session_id,
            delta,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::DeltaSink;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::oneshot;

    #[derive(Default)]
    struct CollectingSink(Mutex<Vec<SessionDeltaEnvelope>>);
    impl DeltaSink for CollectingSink {
        fn emit(&self, envelope: SessionDeltaEnvelope) {
            self.0.lock().push(envelope);
        }
    }

    /// A connection whose `prompt` blocks until a oneshot fires, so a test can
    /// interleave streamed events before the turn completes.
    struct GatedConn {
        gate: Mutex<Option<oneshot::Receiver<String>>>,
        started: AtomicBool,
    }
    #[async_trait::async_trait]
    impl AgentConnection for GatedConn {
        async fn prompt(&self, _s: SessionId, _t: String) -> AcpResult<String> {
            self.started.store(true, Ordering::SeqCst);
            let rx = self.gate.lock().take().expect("prompt called once");
            Ok(rx.await.unwrap_or_else(|_| "end_turn".into()))
        }
        fn mark_turn_started(&self, _s: &SessionId) -> AcpResult<()> {
            Ok(())
        }
        fn cancel(&self, _s: SessionId) -> AcpResult<()> {
            Ok(())
        }
        fn respond_permission(&self, _r: Uuid, _d: PermissionDecision) -> AcpResult<()> {
            Ok(())
        }
    }

    fn text_chunk_event(text: &str) -> AcpEvent {
        // Build an `agent_message_chunk` SessionUpdate via JSON round-trip.
        let update: agent_client_protocol::schema::v1::SessionUpdate = serde_json::from_value(
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": text },
            }),
        )
        .expect("valid session update");
        AcpEvent::SessionUpdate {
            session_id: agent_client_protocol::schema::v1::SessionId::new("s"),
            update,
        }
    }

    fn setup() -> (
        ActorHandle,
        Arc<CollectingSink>,
        oneshot::Sender<String>,
        AgentId,
    ) {
        let agent_id = AgentId(Uuid::new_v4());
        let state = Arc::new(Mutex::new(SessionState::new(
            agent_id,
            "s".into(),
            "/tmp".into(),
            "claude".into(),
        )));
        let sink = Arc::new(CollectingSink::default());
        let emitter = Arc::new(Emitter::new(sink.clone() as Arc<dyn DeltaSink>));
        let (gate_tx, gate_rx) = oneshot::channel();
        let conn = Arc::new(GatedConn {
            gate: Mutex::new(Some(gate_rx)),
            started: AtomicBool::new(false),
        });
        let handle = SessionActor::spawn(
            state,
            agent_id,
            SessionId::new("s"),
            conn,
            emitter,
        );
        (handle, sink, gate_tx, agent_id)
    }

    async fn settle() {
        // Let the actor task drain its channels.
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn turn_finishes_after_all_streamed_text() {
        let (handle, sink, gate_tx, _agent) = setup();
        handle.control_tx.send(Control::Send("hi".into())).unwrap();
        settle().await;
        // Stream two text chunks WHILE the (gated) prompt is still running.
        handle.stream_tx.send(ActorMsg::Acp(text_chunk_event("Hel"))).unwrap();
        handle.stream_tx.send(ActorMsg::Acp(text_chunk_event("lo"))).unwrap();
        settle().await;
        // Now let the prompt resolve → TurnDone is enqueued AFTER the chunks.
        gate_tx.send("end_turn".into()).unwrap();
        settle().await;

        let deltas = sink.0.lock();
        // The terminal (TurnFinished) must come after both text deltas.
        let last_text = deltas
            .iter()
            .rposition(|e| {
                matches!(
                    e.delta,
                    SessionDelta::TextChunk { .. } | SessionDelta::MessageAppended { .. }
                )
            })
            .expect("text deltas present");
        let finished = deltas
            .iter()
            .position(|e| matches!(e.delta, SessionDelta::TurnFinished { .. }))
            .expect("turn finished");
        assert!(
            finished > last_text,
            "TurnFinished ({finished}) must follow the last text delta ({last_text})"
        );
        // Exactly one terminal, stamped with turn 1.
        assert!(deltas
            .iter()
            .any(|e| matches!(&e.delta, SessionDelta::TurnFinished { turn_seq: 1, .. })));
    }

    #[tokio::test]
    async fn stale_turn_terminal_is_dropped() {
        let (handle, sink, gate_tx, _agent) = setup();
        // Turn 1 starts and is gated.
        handle.control_tx.send(Control::Send("one".into())).unwrap();
        settle().await;
        // A second Send supersedes it before turn 1 completes.
        handle.control_tx.send(Control::Send("two".into())).unwrap();
        settle().await;
        // Turn 1's prompt now resolves — its TurnDone carries the OLD turn id and
        // must be dropped (turn 2 is current).
        gate_tx.send("end_turn".into()).unwrap();
        settle().await;

        let deltas = sink.0.lock();
        // No TurnFinished for turn 1 (turn_seq 1) should have been emitted — the
        // stale terminal was gated out. (Turn 2 is still running/gated.)
        let finished_turn1 = deltas
            .iter()
            .any(|e| matches!(&e.delta, SessionDelta::TurnFinished { turn_seq: 1, .. }));
        assert!(!finished_turn1, "stale turn-1 terminal must be dropped");
        // Two Running statuses were emitted (turn 1 and turn 2).
        let runnings = deltas
            .iter()
            .filter(|e| {
                matches!(
                    e.delta,
                    SessionDelta::Status {
                        status: SessionStatus::Running,
                        ..
                    }
                )
            })
            .count();
        assert_eq!(runnings, 2);
    }
}
