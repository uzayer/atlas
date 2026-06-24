//! Backend abstraction over the two agent transports.
//!
//! `atlas-agents`' manager + worker are agent-agnostic above the `EventSink` /
//! `AcpEvent` boundary. This trait captures exactly the operations they invoke
//! on a backend, so a session can be driven by either:
//!
//! - [`AcpBackend`] — the out-of-process ACP agents (Claude Code, Codex),
//!   delegating to `atlas_acp::AgentRegistry`, or
//! - [`CerseiBackend`] — the in-process native agent, delegating to
//!   `atlas_cersei::CerseiRuntime`.
//!
//! Both emit the same `AcpEvent`s through the same sink, so everything
//! downstream (dispatch, `SessionState`, the UI) is identical.

use std::path::PathBuf;

use async_trait::async_trait;
use atlas_acp::{
    AgentRegistry, AuthMethodWire, NewSessionInfo, PermissionDecision, Result as AcpResult,
};
use atlas_acp::{AgentId, SessionId};
use atlas_cersei::CerseiRuntime;
use uuid::Uuid;

/// The slice of agent-transport behaviour the manager + worker depend on.
#[async_trait]
pub trait AgentBackend: Send + Sync {
    async fn new_session(&self, agent_id: AgentId, cwd: PathBuf) -> AcpResult<NewSessionInfo>;
    async fn load_session(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        cwd: PathBuf,
    ) -> AcpResult<Option<serde_json::Value>>;
    /// Drive one prompt turn; returns the lowercased stop-reason token.
    async fn send_prompt(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        text: String,
    ) -> AcpResult<String>;
    async fn set_session_mode(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        mode_id: String,
    ) -> AcpResult<()>;
    /// Update the session's model. Default: no-op (ACP agents take model via
    /// their own notifications).
    fn set_model(&self, _agent_id: AgentId, _session_id: &SessionId, _model: String) -> AcpResult<()> {
        Ok(())
    }
    /// Update the session's reasoning-effort level. Default: no-op (only the
    /// native agent applies a thinking budget).
    fn set_effort(&self, _agent_id: AgentId, _session_id: &SessionId, _effort: String) -> AcpResult<()> {
        Ok(())
    }
    /// Toggle RTK tool-output compression. Default: no-op (native agent only).
    fn set_compress(&self, _agent_id: AgentId, _session_id: &SessionId, _on: bool) -> AcpResult<()> {
        Ok(())
    }
    fn mark_turn_started(&self, agent_id: AgentId, session_id: &SessionId) -> AcpResult<()>;
    fn cancel_turn(&self, agent_id: AgentId, session_id: SessionId) -> AcpResult<()>;
    fn respond_permission(
        &self,
        agent_id: AgentId,
        request_id: Uuid,
        decision: PermissionDecision,
    ) -> AcpResult<()>;
    fn register_session(&self, agent_id: AgentId, session_id: SessionId) -> AcpResult<()>;
    fn drop_session(&self, agent_id: AgentId, session_id: &SessionId) -> AcpResult<()>;
    fn auth_methods(&self, agent_id: AgentId) -> AcpResult<Vec<AuthMethodWire>>;
    async fn authenticate(&self, agent_id: AgentId, method_id: String) -> AcpResult<()>;
    fn kill(&self, agent_id: AgentId) -> AcpResult<()>;
}

