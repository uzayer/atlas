//! atlas-cersei — Atlas's native, in-process coding agent on the Cersei SDK.
//!
//! Unlike the Claude Code / Codex agents (external subprocesses speaking ACP),
//! this agent runs *inside* the Atlas process: it drives a `cersei::Agent`
//! directly and **adapts Cersei's `AgentEvent` stream into the same `AcpEvent`
//! contract** the ACP driver emits ([`atlas_acp::EventSink`]). That lets
//! `atlas-agents`' dispatch/state/UI path consume it with zero changes —
//! streaming text, thinking, tool cards, permission prompts, and turn lifecycle
//! all flow through the existing pipeline.
//!
//! `CerseiRuntime` mirrors the slice of `atlas_acp::AgentRegistry`'s API that
//! `atlas-agents`' manager + worker call, so a thin `AgentBackend` adapter in
//! atlas-agents can route to either backend.

mod provider;
mod store;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use agent_client_protocol::schema as acp_schema;
use async_trait::async_trait;
use atlas_acp::{AcpError, AcpEvent, AgentId, AgentInfo, EventSink, NewSessionInfo, Result, SessionId};
use cersei::prelude::{PermissionDecision as CerseiDecision, PermissionPolicy, PermissionRequest};
use cersei::tools::PermissionLevel;
use cersei::types::Message;
use dashmap::DashMap;
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub use store::SessionMeta;

/// The plugin id the native agent registers under (matches the frontend
/// `AGENT_PLUGIN_ID.cersei`).
pub const CERSEI_PLUGIN_ID: &str = "cersei";
/// Display name shown in the agent picker / marks.
pub const CERSEI_DISPLAY_NAME: &str = "Atlas";

const SYSTEM_PROMPT: &str = "You are Atlas, a native coding agent embedded in the Atlas IDE. \
You help the user read, write, and reason about their codebase using the provided tools. \
Be concise and precise. Prefer making edits with the file tools over printing large blocks of code.";

/// One historical conversation item, in a UI-neutral shape so `atlas-agents`
/// can rebuild its own `Message` type on resume without depending on Cersei.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReplayItem {
    User { text: String },
    Assistant { text: String },
    Thinking { text: String },
    Tool {
        id: String,
        name: String,
        input: serde_json::Value,
        result: Option<String>,
        is_error: bool,
    },
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct CerseiRuntime {
    inner: Arc<Inner>,
}

struct Inner {
    /// App config dir (holds `byok-keys.json` + `cersei-sessions/`).
    config_dir: PathBuf,
    agents: DashMap<AgentId, AgentEntry>,
}

struct AgentEntry {
    sink: Arc<dyn EventSink>,
    sessions: DashMap<String, Arc<SessionEntry>>,
}

struct SessionEntry {
    #[allow(dead_code)]
    session_id: String,
    cwd: String,
    history: Mutex<Vec<Message>>,
    provider: Mutex<String>,
    model: Mutex<String>,
    /// Permission mode id (default / acceptEdits / plan / bypass).
    mode: Mutex<String>,
    /// Cancellation token for the in-flight turn, if any.
    cancel: Mutex<Option<CancellationToken>>,
    /// Pending permission requests awaiting a UI decision.
    pending: DashMap<Uuid, oneshot::Sender<CerseiDecision>>,
    cancelled: AtomicBool,
}

