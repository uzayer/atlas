use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::{
    CancelNotification, ContentBlock, LoadSessionRequest, NewSessionRequest, NewSessionResponse,
    PermissionOptionId, PromptRequest, RequestPermissionOutcome, SelectedPermissionOutcome,
    SessionId, SessionModeId, SetSessionModeRequest, StopReason, TextContent,
};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::driver::{self, AgentRuntime, AuthMethodWire, SessionGuard};
use crate::error::{AcpError, Result};
use crate::events::EventSink;

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
            // Upstream rename: `@zed-industries/claude-code-acp` was renamed
            // to `@agentclientprotocol/claude-agent-acp`. The old name still
            // resolves but no longer receives updates.
            command: "npx -y @agentclientprotocol/claude-agent-acp".into(),
        }
    }

    pub fn claude_code_rs() -> Self {
        Self {
            spec_id: "claude-code-rs".into(),
            display_name: "Claude Code (Rust)".into(),
            command: "claude-code-acp-rs".into(),
        }
    }

    /// Codex ACP bridge. The actual command is a placeholder until OpenAI ships
    /// an official ACP adapter — once it's live, swap the command string and
    /// the multi-agent UI picks it up automatically.
    pub fn codex() -> Self {
        Self {
            spec_id: "codex".into(),
            display_name: "Codex (ACP)".into(),
            command: "codex-acp".into(),
        }
    }

    /// OpenCode ACP bridge. Same placeholder caveat as `codex()`.
    pub fn opencode() -> Self {
        Self {
            spec_id: "opencode".into(),
            display_name: "OpenCode (ACP)".into(),
            command: "opencode-acp".into(),
        }
    }

    pub fn all_known() -> Vec<AgentSpec> {
        vec![
            Self::claude_code_ts(),
            Self::claude_code_rs(),
            Self::codex(),
            Self::opencode(),
        ]
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

    /// Open a new session in `cwd` against the given agent. Registers
    /// a `SessionGuard` for the returned session id so the driver can
    /// gate inbound traffic on the session's lifecycle.
    pub async fn new_session(&self, agent_id: AgentId, cwd: PathBuf) -> Result<NewSessionInfo> {
        let connection = self.connection(agent_id)?;
        let resp = connection
            .send_request(NewSessionRequest::new(cwd))
            .block_task()
            .await?;
        self.register_session(agent_id, resp.session_id.clone())?;
        Ok(resp.into())
    }

    /// Resume a previously-saved session by id. Same guard registration
    /// as `new_session` — the resumed session can be cancelled / killed
    /// through the normal flow.
    pub async fn load_session(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        cwd: PathBuf,
    ) -> Result<()> {
        let connection = self.connection(agent_id)?;
        connection
            .send_request(LoadSessionRequest::new(session_id.clone(), cwd))
            .block_task()
            .await?;
        self.register_session(agent_id, session_id)?;
        Ok(())
    }

    /// Install a lifecycle guard for a session. Idempotent — if a
    /// guard for this session already exists, the call is a no-op.
    /// Called from `new_session` / `load_session`.
    pub fn register_session(&self, agent_id: AgentId, session_id: SessionId) -> Result<()> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        entry
            .runtime
            .session_guards
            .entry(session_id)
            .or_insert_with(|| Arc::new(SessionGuard::new()));
        Ok(())
    }

    /// Remove a session's guard. Called when the host-side session
    /// representation is being torn down (tab close, project switch,
    /// agent kill) so the driver's gates drop any further inbound
    /// traffic for this id.
    pub fn drop_session(&self, agent_id: AgentId, session_id: &SessionId) -> Result<()> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        entry.runtime.session_guards.remove(session_id);
        Ok(())
    }

    /// Re-arm the session's guard before starting a new turn. Bumps
    /// the turn epoch and clears the `cancelled` flag so inbound
    /// notifications / permission requests for this turn flow
    /// through. Called by the worker right before `send_prompt`.
    pub fn mark_turn_started(
        &self,
        agent_id: AgentId,
        session_id: &SessionId,
    ) -> Result<()> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        if let Some(guard) = entry.runtime.session_guards.get(session_id) {
            guard.mark_turn_started();
        } else {
            // Race: send arrived before register_session finished, or
            // the session was just dropped. Install a fresh guard so
            // the turn isn't auto-blocked.
            entry
                .runtime
                .session_guards
                .insert(session_id.clone(), Arc::new(SessionGuard::new()));
        }
        Ok(())
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

    /// Switch the session's permission mode (default / acceptEdits / plan /
    /// dontAsk / bypassPermissions). Calling this with `bypassPermissions`
    /// stops the agent from ever emitting `RequestPermissionRequest` — the
    /// fix for "bypass mode still prompts".
    pub async fn set_session_mode(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        mode_id: String,
    ) -> Result<()> {
        let connection = self.connection(agent_id)?;
        connection
            .send_request(SetSessionModeRequest::new(
                session_id,
                SessionModeId::new(mode_id),
            ))
            .block_task()
            .await?;
        Ok(())
    }

    /// Cancel an in-flight prompt turn. Three things happen:
    ///
    /// 1. The session's lifecycle guard is marked `cancelled`. From
    ///    this point until the next `mark_turn_started`, the driver
    ///    drops every inbound notification / permission request for
    ///    this session at the protocol boundary — no late popups, no
    ///    transcript contamination.
    /// 2. Already-pending permission senders are dropped so the
    ///    driver's `rx.await` resolves as `Cancelled` and the agent
    ///    gets a clean answer for in-flight requests.
    /// 3. `CancelNotification` is sent so the agent winds down the
    ///    turn and replies to `send_prompt` with
    ///    `StopReason::Cancelled` per ACP spec.
    pub fn cancel_turn(&self, agent_id: AgentId, session_id: SessionId) -> Result<()> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        if let Some(guard) = entry.runtime.session_guards.get(&session_id) {
            guard.mark_cancelled();
        }
        entry
            .runtime
            .pending_permissions
            .retain(|_, p| p.session_id != session_id);
        let connection = entry.runtime.connection.clone();
        drop(entry);
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
        let (_, pending) = entry
            .runtime
            .pending_permissions
            .remove(&request_id)
            .ok_or(AcpError::UnknownPermissionRequest(request_id))?;
        let resolved = match outcome {
            PermissionDecision::Selected { option_id } => RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(PermissionOptionId::new(option_id)),
            ),
            PermissionDecision::Cancelled => RequestPermissionOutcome::Cancelled,
        };
        pending
            .sender
            .send(resolved)
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

    /// Auth methods the agent advertised in its `initialize` response.
    /// Empty if the agent doesn't support any (or didn't run `initialize`
    /// successfully — though spawn would have errored in that case).
    pub fn auth_methods(&self, agent_id: AgentId) -> Result<Vec<AuthMethodWire>> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        Ok(entry.runtime.auth_methods.clone())
    }
}