fn session_id_str(id: &SessionId) -> String {
    serde_json::to_value(id)
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

// ─── ACP (subprocess) backend ─────────────────────────────────────────────────

/// Wraps the shared `AgentRegistry`. Cloneable (registry is `Arc`-backed).
#[derive(Clone)]
pub struct AcpBackend(pub AgentRegistry);

#[async_trait]
impl AgentBackend for AcpBackend {
    async fn new_session(&self, agent_id: AgentId, cwd: PathBuf) -> AcpResult<NewSessionInfo> {
        self.0.new_session(agent_id, cwd).await
    }
    async fn load_session(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        cwd: PathBuf,
    ) -> AcpResult<Option<serde_json::Value>> {
        self.0.load_session(agent_id, session_id, cwd).await
    }
    async fn send_prompt(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        text: String,
    ) -> AcpResult<String> {
        let reason = self.0.send_prompt(agent_id, session_id, text).await?;
        Ok(format!("{reason:?}").to_ascii_lowercase())
    }
    async fn set_session_mode(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        mode_id: String,
    ) -> AcpResult<()> {
        self.0.set_session_mode(agent_id, session_id, mode_id).await
    }
    fn mark_turn_started(&self, agent_id: AgentId, session_id: &SessionId) -> AcpResult<()> {
        self.0.mark_turn_started(agent_id, session_id)
    }
    fn cancel_turn(&self, agent_id: AgentId, session_id: SessionId) -> AcpResult<()> {
        self.0.cancel_turn(agent_id, session_id)
    }
    fn respond_permission(
        &self,
        agent_id: AgentId,
        request_id: Uuid,
        decision: PermissionDecision,
    ) -> AcpResult<()> {
        self.0.respond_permission(agent_id, request_id, decision)
    }
    fn register_session(&self, agent_id: AgentId, session_id: SessionId) -> AcpResult<()> {
        self.0.register_session(agent_id, session_id)
    }
    fn drop_session(&self, agent_id: AgentId, session_id: &SessionId) -> AcpResult<()> {
        self.0.drop_session(agent_id, session_id)
    }
    fn auth_methods(&self, agent_id: AgentId) -> AcpResult<Vec<AuthMethodWire>> {
        self.0.auth_methods(agent_id)
    }
    async fn authenticate(&self, agent_id: AgentId, method_id: String) -> AcpResult<()> {
        self.0.authenticate(agent_id, method_id).await
    }
    fn kill(&self, agent_id: AgentId) -> AcpResult<()> {
        self.0.kill(agent_id)
    }
}

// ─── Cersei (in-process) backend ──────────────────────────────────────────────

/// Wraps the native `CerseiRuntime`. Cloneable (`Arc`-backed).
#[derive(Clone)]
pub struct CerseiBackend(pub CerseiRuntime);

#[async_trait]
impl AgentBackend for CerseiBackend {
    async fn new_session(&self, agent_id: AgentId, cwd: PathBuf) -> AcpResult<NewSessionInfo> {
        self.0.new_session(agent_id, cwd)
    }
    async fn load_session(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        cwd: PathBuf,
    ) -> AcpResult<Option<serde_json::Value>> {
        self.0.load_session(agent_id, session_id, cwd)
    }
    async fn send_prompt(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        text: String,
    ) -> AcpResult<String> {
        self.0.send_prompt(agent_id, session_id, text).await
    }
    async fn set_session_mode(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        mode_id: String,
    ) -> AcpResult<()> {
        self.0.set_session_mode(agent_id, &session_id_str(&session_id), mode_id)
    }
    fn set_model(&self, agent_id: AgentId, session_id: &SessionId, model: String) -> AcpResult<()> {
        self.0.set_model(agent_id, &session_id_str(session_id), model)
    }
    fn set_effort(&self, agent_id: AgentId, session_id: &SessionId, effort: String) -> AcpResult<()> {
        self.0.set_effort(agent_id, &session_id_str(session_id), effort)
    }
    fn set_compress(&self, agent_id: AgentId, session_id: &SessionId, on: bool) -> AcpResult<()> {
        self.0.set_compress(agent_id, &session_id_str(session_id), on)
    }
    fn mark_turn_started(&self, _agent_id: AgentId, _session_id: &SessionId) -> AcpResult<()> {
        Ok(())
    }
    fn cancel_turn(&self, agent_id: AgentId, session_id: SessionId) -> AcpResult<()> {
        self.0.cancel_turn(agent_id, &session_id_str(&session_id))
    }
    fn respond_permission(
        &self,
        agent_id: AgentId,
        request_id: Uuid,
        decision: PermissionDecision,
    ) -> AcpResult<()> {
        self.0.respond_permission(agent_id, request_id, decision)
    }
    fn register_session(&self, _agent_id: AgentId, _session_id: SessionId) -> AcpResult<()> {
        // The runtime registers sessions itself in new_session / load_session.
        Ok(())
    }
    fn drop_session(&self, _agent_id: AgentId, _session_id: &SessionId) -> AcpResult<()> {
        Ok(())
    }
    fn auth_methods(&self, _agent_id: AgentId) -> AcpResult<Vec<AuthMethodWire>> {
        Ok(Vec::new())
    }
    async fn authenticate(&self, _agent_id: AgentId, _method_id: String) -> AcpResult<()> {
        Ok(())
    }
    fn kill(&self, agent_id: AgentId) -> AcpResult<()> {
        self.0.kill(agent_id)
    }
}
