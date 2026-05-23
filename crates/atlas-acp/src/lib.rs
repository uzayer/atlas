//! atlas-acp — ACP client plumbing for the Atlas Tauri host.
//!
//! Implements the `Client` role of the Agent Client Protocol against one or
//! more spawned agent processes (canonical `@agentclientprotocol/claude-agent-acp`,
//! `claude-code-acp-rs`, or any other ACP-compatible agent).
//!
//! The crate is Tauri-independent: it exposes an [`EventSink`] trait that the
//! Tauri host implements to fan events out as window events.

pub mod driver;
pub mod error;
pub mod events;
pub mod registry;

pub use driver::AuthMethodWire;
pub use error::{AcpError, Result};
pub use events::{AcpEvent, EventSink};
pub use registry::{
    AgentId, AgentInfo, AgentRegistry, AgentSpec, NewSessionInfo, PermissionDecision,
    sanitize_host_env,
};

// Re-export schema types the host needs (so it doesn't have to take a direct
// dep on `agent-client-protocol-schema`).
pub use agent_client_protocol::schema::{SessionId, StopReason};