impl CerseiRuntime {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                config_dir,
                agents: DashMap::new(),
            }),
        }
    }

    /// Register a native agent. No process is spawned — this just allocates an
    /// id and stashes the event sink the turn loop will emit through.
    pub fn spawn(&self, sink: Arc<dyn EventSink>) -> AgentInfo {
        let agent_id = AgentId::new();
        self.inner.agents.insert(
            agent_id,
            AgentEntry {
                sink,
                sessions: DashMap::new(),
            },
        );
        AgentInfo {
            agent_id,
            spec_id: CERSEI_PLUGIN_ID.to_string(),
            display_name: CERSEI_DISPLAY_NAME.to_string(),
        }
    }

    pub fn kill(&self, agent_id: AgentId) -> Result<()> {
        self.inner.agents.remove(&agent_id);
        Ok(())
    }

    /// Open a new session. Picks a default provider+model from the configured
    /// BYOK keys and returns the synthesized mode list (ACP `SessionModeState`
    /// shape) so the existing mode picker renders.
    pub fn new_session(&self, agent_id: AgentId, cwd: PathBuf) -> Result<NewSessionInfo> {
        let agent = self.agent(agent_id)?;
        let session_id = Uuid::new_v4().to_string();
        let (provider, model) = self.default_provider_model();
        let entry = Arc::new(SessionEntry {
            session_id: session_id.clone(),
            cwd: cwd.to_string_lossy().into_owned(),
            history: Mutex::new(Vec::new()),
            provider: Mutex::new(provider),
            model: Mutex::new(model),
            mode: Mutex::new("default".into()),
            cancel: Mutex::new(None),
            pending: DashMap::new(),
            cancelled: AtomicBool::new(false),
        });
        agent.sessions.insert(session_id.clone(), entry);
        Ok(NewSessionInfo {
            session_id: SessionId::new(session_id),
            modes: Some(modes_blob("default")),
            models: None,
        })
    }

    /// Resume a stored session: restore its history into the runtime (for
    /// context continuation) and return its mode blob.
    pub fn load_session(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        cwd: PathBuf,
    ) -> Result<Option<serde_json::Value>> {
        let agent = self.agent(agent_id)?;
        let sid = session_id_str(&session_id);
        let cwd_str = cwd.to_string_lossy().into_owned();
        let stored = store::load(&self.inner.config_dir, &cwd_str, &sid);
        let (provider, model, history) = match stored {
            Some(doc) => (doc.provider, doc.model, doc.messages),
            None => {
                let (p, m) = self.default_provider_model();
                (p, m, Vec::new())
            }
        };
        let entry = Arc::new(SessionEntry {
            session_id: sid.clone(),
            cwd: cwd_str,
            history: Mutex::new(history),
            provider: Mutex::new(provider),
            model: Mutex::new(model),
            mode: Mutex::new("default".into()),
            cancel: Mutex::new(None),
            pending: DashMap::new(),
            cancelled: AtomicBool::new(false),
        });
        agent.sessions.insert(sid, entry);
        Ok(Some(modes_blob("default")))
    }

    /// UI-facing transcript for a stored session (for replay on resume).
    pub fn replay_session(&self, cwd: &str, session_id: &str) -> Vec<ReplayItem> {
        match store::load(&self.inner.config_dir, cwd, session_id) {
            Some(doc) => messages_to_replay(&doc.messages),
            None => Vec::new(),
        }
    }

    /// List stored sessions for a project (sidebar).
    pub fn list_sessions(&self, cwd: &str) -> Vec<SessionMeta> {
        store::list(&self.inner.config_dir, cwd)
    }

    pub fn set_session_mode(&self, agent_id: AgentId, session_id: &str, mode_id: String) -> Result<()> {
        let entry = self.session(agent_id, session_id)?;
        *entry.mode.lock() = mode_id;
        Ok(())
    }

    /// Set the session's model. Accepts `"provider/model"` or a bare model id
    /// (keeps the current provider).
    pub fn set_model(&self, agent_id: AgentId, session_id: &str, model: String) -> Result<()> {
        let entry = self.session(agent_id, session_id)?;
        if let Some((prov, m)) = model.split_once('/') {
            // Only treat the prefix as a provider if we recognise it; some model
            // ids legitimately contain a slash (e.g. "Qwen/Qwen3-Coder").
            if provider::default_model_for(prov).is_some() || provider::openai_base_url(prov).is_some() || prov == "anthropic" {
                *entry.provider.lock() = prov.to_string();
                *entry.model.lock() = m.to_string();
                return Ok(());
            }
        }
        *entry.model.lock() = model;
        Ok(())
    }

    /// Cancel the in-flight turn: flip the flag, drop pending permissions
    /// (so any blocked `check()` resolves), and cancel the agent token.
    pub fn cancel_turn(&self, agent_id: AgentId, session_id: &str) -> Result<()> {
        let entry = self.session(agent_id, session_id)?;
        entry.cancelled.store(true, Ordering::SeqCst);
        let keys: Vec<Uuid> = entry.pending.iter().map(|e| *e.key()).collect();
        for k in keys {
            if let Some((_, tx)) = entry.pending.remove(&k) {
                let _ = tx.send(CerseiDecision::Deny("cancelled".into()));
            }
        }
        if let Some(token) = entry.cancel.lock().as_ref() {
            token.cancel();
        }
        Ok(())
    }

    /// Resolve a pending permission request raised during a turn.
    pub fn respond_permission(
        &self,
        agent_id: AgentId,
        request_id: Uuid,
        decision: atlas_acp::PermissionDecision,
    ) -> Result<()> {
        let agent = self.agent(agent_id)?;
        // The request id is unique across sessions; find whichever session holds it.
        for s in agent.sessions.iter() {
            if let Some((_, tx)) = s.value().pending.remove(&request_id) {
                let _ = tx.send(map_decision(decision));
                return Ok(());
            }
        }
        Err(AcpError::UnknownPermissionRequest(request_id))
    }

    /// Drive one prompt turn to completion, emitting `AcpEvent`s as it streams.
    /// Returns the lowercased stop-reason token the worker forwards as
    /// `TurnFinished`.
    pub async fn send_prompt(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        text: String,
    ) -> Result<String> {
        let agent = self.agent(agent_id)?;
        let sid = session_id_str(&session_id);
        let entry = self.session(agent_id, &sid)?;
        let sink = agent.sink.clone();

        entry.cancelled.store(false, Ordering::SeqCst);

        // Resolve provider + key.
        let provider_id = entry.provider.lock().clone();
        let model = entry.model.lock().clone();
        if provider_id.is_empty() || model.is_empty() {
            return Err(AcpError::other(
                "No model selected for the Atlas agent. Add an API key in Settings → API Keys and pick a model.",
            ));
        }
        let api_key = store::byok_get(&self.inner.config_dir, &provider_id).ok_or_else(|| {
            AcpError::other(format!(
                "No API key configured for '{provider_id}'. Add one in Settings → API Keys."
            ))
        })?;
        let provider = provider::build_provider(&provider_id, &api_key, &model).map_err(AcpError::other)?;

        let history = entry.history.lock().clone();
        let mode = entry.mode.lock().clone();

        let policy = UiPolicy {
            sink: sink.clone(),
            agent_id,
            session_id: session_id.clone(),
            pending: entry.clone(),
            mode,
        };

        let token = CancellationToken::new();
        *entry.cancel.lock() = Some(token.clone());

        let built = cersei::Agent::builder()
            .provider_boxed(provider)
            .tools(cersei::tools::coding())
            .working_dir(PathBuf::from(&entry.cwd))
            .with_messages(history)
            .permission_policy(policy)
            .cancel_token(token)
            .system_prompt(SYSTEM_PROMPT)
            .model(model.clone())
            .max_turns(50)
            .auto_compact(true)
            .build()
            .map_err(|e| AcpError::other(format!("build agent: {e}")))?;
        let built = Arc::new(built);

        let mut stream = built.run_stream(&text);
        let mut stop = "endturn".to_string();
        while let Some(ev) = stream.next().await {
            use cersei::events::AgentEvent as E;
            match ev {
                E::TextDelta(s) => emit_chunk(&sink, agent_id, &session_id, "agent_message_chunk", &s),
                E::ThinkingDelta(s) => {
                    emit_chunk(&sink, agent_id, &session_id, "agent_thought_chunk", &s)
                }
                E::ToolStart { name, id, input } => {
                    emit_tool_call(&sink, agent_id, &session_id, &id, &name, input)
                }
                E::ToolEnd {
                    id,
                    result,
                    is_error,
                    ..
                } => emit_tool_update(&sink, agent_id, &session_id, &id, &result, is_error),
                E::TurnComplete { stop_reason, .. } => {
                    stop = map_stop(stop_reason).to_string();
                }
                E::Complete(out) => {
                    stop = map_stop(out.stop_reason).to_string();
                    break;
                }
                E::Error(e) => {
                    if entry.cancelled.load(Ordering::SeqCst) {
                        stop = "cancelled".to_string();
                        break;
                    }
                    *entry.cancel.lock() = None;
                    return Err(AcpError::other(e));
                }
                _ => {}
            }
        }

        if entry.cancelled.load(Ordering::SeqCst) {
            stop = "cancelled".to_string();
        }

        // Persist the updated conversation for resume + context continuation.
        let msgs = built.messages();
        *entry.history.lock() = msgs.clone();
        let now = chrono::Utc::now().to_rfc3339();
        store::save(
            &self.inner.config_dir,
            &entry.cwd,
            &sid,
            &provider_id,
            &model,
            &msgs,
            &now,
        );
        *entry.cancel.lock() = None;
        Ok(stop)
    }

    // ── internals ─────────────────────────────────────────────────────────────

    fn agent(&self, agent_id: AgentId) -> Result<dashmap::mapref::one::Ref<'_, AgentId, AgentEntry>> {
        self.inner.agents.get(&agent_id).ok_or(AcpError::UnknownAgent)
    }

    fn session(&self, agent_id: AgentId, session_id: &str) -> Result<Arc<SessionEntry>> {
        let agent = self.agent(agent_id)?;
        agent
            .sessions
            .get(session_id)
            .map(|e| e.value().clone())
            .ok_or(AcpError::UnknownSession)
    }

    /// First configured BYOK provider (by priority) + its default model. Empty
    /// strings when nothing is configured (send_prompt then errors helpfully).
    fn default_provider_model(&self) -> (String, String) {
        let configured = store::byok_providers(&self.inner.config_dir);
        for p in provider::PROVIDER_PRIORITY {
            if configured.iter().any(|c| c == p) {
                if let Some(m) = provider::default_model_for(p) {
                    return (p.to_string(), m.to_string());
                }
            }
        }
        // Fall back to the first configured provider with any known default.
        for c in &configured {
            if let Some(m) = provider::default_model_for(c) {
                return (c.clone(), m.to_string());
            }
        }
        (String::new(), String::new())
    }
}

