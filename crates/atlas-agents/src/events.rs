//! Wire shape for session-scoped delta events.
//!
//! These are produced by the manager (when ACP notifications arrive) and the
//! per-session worker (status flips around send_prompt). They are routed
//! through a `DeltaSink` impl provided by the Tauri host — typically a
//! window-event emitter — and also fan out through a per-session
//! `tokio::sync::broadcast::Sender` for in-process subscribers.

use serde::Serialize;

use atlas_acp::AgentId;
use uuid::Uuid;

use crate::session::{Message, PlanEntry, SessionStatus, ToolCall, Usage};

/// One change to one session. Tagged on the wire by `kind`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SessionDelta {
    Status {
        status: SessionStatus,
        /// Turn identity this status belongs to (see `SessionState::turn_seq`).
        /// Lets the frontend drop a stale terminal `idle`/`error` that belongs
        /// to a turn already superseded by a newer send. 0 = untracked/current.
        #[serde(default)]
        turn_seq: u64,
    },
    /// A fresh message was appended to the tail of `messages`. UI should push
    /// it onto its local mirror.
    MessageAppended {
        message: Message,
    },
    /// Append text to an existing assistant message's `content`.
    TextChunk {
        message_id: String,
        delta: String,
    },
    /// Append text to an existing assistant message's `thinking` field.
    ThinkingChunk {
        message_id: String,
        delta: String,
    },
    /// Tool call inside a message was created or updated in place. The full
    /// snapshot is sent so the UI doesn't have to merge fields.
    ToolCallUpserted {
        message_id: String,
        tool_call: ToolCall,
    },
    PlanUpdated {
        plan: Vec<PlanEntry>,
    },
    ModeChanged {
        mode_id: String,
    },
    ModelChanged {
        model_id: String,
    },
    AvailableCommands {
        commands: Vec<serde_json::Value>,
    },
    UsageUpdated {
        usage: Usage,
    },
    /// Context compaction is running (`active = true`) or just finished.
    Compaction {
        active: bool,
    },
    /// Approx tokens RTK compression saved on this turn (native agent).
    CompressionSaved {
        saved_tokens: u64,
    },
    /// Agent requested permission for a tool call. The UI's permission inbox
    /// owns this — `respond_permission` resolves it back through atlas-acp.
    PermissionRequest {
        request_id: Uuid,
        tool_call: serde_json::Value,
        options: serde_json::Value,
    },
    /// Permission was resolved (by the user or by cancellation).
    PermissionResolved {
        request_id: Uuid,
    },
    TurnFinished {
        stop_reason: String,
        /// Turn identity (see `SessionState::turn_seq`); frontend rejects a
        /// terminal for a superseded turn. 0 = untracked/current.
        #[serde(default)]
        turn_seq: u64,
    },
    TurnFailed {
        error: String,
        #[serde(default)]
        turn_seq: u64,
    },
    /// Underlying ACP agent process died.
    AgentDisconnected {
        reason: String,
    },
}

/// Envelope shipped through the Tauri event channel — keys for routing.
#[derive(Debug, Clone, Serialize)]
pub struct SessionDeltaEnvelope {
    pub agent_id: AgentId,
    pub session_id: String,
    #[serde(flatten)]
    pub delta: SessionDelta,
}

/// Implemented by the Tauri host to fan deltas out to the renderer.
pub trait DeltaSink: Send + Sync + 'static {
    fn emit(&self, envelope: SessionDeltaEnvelope);
}
