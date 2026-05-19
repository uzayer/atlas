use std::str::FromStr;
use std::sync::Arc;

use agent_client_protocol::schema::{
    InitializeRequest, ProtocolVersion, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SessionId, SessionNotification,
};
use agent_client_protocol::{Agent, ConnectionTo};
use agent_client_protocol_tokio::{AcpAgent, LineDirection};
use dashmap::DashMap;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::error::{AcpError, Result};
use crate::events::{AcpEvent, EventSink};
use crate::registry::AgentId;

/// One outstanding permission request waiting on the UI.
pub struct PendingPermissionEntry {
    pub session_id: SessionId,
    pub sender: oneshot::Sender<RequestPermissionOutcome>,
}

/// Permissions awaiting a client decision.
///
/// The notification handler stashes a [`oneshot::Sender`] under a fresh
/// `request_id`; the Tauri layer resolves it via `acp_respond_permission` once
/// the user clicks a button. Tracks `session_id` so `cancel_turn` can drop
/// the right ones (per ACP spec, any pending permission for a cancelled turn
/// MUST resolve as `Cancelled`).
pub type PendingPermissions = DashMap<Uuid, PendingPermissionEntry>;

/// Resources owned by a single spawned ACP agent. Held inside the
/// [`crate::registry::AgentRegistry`] under an [`AgentId`].
pub struct AgentRuntime {
    pub connection: ConnectionTo<Agent>,
    pub pending_permissions: Arc<PendingPermissions>,
    /// Drop to ask the driver task to shut down.
    pub shutdown_tx: Option<oneshot::Sender<()>>,
}

/// Spawn an ACP agent and wait for its `initialize` handshake to complete.
///
/// Returns once `InitializeRequest` has round-tripped. The driver task continues
/// running in the background until `shutdown_tx` is dropped or the agent
/// process exits.
pub async fn spawn_agent(
    agent_id: AgentId,
    command: String,
    sink: Arc<dyn EventSink>,
) -> Result<AgentRuntime> {
    let pending: Arc<PendingPermissions> = Arc::new(DashMap::new());
    let (ready_tx, ready_rx) = oneshot::channel::<Result<ConnectionTo<Agent>>>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let pending_for_task = pending.clone();
    let sink_for_task = sink.clone();
    let command_for_task = command.clone();

    tokio::spawn(async move {
        let result = run_driver(
            agent_id,
            command_for_task,
            sink_for_task.clone(),
            pending_for_task,
            ready_tx,
            shutdown_rx,
        )
        .await;

        let reason = match result {
            Ok(()) => "driver exited cleanly".to_string(),
            Err(e) => format!("driver error: {e}"),
        };
        sink_for_task.emit(agent_id, AcpEvent::AgentDisconnected { reason });
    });

    let connection = ready_rx
        .await
        .map_err(|_| AcpError::other("driver task panicked before initialize"))??;

    Ok(AgentRuntime {
        connection,
        pending_permissions: pending,
        shutdown_tx: Some(shutdown_tx),
    })
}

async fn run_driver(
    agent_id: AgentId,
    command: String,
    sink: Arc<dyn EventSink>,
    pending: Arc<PendingPermissions>,
    ready_tx: oneshot::Sender<Result<ConnectionTo<Agent>>>,
    shutdown_rx: oneshot::Receiver<()>,
) -> Result<()> {
    let sink_dbg = sink.clone();
    let agent = AcpAgent::from_str(&command)?.with_debug(move |line, direction| {
        // Stderr lines from the agent process are the most useful for
        // post-mortem debugging — surface them through `tracing` so the host
        // can subscribe with the regular logging machinery.
        match direction {
            LineDirection::Stderr => {
                tracing::warn!(target: "atlas_acp::agent_stderr", agent = ?agent_id, "{line}");
            }
            LineDirection::Stdin => {
                tracing::trace!(target: "atlas_acp::stdin", agent = ?agent_id, "{line}");
            }
            LineDirection::Stdout => {
                tracing::trace!(target: "atlas_acp::stdout", agent = ?agent_id, "{line}");
            }
        }
        let _ = &sink_dbg; // keep sink alive in this scope; reserved for future ring-buffer
    });

    let sink_notif = sink.clone();
    let sink_perm = sink.clone();
    let pending_for_handler = pending.clone();

    agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                sink_notif.emit(
                    agent_id,
                    AcpEvent::SessionUpdate {
                        session_id: notification.session_id,
                        update: notification.update,
                    },
                );
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                let request_id = Uuid::new_v4();
                let (tx, rx) = oneshot::channel::<RequestPermissionOutcome>();
                pending_for_handler.insert(
                    request_id,
                    PendingPermissionEntry {
                        session_id: request.session_id.clone(),
                        sender: tx,
                    },
                );

                sink_perm.emit(
                    agent_id,
                    AcpEvent::PermissionRequest {
                        request_id,
                        session_id: request.session_id.clone(),
                        tool_call: request.tool_call.clone(),
                        options: request.options.clone(),
                    },
                );

                let outcome = rx.await.unwrap_or_else(|_| {
                    // Sender dropped (registry kill, app shutdown, cancel_turn) —
                    // ACP spec: treat as Cancelled.
                    RequestPermissionOutcome::Cancelled
                });
                pending_for_handler.remove(&request_id);

                responder.respond(RequestPermissionResponse::new(outcome))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            let init_result = connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await;

            match init_result {
                Ok(_) => {
                    let _ = ready_tx.send(Ok(connection.clone()));
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(AcpError::Protocol(format!("{e:?}"))));
                    return Err(e);
                }
            }

            // Park until the host asks us to shut down. The protocol stays
            // open as long as this future is alive; closing it lets the SDK
            // tear down the subprocess cleanly.
            let _ = shutdown_rx.await;
            Ok(())
        })
        .await?;

    Ok(())
}