// ─── Permission policy ────────────────────────────────────────────────────────

struct UiPolicy {
    sink: Arc<dyn EventSink>,
    agent_id: AgentId,
    session_id: SessionId,
    pending: Arc<SessionEntry>,
    mode: String,
}

#[async_trait]
impl PermissionPolicy for UiPolicy {
    async fn check(&self, request: &PermissionRequest) -> CerseiDecision {
        // Mode shortcuts that don't need a prompt.
        match self.mode.as_str() {
            "bypass" => return CerseiDecision::Allow,
            "plan" => {
                return match request.permission_level {
                    PermissionLevel::None | PermissionLevel::ReadOnly => CerseiDecision::Allow,
                    _ => CerseiDecision::Deny(
                        "Plan mode is read-only — switch modes to make changes.".into(),
                    ),
                };
            }
            "acceptEdits" => {
                // Auto-allow file edits/reads; still prompt for shell/dangerous.
                if matches!(
                    request.permission_level,
                    PermissionLevel::None | PermissionLevel::ReadOnly | PermissionLevel::Write
                ) {
                    return CerseiDecision::Allow;
                }
            }
            _ => {}
        }
        if matches!(request.permission_level, PermissionLevel::Forbidden) {
            return CerseiDecision::Deny("This operation is not permitted.".into());
        }

        // Prompt the UI and block this tool until the user responds.
        let request_id = Uuid::new_v4();
        let (tx, rx) = oneshot::channel();
        self.pending.pending.insert(request_id, tx);
        self.sink.emit(
            self.agent_id,
            AcpEvent::PermissionRequest {
                request_id,
                session_id: self.session_id.clone(),
                tool_call: permission_tool_call(request),
                options: permission_options(),
            },
        );
        match rx.await {
            Ok(decision) => decision,
            Err(_) => CerseiDecision::Deny("cancelled".into()),
        }
    }
}