/// Frontend-friendly permission outcome — the schema's enum is non_exhaustive
/// and has Selected wrapping a struct, awkward to serialize across the wire.
///
/// Struct variant (not tuple) because serde's internal tagging (`tag = "..."`)
/// only supports struct or unit variants; a tuple variant would silently lose
/// the inner value when deserialised across the Tauri boundary.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum PermissionDecision {
    Selected { option_id: String },
    Cancelled,
}

/// Startup-time host environment fix-ups for the ACP agent process.
///
/// Two concrete problems this addresses:
///
/// 1. **`CLAUDECODE` env var leak.** The canonical
///    `@zed-industries/claude-code-acp` agent refuses to start when it sees
///    `CLAUDECODE` set in its env (anti-nesting guard). If Atlas itself was
///    launched from a parent Claude Code shell that var leaks into every
///    spawned child. Strip it.
///
/// 2. **Minimal PATH in macOS GUI apps.** When Atlas is launched from
///    Finder/the Dock the process PATH is only
///    `/usr/bin:/bin:/usr/sbin:/sbin` — `npx` (used to fetch the canonical
///    ACP agent), `node`, `bun`, `claude`, Homebrew binaries, etc. are all
///    missing. Without this enrichment `acp_spawn_agent` fails with ENOENT
///    in the bundled app even though everything works from a terminal.
pub fn sanitize_host_env() {
    // SAFETY: called once at startup before any threads spawn child processes.
    // remove_var/set_var are unsafe on the 2024 edition because mutating env
    // in a multithreaded program is racy; we accept that risk here at boot.
    unsafe {
        std::env::remove_var("CLAUDECODE");
    }
    enrich_path();
}

