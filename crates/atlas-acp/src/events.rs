use agent_client_protocol::schema as acp_schema;
use serde::Serialize;
use uuid::Uuid;

use crate::registry::AgentId;

/// Single payload type that the driver pushes through [`EventSink`].
///
/// One event per ACP protocol-level message that the UI cares about. Wire format is
/// deliberately flat (`kind` + variant fields) so the TS side can pattern-match
/// without unwrapping a tagged union envelope.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AcpEvent {
    /// Driver finished `connect_with` (process exited or protocol shut down).
    AgentDisconnected {
        reason: String,
    },
    /// Agent emitted a `session/update` notification — forwarded raw so the UI
    /// can pattern-match on the full `SessionUpdate` enum (text, tool_call,
    /// plan, available_commands, mode change, etc).
    SessionUpdate {
        session_id: acp_schema::SessionId,
        update: acp_schema::SessionUpdate,
    },
    /// Agent asked the client for permission for a tool call.
    /// Frontend must respond via `acp_respond_permission(request_id, option_id)`.
    PermissionRequest {
        request_id: Uuid,
        session_id: acp_schema::SessionId,
        tool_call: acp_schema::ToolCallUpdate,
        options: Vec<acp_schema::PermissionOption>,
    },
    /// A prompt-turn finished. The corresponding `acp_send_prompt` call has
    /// already returned, but the event is broadcast for any tab listening.
    TurnStopped {
        session_id: acp_schema::SessionId,
        turn_id: Uuid,
        stop_reason: acp_schema::StopReason,
    },
    /// A prompt-turn failed before stop_reason (process died, protocol error).
    TurnFailed {
        session_id: acp_schema::SessionId,
        turn_id: Uuid,
        error: String,
    },
    /// Cumulative token usage + estimated cost for the session. Emitted by the
    /// in-process native agent (ACP agents surface usage via their own updates).
    Usage {
        session_id: acp_schema::SessionId,
        input_tokens: u64,
        output_tokens: u64,
        cost: f64,
    },
    /// Context compaction started (`active = true`) or finished (`false`).
    /// Native-agent only.
    Compaction {
        session_id: acp_schema::SessionId,
        active: bool,
    },
}

/// Implemented by the Tauri host so the driver can fan events out without
/// depending on `tauri` directly.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, agent_id: AgentId, event: AcpEvent);
}