fn permission_options() -> Vec<acp_schema::PermissionOption> {
    use acp_schema::{PermissionOption, PermissionOptionKind};
    vec![
        PermissionOption::new("allow_once", "Allow once", PermissionOptionKind::AllowOnce),
        PermissionOption::new(
            "allow_always",
            "Allow for this session",
            PermissionOptionKind::AllowAlways,
        ),
        PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
    ]
}

fn permission_tool_call(req: &PermissionRequest) -> acp_schema::ToolCallUpdate {
    let kind = tool_kind(&req.tool_name);
    let v = serde_json::json!({
        "toolCallId": req.id,
        "title": req.tool_name,
        "kind": kind,
        "status": "pending",
        "rawInput": req.tool_input,
    });
    serde_json::from_value(v).unwrap_or_else(|_| {
        acp_schema::ToolCallUpdate::new(req.id.clone(), acp_schema::ToolCallUpdateFields::default())
    })
}

fn map_decision(d: atlas_acp::PermissionDecision) -> CerseiDecision {
    match d {
        atlas_acp::PermissionDecision::Selected { option_id } => match option_id.as_str() {
            "allow_once" => CerseiDecision::AllowOnce,
            "allow_always" => CerseiDecision::AllowForSession,
            _ => CerseiDecision::Deny("Rejected by user".into()),
        },
        atlas_acp::PermissionDecision::Cancelled => CerseiDecision::Deny("cancelled".into()),
    }
}

// ─── AgentEvent → AcpEvent adapters ─────────────────────────────────────────

fn emit_chunk(sink: &Arc<dyn EventSink>, agent_id: AgentId, session_id: &SessionId, kind: &str, text: &str) {
    let v = serde_json::json!({
        "sessionUpdate": kind,
        "content": { "type": "text", "text": text },
    });
    emit_session_update(sink, agent_id, session_id, v);
}

fn emit_tool_call(
    sink: &Arc<dyn EventSink>,
    agent_id: AgentId,
    session_id: &SessionId,
    id: &str,
    name: &str,
    input: serde_json::Value,
) {
    let v = serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": id,
        "title": name,
        "kind": tool_kind(name),
        "status": "in_progress",
        "rawInput": input,
    });
    emit_session_update(sink, agent_id, session_id, v);
}