fn enrich_path() {
    // Split into two passes:
    //
    // 1. The cheap, deterministic prepends (~$HOME/.local/bin, .bun, .cargo,
    //    /opt/homebrew/{bin,sbin}, /usr/local/{bin,sbin}, /usr/{bin,sbin})
    //    happen synchronously so the very first `acp_spawn_agent` call can
    //    already resolve `npx`/`node` from a Homebrew install.
    //
    // 2. The `~/.nvm/versions/node/*` enumeration is moved to a background
    //    thread. nvm doesn't symlink to a stable path so the directory walk
    //    is unavoidable, and it can take ~100ms+ when many node versions are
    //    installed. The walk runs while React paints the first frame; by the
    //    time the user focuses the composer and the agent spawn kicks off
    //    the additional PATH entries are in place. Homebrew/system node is
    //    the fallback in the brief window before the walk lands.
    apply_cheap_path_extras();
    spawn_nvm_path_walk();
}

fn apply_cheap_path_extras() {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut extras: Vec<String> = Vec::new();
    if !home.is_empty() {
        extras.push(format!("{home}/.local/bin"));
        extras.push(format!("{home}/.bun/bin"));
        extras.push(format!("{home}/.cargo/bin"));
    }
    extras.push("/opt/homebrew/bin".into());
    extras.push("/opt/homebrew/sbin".into());
    extras.push("/usr/local/bin".into());
    extras.push("/usr/local/sbin".into());
    extras.push("/usr/bin".into());
    extras.push("/bin".into());
    prepend_to_path(&extras);
}

fn spawn_nvm_path_walk() {
    let home = match std::env::var("HOME") {
        Ok(h) if !h.is_empty() => h,
        _ => return,
    };
    std::thread::spawn(move || {
        let nvm_root = std::path::PathBuf::from(&home)
            .join(".nvm")
            .join("versions")
            .join("node");
        let Ok(entries) = std::fs::read_dir(&nvm_root) else {
            return;
        };
        let mut versions: Vec<_> = entries
            .flatten()
            .map(|e| e.path().join("bin"))
            .filter(|p| p.is_dir())
            .collect();
        // Newest version first (lexicographic — fine for vMAJOR.MINOR.PATCH).
        versions.sort();
        versions.reverse();
        let extras: Vec<String> = versions
            .into_iter()
            .map(|v| v.to_string_lossy().into_owned())
            .collect();
        if extras.is_empty() {
            return;
        }
        prepend_to_path(&extras);
    });
}

fn prepend_to_path(extras: &[String]) {
    let base = std::env::var("PATH").unwrap_or_default();
    let mut path_parts: Vec<String> = if base.is_empty() {
        Vec::new()
    } else {
        base.split(':').map(String::from).collect()
    };

    // Prepend extras (in reverse so the first listed wins after all inserts),
    // skipping anything already on PATH.
    for extra in extras.iter().rev() {
        if !path_parts.iter().any(|p| p == extra) {
            path_parts.insert(0, extra.clone());
        }
    }

    let new_path = path_parts.join(":");
    // SAFETY: see `sanitize_host_env` — env mutation is racy in a multithreaded
    // program. The background thread runs only after `sanitize_host_env` has
    // returned and Tauri has started; any concurrent child-process spawn will
    // either see the pre-nvm PATH (Homebrew node, fine) or the post-nvm PATH
    // (nvm-managed node). Both are valid PATH values.
    unsafe {
        std::env::set_var("PATH", new_path);
    }
}
