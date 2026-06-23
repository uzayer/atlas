//! On-disk persistence for native-agent sessions + BYOK key lookup.
//!
//! Sessions are stored as JSON (the raw Cersei conversation) under
//! `<config_dir>/cersei-sessions/<cwd-hash>/<session_id>.json` so a session can
//! be resumed (its history fed back via `Agent::with_messages`) and listed in
//! the chat session sidebar. BYOK keys are read from the same `byok-keys.json`
//! the Tauri `byok_*` commands write (see `src-tauri/src/commands/byok.rs`).

use std::collections::BTreeMap;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use cersei::types::Message;
use serde::{Deserialize, Serialize};

/// One configured BYOK record. Mirrors `byok.rs`'s `StoredKey` (we only read
/// `key`; the rest is metadata the UI owns).
#[derive(Debug, Clone, Deserialize)]
struct StoredKey {
    key: String,
}

/// Read a provider's API key from the shared `byok-keys.json`. `None` if unset.
pub fn byok_get(config_dir: &Path, provider: &str) -> Option<String> {
    let path = config_dir.join("byok-keys.json");
    let raw = fs::read_to_string(path).ok()?;
    let store: BTreeMap<String, StoredKey> = serde_json::from_str(&raw).ok()?;
    store.get(provider).map(|v| v.key.clone())
}

/// Every provider that currently has a configured BYOK key.
pub fn byok_providers(config_dir: &Path) -> Vec<String> {
    let path = config_dir.join("byok-keys.json");
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let store: BTreeMap<String, StoredKey> = serde_json::from_str(&raw).unwrap_or_default();
    store.into_keys().collect()
}

/// Persisted session document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    pub session_id: String,
    pub cwd: String,
    pub updated_at: String,
    pub provider: String,
    pub model: String,
    pub messages: Vec<Message>,
}

/// Sidebar-facing session metadata. Deliberately shaped like the frontend's
/// `ClaudeSessionMeta` (same as Codex's `list_codex_sessions`) so the chat
/// session sidebar can merge all three agents without a special case.
#[derive(Debug, Clone, Serialize)]
pub struct SessionMeta {
    pub id: String,
    pub file_path: String,
    pub started_at: Option<String>,
    pub last_modified: Option<String>,
    pub message_count: usize,
    pub preview: String,
}

fn cwd_hash(cwd: &str) -> String {
    let mut h = DefaultHasher::new();
    cwd.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn sessions_root(config_dir: &Path) -> PathBuf {
    config_dir.join("cersei-sessions")
}

fn project_dir(config_dir: &Path, cwd: &str) -> PathBuf {
    sessions_root(config_dir).join(cwd_hash(cwd))
}

fn session_path(config_dir: &Path, cwd: &str, session_id: &str) -> PathBuf {
    project_dir(config_dir, cwd).join(format!("{session_id}.json"))
}

/// Write (or overwrite) a session's transcript.
pub fn save(
    config_dir: &Path,
    cwd: &str,
    session_id: &str,
    provider: &str,
    model: &str,
    messages: &[Message],
    updated_at: &str,
) {
    let dir = project_dir(config_dir, cwd);
    if let Err(e) = fs::create_dir_all(&dir) {
        tracing::warn!(target: "atlas_cersei::store", "create session dir failed: {e}");
        return;
    }
    let doc = StoredSession {
        session_id: session_id.to_string(),
        cwd: cwd.to_string(),
        updated_at: updated_at.to_string(),
        provider: provider.to_string(),
        model: model.to_string(),
        messages: messages.to_vec(),
    };
    match serde_json::to_string(&doc) {
        Ok(json) => {
            if let Err(e) = fs::write(session_path(config_dir, cwd, session_id), json) {
                tracing::warn!(target: "atlas_cersei::store", "write session failed: {e}");
            }
        }
        Err(e) => tracing::warn!(target: "atlas_cersei::store", "serialize session failed: {e}"),
    }
}

/// Load a session's stored document, if present.
pub fn load(config_dir: &Path, cwd: &str, session_id: &str) -> Option<StoredSession> {
    let raw = fs::read_to_string(session_path(config_dir, cwd, session_id)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// List sessions stored for `cwd`, newest first.
pub fn list(config_dir: &Path, cwd: &str) -> Vec<SessionMeta> {
    let dir = project_dir(config_dir, cwd);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut metas: Vec<SessionMeta> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let path = e.path();
            let raw = fs::read_to_string(&path).ok()?;
            let doc: StoredSession = serde_json::from_str(&raw).ok()?;
            Some(SessionMeta {
                preview: first_user_text(&doc.messages).unwrap_or_else(|| "New session".into()),
                message_count: doc.messages.len(),
                id: doc.session_id,
                file_path: path.to_string_lossy().into_owned(),
                started_at: Some(doc.updated_at.clone()),
                last_modified: Some(doc.updated_at),
            })
        })
        .collect();
    metas.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    metas
}

/// First user message's text, truncated — used as the session title.
fn first_user_text(messages: &[Message]) -> Option<String> {
    use cersei::types::{ContentBlock, MessageContent, Role};
    for m in messages {
        if m.role != Role::User {
            continue;
        }
        let text = match &m.content {
            MessageContent::Text(t) => t.clone(),
            MessageContent::Blocks(blocks) => blocks
                .iter()
                .find_map(|b| match b {
                    ContentBlock::Text { text } => Some(text.clone()),
                    _ => None,
                })
                .unwrap_or_default(),
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let title: String = text.chars().take(80).collect();
        return Some(title);
    }
    None
}