fn emit_tool_update(
    sink: &Arc<dyn EventSink>,
    agent_id: AgentId,
    session_id: &SessionId,
    id: &str,
    result: &str,
    is_error: bool,
) {
    let v = serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": id,
        "status": if is_error { "failed" } else { "completed" },
        "content": [ { "type": "content", "content": { "type": "text", "text": result } } ],
    });
    emit_session_update(sink, agent_id, session_id, v);
}

fn emit_session_update(
    sink: &Arc<dyn EventSink>,
    agent_id: AgentId,
    session_id: &SessionId,
    v: serde_json::Value,
) {
    match serde_json::from_value::<acp_schema::SessionUpdate>(v) {
        Ok(update) => sink.emit(
            agent_id,
            AcpEvent::SessionUpdate {
                session_id: session_id.clone(),
                update,
            },
        ),
        Err(e) => tracing::warn!(target: "atlas_cersei::adapter", "session update decode failed: {e}"),
    }
}

/// Map a Cersei tool name to an ACP `ToolKind` token (drives the UI icon).
fn tool_kind(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if n.contains("read") || n.contains("glob") || n.contains("grep") || n.contains("search") {
        "read"
    } else if n.contains("edit") || n.contains("write") || n.contains("patch") || n.contains("notebook") {
        "edit"
    } else if n.contains("bash") || n.contains("shell") || n.contains("exec") || n.contains("powershell") {
        "execute"
    } else if n.contains("fetch") || n.contains("web") {
        "fetch"
    } else {
        "other"
    }
}

fn map_stop(s: cersei::types::StopReason) -> &'static str {
    use cersei::types::StopReason as S;
    match s {
        S::EndTurn => "endturn",
        S::MaxTokens => "maxtokens",
        S::ToolUse => "endturn",
        S::StopSequence => "endturn",
        S::ContentFilter => "refusal",
    }
}

fn modes_blob(current: &str) -> serde_json::Value {
    serde_json::json!({
        "currentModeId": current,
        "availableModes": [
            { "id": "default", "name": "Ask", "description": "Prompt before edits and commands" },
            { "id": "acceptEdits", "name": "Accept edits", "description": "Auto-approve file edits; prompt for shell" },
            { "id": "plan", "name": "Plan", "description": "Read-only — no edits or commands" },
            { "id": "bypass", "name": "Bypass", "description": "Run everything without prompting" },
        ],
    })
}

fn session_id_str(id: &SessionId) -> String {
    serde_json::to_value(id)
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

// ─── Transcript → replay items ──────────────────────────────────────────────

fn messages_to_replay(messages: &[Message]) -> Vec<ReplayItem> {
    use cersei::types::{ContentBlock, MessageContent, Role};
    let mut items: Vec<ReplayItem> = Vec::new();
    for m in messages {
        let is_user = m.role == Role::User;
        match &m.content {
            MessageContent::Text(t) => {
                if t.trim().is_empty() {
                    continue;
                }
                items.push(if is_user {
                    ReplayItem::User { text: t.clone() }
                } else {
                    ReplayItem::Assistant { text: t.clone() }
                });
            }
            MessageContent::Blocks(blocks) => {
                for b in blocks {
                    match b {
                        ContentBlock::Text { text } => {
                            if text.trim().is_empty() {
                                continue;
                            }
                            items.push(if is_user {
                                ReplayItem::User { text: text.clone() }
                            } else {
                                ReplayItem::Assistant { text: text.clone() }
                            });
                        }
                        ContentBlock::Thinking { thinking, .. } => {
                            items.push(ReplayItem::Thinking {
                                text: thinking.clone(),
                            });
                        }
                        ContentBlock::ToolUse { id, name, input } => {
                            items.push(ReplayItem::Tool {
                                id: id.clone(),
                                name: name.clone(),
                                input: input.clone(),
                                result: None,
                                is_error: false,
                            });
                        }
                        ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            is_error,
                        } => {
                            let text = tool_result_text(content);
                            if let Some(ReplayItem::Tool {
                                result, is_error: ie, ..
                            }) = items.iter_mut().rev().find(|it| {
                                matches!(it, ReplayItem::Tool { id, .. } if id == tool_use_id)
                            }) {
                                *result = Some(text);
                                *ie = is_error.unwrap_or(false);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    items
}

fn tool_result_text(content: &cersei::types::ToolResultContent) -> String {
    use cersei::types::{ContentBlock, ToolResultContent};
    match content {
        ToolResultContent::Text(t) => t.clone(),
        ToolResultContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}
