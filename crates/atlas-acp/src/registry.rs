use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::{
    CancelNotification, ContentBlock, NewSessionRequest, NewSessionResponse, PermissionOptionId,
    PromptRequest, RequestPermissionOutcome, SelectedPermissionOutcome, SessionId, StopReason,
    TextContent,
};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::driver::{self, AgentRuntime};
use crate::error::{AcpError, Result};
use crate::events::{AcpEvent, EventSink};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AgentId(pub Uuid);

impl AgentId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for AgentId {
    fn default() -> Self {
        Self::new()
    }
}

/// Description of an agent process that Atlas knows how to spawn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpec {
    pub spec_id: String,
    pub display_name: String,
    /// Shell-words–parseable command string.
    pub command: String,
}

impl AgentSpec {
    pub fn claude_code_ts() -> Self {
        Self {
            spec_id: "claude-code-ts".into(),
            display_name: "Claude Code (canonical)".into(),
            command: "npx -y @zed-industries/claude-code-acp".into(),
        }
    }

    pub fn claude_code_rs() -> Self {
        Self {
            spec_id: "claude-code-rs".into(),
            display_name: "Claude Code (Rust)".into(),
            command: "claude-code-acp-rs".into(),
        }
    }

    pub fn all_known() -> Vec<AgentSpec> {
        vec![Self::claude_code_ts(), Self::claude_code_rs()]
    }
}

/// Public view of a spawned agent — what the Tauri layer hands back to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub agent_id: AgentId,
    pub spec_id: String,
    pub display_name: String,
}

/// Public view of a newly created session — what gets returned to the UI.
/// `NewSessionResponse` from the schema is `#[non_exhaustive]`, so we project
/// the bits we actually want to expose.
#[derive(Debug, Clone, Serialize)]
pub struct NewSessionInfo {
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<serde_json::Value>,
}

impl From<NewSessionResponse> for NewSessionInfo {
    fn from(resp: NewSessionResponse) -> Self {
        // Round-trip via serde_json so we don't have to hand-port every nested
        // schema type (modes / models / config_options are all `non_exhaustive`
        // and gated on unstable features). The TS side already speaks JSON.
        let modes = resp.modes.as_ref().and_then(|m| serde_json::to_value(m).ok());
        let models = serde_json::to_value(&resp)
            .ok()
            .and_then(|v| v.get("models").cloned());
        Self {
            session_id: resp.session_id,
            modes,
            models,
        }
    }
}

struct AgentEntry {
    spec: AgentSpec,
    runtime: AgentRuntime,
}

/// Registry of live ACP agents. Cloneable handle — backed by an `Arc`.
#[derive(Clone, Default)]
pub struct AgentRegistry {
    inner: Arc<DashMap<AgentId, AgentEntry>>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn known_specs() -> Vec<AgentSpec> {
        AgentSpec::all_known()
    }

    pub fn list(&self) -> Vec<AgentInfo> {
        self.inner
            .iter()
            .map(|e| AgentInfo {
                agent_id: *e.key(),
                spec_id: e.spec.spec_id.clone(),
                display_name: e.spec.display_name.clone(),
            })
            .collect()
    }

    /// Spawn an agent matching `spec_id`. Resolves once the protocol
    /// handshake completes (or fails).
    pub async fn spawn(
        &self,
        spec_id: &str,
        sink: Arc<dyn EventSink>,
    ) -> Result<AgentInfo> {
        let spec = AgentSpec::all_known()
            .into_iter()
            .find(|s| s.spec_id == spec_id)
            .ok_or_else(|| AcpError::UnknownSpec(spec_id.to_string()))?;

        let agent_id = AgentId::new();
        let runtime = driver::spawn_agent(agent_id, spec.command.clone(), sink).await?;

        let info = AgentInfo {
            agent_id,
            spec_id: spec.spec_id.clone(),
            display_name: spec.display_name.clone(),
        };
        self.inner.insert(agent_id, AgentEntry { spec, runtime });
        Ok(info)
    }

    pub fn kill(&self, agent_id: AgentId) -> Result<()> {
        let mut entry = self
            .inner
            .get_mut(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        if let Some(tx) = entry.runtime.shutdown_tx.take() {
            let _ = tx.send(());
        }
        drop(entry);
        self.inner.remove(&agent_id);
        Ok(())
    }

    /// Open a new session in `cwd` against the given agent.
    pub async fn new_session(&self, agent_id: AgentId, cwd: PathBuf) -> Result<NewSessionInfo> {
        let connection = self.connection(agent_id)?;
        let resp = connection
            .send_request(NewSessionRequest::new(cwd))
            .block_task()
            .await?;
        Ok(resp.into())
    }

    /// Send a single text prompt. Resolves with the turn's `StopReason` when
    /// the agent finishes streaming. Notifications fire over the event sink
    /// throughout the turn.
    pub async fn send_prompt(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        text: String,
    ) -> Result<StopReason> {
        let connection = self.connection(agent_id)?;
        let resp = connection
            .send_request(PromptRequest::new(
                session_id,
                vec![ContentBlock::Text(TextContent::new(text))],
            ))
            .block_task()
            .await?;
        Ok(resp.stop_reason)
    }

    /// Cancel an in-flight prompt turn. The agent will respond with
    /// `StopReason::Cancelled` on the still-awaiting `send_prompt` call.
    pub fn cancel_turn(&self, agent_id: AgentId, session_id: SessionId) -> Result<()> {
        let connection = self.connection(agent_id)?;
        connection
            .send_notification(CancelNotification::new(session_id))?;
        Ok(())
    }

    /// Resolve a permission request that the agent emitted earlier.
    pub fn respond_permission(
        &self,
        agent_id: AgentId,
        request_id: Uuid,
        outcome: PermissionDecision,
    ) -> Result<()> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        let (_, tx) = entry
            .runtime
            .pending_permissions
            .remove(&request_id)
            .ok_or(AcpError::UnknownPermissionRequest(request_id))?;
        let resolved = match outcome {
            PermissionDecision::Selected(opt_id) => RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(PermissionOptionId::new(opt_id)),
            ),
            PermissionDecision::Cancelled => RequestPermissionOutcome::Cancelled,
        };
        tx.send(resolved)
            .map_err(|_| AcpError::other("permission handler already dropped"))?;
        Ok(())
    }

    fn connection(&self, agent_id: AgentId) -> Result<agent_client_protocol::ConnectionTo<agent_client_protocol::Agent>> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        Ok(entry.runtime.connection.clone())
    }
}

/// Frontend-friendly permission outcome — the schema's enum is non_exhaustive
/// and has Selected wrapping a struct, awkward to serialize across the wire.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum PermissionDecision {
    Selected(String),
    Cancelled,
}

/// Convenience entrypoint: strip `CLAUDECODE` from the host environment so
/// `@zed-industries/claude-code-acp` doesn't refuse to start when Atlas itself
/// was launched from a parent Claude Code session.
pub fn sanitize_host_env() {
    // SAFETY: called once at startup before any threads spawn child processes.
    // remove_var is unsafe on the 2024 edition because mutating env in a
    // multithreaded program is racy; we accept that risk here at boot.
    unsafe {
        std::env::remove_var("CLAUDECODE");
    }
    let _ = AcpEvent::AgentDisconnected {
        reason: String::new(),
    }; // touch enum to keep import path used in re-exports
}
