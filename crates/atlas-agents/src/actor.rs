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
//! Both the streamed events and the completion travel through the **same FIFO**,
//! and (for ACP) the driver reads all of a turn's `session/update` frames before
//! the `session/prompt` response frame — so ordinarily `TurnDone` sits *behind*
//! the last content event and no `activity_seq` poll or quiescence heuristic is
//! needed.
//!
//! That ordering is an assertion, not a guarantee: `TurnDone` is posted by the
//! spawned prompt task while content events are routed from a *different* task,
//! and Claude Code's bridge can resolve `session/prompt` (`end_turn`) while tool
//! calls are still in flight. So finalization is additionally **gated on tool
//! quiescence** — per the ACP contract that a turn only truly ends once no tool
//! calls pend. If a `TurnDone` arrives with non-terminal tool calls, the result
//! is stashed in `pending_finalize` and the terminal is deferred until the last
//! `tool_call_update` reports done (a bounded [`FinalizeTimeout`] backstop keeps
//! a never-terminating tool from hanging the turn). This closes the "idle while
//! tools still spinning" race at the authoritative Rust layer.
//!
//! A monotonic [`TurnId`] + `is_same_turn` check makes preemption safe: a new
//! `Send` bumps the id, so a superseded turn's late `TurnDone` is dropped and
//! can't flip a fresh turn's status.

use std::sync::Arc;
use std::time::Duration;

use atlas_acp::{AcpError, AcpEvent, AgentId, PermissionDecision, Result as AcpResult, SessionId};
use atlas_agentkit::{AgentConnection, TurnId};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::apply::apply_event;
use crate::events::{Emitter, SessionDelta, SessionDeltaEnvelope};
use crate::session::{SessionState, SessionStatus, ToolCall, ToolCallStatus, new_user_message};

