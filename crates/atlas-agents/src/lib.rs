//! atlas-agents — multi-agent orchestration above `atlas-acp`.
//!
//! Rust owns per-session state. The UI is a thin event consumer: it fetches a
//! snapshot on tab activate and subscribes to a per-session delta stream.
//!
//! Layers:
//! - `plugin`     — descriptors for spawnable agents (claude / codex / opencode)
//! - `manager`    — multi-agent / multi-session registry, wraps `atlas_acp::AgentRegistry`
//! - `session`    — `SessionState` + serializable `SessionSnapshot`
//! - `worker`     — one tokio task per session; drains a command queue,
//!                  serialises send-prompt turns, never blocks the UI
//! - `events`     — `SessionDelta` wire shape + `DeltaSink` trait
//! - `transcript` — JSONL replay (claude-code transcripts) for `load_session`

pub mod backend;
pub mod error;
pub mod events;
pub mod manager;
pub mod plugin;
pub mod session;
pub mod transcript;
pub mod worker;

pub use atlas_cersei::SessionMeta;
pub use backend::{AcpBackend, AgentBackend, CerseiBackend};
pub use error::{Error, Result};
pub use events::{DeltaSink, SessionDelta, SessionDeltaEnvelope};
pub use manager::{AgentManager, SessionKey};
pub use plugin::{PluginSpec, TranscriptKind, builtin_plugins, find_plugin};
pub use session::{
    Message, MessageMode, MessageRole, PlanEntry, SessionSnapshot, SessionStatus, ToolCall,
    ToolCallStatus, Usage,
};

// Re-export common atlas-acp identifiers so the Tauri layer only needs to
// depend on this crate for the high-level surface.
pub use atlas_acp::{AgentId, AgentInfo, AuthMethodWire, PermissionDecision, SessionId, StopReason};
