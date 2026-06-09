//! Persistent history for the BYOK Model-Chat (ChatGPT-style).
//!
//! Conversations are stored GLOBALLY (not per-project) as one JSON file per
//! session under `app_config_dir/model-chat/<id>.json` — model chat is general
//! AI chat, independent of which folder is open. Mirrors the simple atomic-write
//! pattern of `plans.rs`.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// One stored message (the minimal subset the UI needs to rehydrate a turn).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChatSession {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub messages: Vec<StoredMessage>,
    pub created_at: String,
    pub updated_at: String,
}

/// Lightweight row for the sidebar list (no messages).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub updated_at: String,
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?
        .join("model-chat");
    fs::create_dir_all(&d).map_err(|e| format!("create model-chat dir: {e}"))?;
    Ok(d)
}

fn session_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    // Guard against path traversal — ids are frontend-generated slugs.
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("invalid session id".into());
    }
    Ok(dir(app)?.join(format!("{id}.json")))
}

/// List sessions for the sidebar, newest-updated first.
#[tauri::command]
pub fn modelchat_sessions_list(app: AppHandle) -> Result<Vec<SessionMeta>, String> {
    let d = dir(&app)?;
    let mut metas: Vec<SessionMeta> = Vec::new();
    if let Ok(entries) = fs::read_dir(&d) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(&path) {
                if let Ok(s) = serde_json::from_str::<ModelChatSession>(&raw) {
                    metas.push(SessionMeta {
                        id: s.id,
                        title: s.title,
                        provider: s.provider,
                        model: s.model,
                        updated_at: s.updated_at,
                    });
                }
            }
        }
    }
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(metas)
}

/// Load a full session (with messages).
#[tauri::command]
pub fn modelchat_session_get(app: AppHandle, id: String) -> Result<ModelChatSession, String> {
    let path = session_path(&app, &id)?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Create/replace a session (atomic write).
#[tauri::command]
pub fn modelchat_session_save(app: AppHandle, session: ModelChatSession) -> Result<(), String> {
    let path = session_path(&app, &session.id)?;
    let tmp = path.with_extension("json.tmp");
    let payload = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    fs::write(&tmp, &payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Delete a session.
#[tauri::command]
pub fn modelchat_session_delete(app: AppHandle, id: String) -> Result<(), String> {
    let path = session_path(&app, &id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