/// How long to wait for outstanding tool calls to report a terminal status
/// after the `session/prompt` future has resolved, before force-sweeping them
/// and finalizing anyway. A failsafe against a tool that never emits a terminal
/// `tool_call_update` — NOT a completion heuristic (the prompt already resolved).
const FINALIZE_BACKSTOP: Duration = Duration::from_secs(10);

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
    /// Backstop fired for a turn whose `TurnDone` resolved while tool calls were
    /// still in flight. Enqueued by a spawned timer; finalizes the deferred turn
    /// even if a tool never reported terminal. Ignored if the turn already
    /// finalized (tools quiesced first) or was superseded.
    FinalizeTimeout {
        turn: TurnId,
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
    /// The currently-running turn, if any. `None` between turns. Stays `Some`
    /// while a turn is deferred in `pending_finalize` (the turn is still live
    /// until tool calls quiesce).
    running: Option<TurnId>,
    /// A resolved `prompt` result awaiting tool-call quiescence before it can
    /// finalize the turn. `Some` only when `running` is `Some` and the turn had
    /// non-terminal tool calls when its `TurnDone` arrived.
    pending_finalize: Option<AcpResult<String>>,
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
            pending_finalize: None,
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
        // A new send supersedes any turn still deferred awaiting tool quiescence
        // — its stashed result (and its pending backstop) are now stale.
        self.pending_finalize = None;

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
        let done_tx = tx.clone();
        let handle = tokio::spawn(async move {
            let result = conn.prompt(session, text).await;
            let _ = done_tx.send(ActorMsg::TurnDone { turn, result });
        });
        // Supervisor: if the prompt task unwinds (panic) or is aborted before it
        // posts `TurnDone`, synthesize a terminal so the turn can't strand the
        // composer 'running'. The ACP path gets this guarantee from the
        // `AgentDisconnected` terminal (manager.rs) when its subprocess dies; the
        // in-process native (cersei) path has no such route — a panic inside
        // `conn.prompt` (provider/tool/serde/`delegate`) would otherwise leave
        // `running` set forever. Idempotent: a stranded turn that already
        // finalized normally has `running == None`/a newer id, so the synthetic
        // `TurnDone` is dropped by the stale-turn guard in `handle_stream`.
        tokio::spawn(async move {
            if let Err(join_err) = handle.await {
                let _ = tx.send(ActorMsg::TurnDone {
                    turn,
                    result: Err(AcpError::other(format!(
                        "agent turn ended abnormally: {join_err}"
                    ))),
                });
            }
        });
    }

    fn handle_stream(&mut self, msg: ActorMsg) {
        match msg {
            ActorMsg::Acp(event) => {
                // Apply every event in FIFO order (same logic as the legacy
                // dispatch path).
                apply_event(&self.emitter, &self.state, self.agent_id, event);
                if self.pending_finalize.is_some() {
                    // A finalize is deferred awaiting tool quiescence — did this
                    // event drain the last outstanding tool call?
                    if self.running.is_some() && !self.state.lock().has_inflight_tool_calls() {
                        if let Some(result) = self.pending_finalize.take() {
                            self.finalize(result);
                        }
                    }
                } else if self.running.is_none() && self.state.lock().has_inflight_tool_calls() {
                    // Late-event guard: after a turn has fully finalized (idle),
                    // a stray `tool_call` frame must not resurrect a spinning
                    // card. Sweep it to a terminal state immediately.
                    self.sweep_inflight_tools(ToolCallStatus::Completed);
                }
            }
            ActorMsg::TurnDone { turn, result } => {
                // Drop a terminal from a superseded turn (a newer Send bumped the
                // id) — the crux of race-safe preemption.
                if self.running != Some(turn) {
                    return;
                }
                // The prompt future resolved. If tool calls are still in flight,
                // the turn hasn't truly ended (Claude Code can resolve `end_turn`
                // with trailing tool frames still arriving) — defer the terminal
                // until they quiesce, with a bounded backstop.
                if self.state.lock().has_inflight_tool_calls() {
                    self.pending_finalize = Some(result);
                    let tx = self.stream_tx.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(FINALIZE_BACKSTOP).await;
                        let _ = tx.send(ActorMsg::FinalizeTimeout { turn });
                    });
                    return;
                }
                self.finalize(result);
            }
            ActorMsg::FinalizeTimeout { turn } => {
                // Fire only if still the current turn and still awaiting
                // quiescence (tools may have drained first, or a newer send
                // superseded this turn — either way `pending_finalize` is None).
                if self.running == Some(turn) {
                    if let Some(result) = self.pending_finalize.take() {
                        self.finalize(result);
                    }
                }
            }
        }
    }

    /// Emit the turn terminal (`TurnFinished`/`TurnFailed` + `Status`). Sweeps
    /// any residual non-terminal tool call to a terminal state *first*, so the
    /// frontend never observes an idle turn with a still-spinning card. The sole
    /// terminal-status writer for a turn.
    fn finalize(&mut self, result: AcpResult<String>) {
        self.running = None;
        self.pending_finalize = None;

        let turn_seq = self.state.lock().turn_seq;
        // An out-of-band `TurnFailed` recorded by `apply_event` wins over a
        // nominal success (single terminal writer). Drain it either way.
        let pending_err = self.state.lock().pending_turn_error.take();
        let (status, delta, sweep_to) = match (result, pending_err) {
            (Ok(_), Some(error)) => (
                SessionStatus::Error,
                SessionDelta::TurnFailed { error, turn_seq },
                ToolCallStatus::Failed,
            ),
            (Ok(stop_reason), None) => {
                let cancelled = stop_reason == "cancelled";
                (
                    SessionStatus::Idle,
                    SessionDelta::TurnFinished { stop_reason, turn_seq },
                    if cancelled {
                        ToolCallStatus::Failed
                    } else {
                        ToolCallStatus::Completed
                    },
                )
            }
            (Err(e), _) => (
                SessionStatus::Error,
                SessionDelta::TurnFailed {
                    error: e.to_string(),
                    turn_seq,
                },
                ToolCallStatus::Failed,
            ),
        };

        self.sweep_inflight_tools(sweep_to);
        {
            let mut st = self.state.lock();
            st.status = status;
            st.touch();
        }
        let sid = self.session_id_str();
        self.emit_for(sid.clone(), delta);
        self.emit_for(sid, SessionDelta::Status { status, turn_seq });
    }

    /// Flip every still-`Pending`/`Running` tool call to `to` and emit a
    /// `ToolCallUpserted` for each — keeping Rust state authoritative and the
    /// frontend consistent without relying on its own turn-end sweep.
    fn sweep_inflight_tools(&self, to: ToolCallStatus) {
        let swept: Vec<(String, ToolCall)> = {
            let mut st = self.state.lock();
            let mut swept = Vec::new();
            for msg in st.messages.iter_mut() {
                let msg_id = msg.id.clone();
                for tc in msg.tool_calls.iter_mut() {
                    if matches!(tc.status, ToolCallStatus::Pending | ToolCallStatus::Running) {
                        tc.status = to;
                        swept.push((msg_id.clone(), tc.clone()));
                    }
                }
            }
            if !swept.is_empty() {
                st.touch();
            }
            swept
        };
        if swept.is_empty() {
            return;
        }
        let sid = self.session_id_str();
        for (message_id, tool_call) in swept {
            self.emit_for(
                sid.clone(),
                SessionDelta::ToolCallUpserted {
                    message_id,
                    tool_call,
                },
            );
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
    use std::time::Duration;
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

    fn tool_call_event(id: &str, status: &str, is_update: bool) -> AcpEvent {
        let kind = if is_update {
            "tool_call_update"
        } else {
            "tool_call"
        };
        let update: agent_client_protocol::schema::v1::SessionUpdate = serde_json::from_value(
            serde_json::json!({
                "sessionUpdate": kind,
                "toolCallId": id,
                "title": "grep",
                "kind": "search",
                "status": status,
            }),
        )
        .expect("valid tool_call session update");
        AcpEvent::SessionUpdate {
            session_id: agent_client_protocol::schema::v1::SessionId::new("s"),
            update,
        }
    }

    /// Latest `ToolCallUpserted` status for a given tool id, if any.
    fn last_tool_status(
        deltas: &[SessionDeltaEnvelope],
        id: &str,
    ) -> Option<crate::session::ToolCallStatus> {
        deltas.iter().rev().find_map(|e| match &e.delta {
            SessionDelta::ToolCallUpserted { tool_call, .. } if tool_call.id == id => {
                Some(tool_call.status)
            }
            _ => None,
        })
    }

    fn has_turn_finished(deltas: &[SessionDeltaEnvelope]) -> bool {
        deltas
            .iter()
            .any(|e| matches!(e.delta, SessionDelta::TurnFinished { .. }))
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

    #[tokio::test]
    async fn turn_defers_idle_until_tool_calls_terminal() {
        let (handle, sink, gate_tx, _agent) = setup();
        handle.control_tx.send(Control::Send("hi".into())).unwrap();
        settle().await;
        // A tool call is in flight during the turn.
        handle
            .stream_tx
            .send(ActorMsg::Acp(tool_call_event("t1", "in_progress", false)))
            .unwrap();
        settle().await;
        // The prompt future resolves `end_turn` WHILE the tool is still running.
        gate_tx.send("end_turn".into()).unwrap();
        settle().await;
        // No terminal yet — finalization is deferred until the tool quiesces.
        assert!(
            !has_turn_finished(&sink.0.lock()),
            "TurnFinished must be deferred while a tool call is in flight"
        );
        // The tool completes → the deferred finalize fires.
        handle
            .stream_tx
            .send(ActorMsg::Acp(tool_call_event("t1", "completed", true)))
            .unwrap();
        settle().await;
        assert!(
            has_turn_finished(&sink.0.lock()),
            "TurnFinished must fire once tool calls quiesce"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn pending_finalize_backstop_sweeps_and_finalizes() {
        let (handle, sink, gate_tx, _agent) = setup();
        handle.control_tx.send(Control::Send("hi".into())).unwrap();
        settle().await;
        handle
            .stream_tx
            .send(ActorMsg::Acp(tool_call_event("stuck", "in_progress", false)))
            .unwrap();
        settle().await;
        gate_tx.send("end_turn".into()).unwrap();
        settle().await;
        // Deferred; the tool never reports terminal. Advance past the backstop.
        assert!(!has_turn_finished(&sink.0.lock()));
        tokio::time::advance(FINALIZE_BACKSTOP + Duration::from_secs(1)).await;
        settle().await;
        let deltas = sink.0.lock();
        assert_eq!(
            last_tool_status(&deltas, "stuck"),
            Some(ToolCallStatus::Completed),
            "backstop must sweep the stuck tool to a terminal state"
        );
        assert!(
            has_turn_finished(&deltas),
            "backstop must finalize the turn even if a tool never terminates"
        );
    }

    #[tokio::test]
    async fn late_tool_event_after_idle_does_not_spin() {
        let (handle, sink, gate_tx, _agent) = setup();
        handle.control_tx.send(Control::Send("hi".into())).unwrap();
        settle().await;
        // Turn completes cleanly with no tools in flight.
        gate_tx.send("end_turn".into()).unwrap();
        settle().await;
        assert!(has_turn_finished(&sink.0.lock()));
        // A stray tool_call arrives AFTER the turn finalized — it must not leave
        // a card spinning forever.
        handle
            .stream_tx
            .send(ActorMsg::Acp(tool_call_event("late", "in_progress", false)))
            .unwrap();
        settle().await;
        assert_eq!(
            last_tool_status(&sink.0.lock(), "late"),
            Some(ToolCallStatus::Completed),
            "a tool_call arriving after idle must be swept terminal, not left running"
        );
    }
}
