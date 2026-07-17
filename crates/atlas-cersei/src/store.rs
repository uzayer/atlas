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

/// Cumulative token/cost usage for a session, accumulated across turns. Serde
/// `default` so older session files (written before usage was tracked) load.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost: f64,
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
    #[serde(default)]
    pub usage: StoredUsage,
    /// Set when the session's most recent turn FAILED (provider error after
    /// retries, tool crash). The failed turn's history is persisted anyway —
    /// user message + partial assistant + settled tool results (M1: it used
    /// to vanish from disk and context) — and resume surfaces this as an
    /// error marker at the end of the transcript. Cleared by the next
    /// successful save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_error: Option<String>,
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
    /// Cumulative tokens processed (input + output) across the session's turns.
    pub total_tokens: u64,
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

/// Write (or overwrite) a session's transcript. ATOMIC (M2): serialize to a
/// sibling temp file, fsync, then rename over the target — a crash mid-write
/// can no longer leave a half-written JSON that silently resumes as empty.
#[allow(clippy::too_many_arguments)]
pub fn save(
    config_dir: &Path,
    cwd: &str,
    session_id: &str,
    provider: &str,
    model: &str,
    messages: &[Message],
    updated_at: &str,
    usage: &StoredUsage,
    turn_error: Option<&str>,
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
        usage: usage.clone(),
        turn_error: turn_error.map(str::to_string),
    };
    let json = match serde_json::to_string(&doc) {
        Ok(j) => j,
        Err(e) => {
            tracing::warn!(target: "atlas_cersei::store", "serialize session failed: {e}");
            return;
        }
    };
    let final_path = session_path(config_dir, cwd, session_id);
    // Temp file in the SAME directory so the rename is same-filesystem atomic.
    let tmp_path = dir.join(format!(".{session_id}.tmp-{}", std::process::id()));
    let write_atomic = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(json.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp_path, &final_path)
    })();
    if let Err(e) = write_atomic {
        tracing::warn!(target: "atlas_cersei::store", "atomic write session failed: {e}");
        let _ = fs::remove_file(&tmp_path);
    }
}

/// Result of a checked session load — corruption is distinguished from
/// absence so callers can surface it (M2: a corrupt file used to silently
/// resume as an EMPTY session with no explanation).
pub enum LoadOutcome {
    Loaded(StoredSession),
    Missing,
    /// The file existed but did not parse. It has been moved aside to
    /// `backup_path` (`<id>.json.corrupt-<ts>`) so it is preserved for
    /// inspection and the session starts fresh — visibly, not silently.
    Corrupt { backup_path: String },
}

/// Load with corruption detection + backup. See [`LoadOutcome`].
pub fn load_checked(config_dir: &Path, cwd: &str, session_id: &str) -> LoadOutcome {
    let path = session_path(config_dir, cwd, session_id);
    let raw = match fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return LoadOutcome::Missing,
    };
    match serde_json::from_str(&raw) {
        Ok(doc) => LoadOutcome::Loaded(doc),
        Err(e) => {
            tracing::warn!(
                target: "atlas_cersei::store",
                "session {} is corrupt ({e}); backing it up",
                path.display()
            );
            let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S");
            let backup = path.with_extension(format!("json.corrupt-{ts}"));
            if let Err(re) = fs::rename(&path, &backup) {
                tracing::warn!(target: "atlas_cersei::store", "corrupt backup rename failed: {re}");
            }
            LoadOutcome::Corrupt {
                backup_path: backup.to_string_lossy().into_owned(),
            }
        }
    }
}

/// Load a session's stored document, if present. Corrupt files are backed up
/// and treated as absent — use [`load_checked`] when the caller needs to
/// surface the damage.
pub fn load(config_dir: &Path, cwd: &str, session_id: &str) -> Option<StoredSession> {
    match load_checked(config_dir, cwd, session_id) {
        LoadOutcome::Loaded(doc) => Some(doc),
        _ => None,
    }
}

/// Delete a stored session's JSON file. Guards that the resolved path stays
/// inside `<config_dir>/cersei-sessions` before removing (mirrors the
/// `delete_claude_session` path guard). A missing file is treated as success.
pub fn delete(config_dir: &Path, cwd: &str, session_id: &str) -> Result<(), String> {
    let path = session_path(config_dir, cwd, session_id);
    if !path.starts_with(sessions_root(config_dir)) {
        return Err("refusing to delete: path outside cersei-sessions".into());
    }
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// The on-disk directory holding a project's stored sessions. Public so the
/// session file-watcher can watch it for push-refresh.
pub fn project_sessions_dir(config_dir: &Path, cwd: &str) -> PathBuf {
    project_dir(config_dir, cwd)
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
            let raw = match fs::read_to_string(&path) {
                Ok(r) => r,
                Err(err) => {
                    tracing::warn!(target: "atlas_cersei::store", "skip session {}: read failed: {err}", path.display());
                    return None;
                }
            };
            let doc: StoredSession = match serde_json::from_str(&raw) {
                Ok(d) => d,
                Err(err) => {
                    tracing::warn!(target: "atlas_cersei::store", "skip session {}: parse failed: {err}", path.display());
                    return None;
                }
            };
            Some(SessionMeta {
                preview: first_user_text(&doc.messages).unwrap_or_else(|| "New session".into()),
                message_count: doc.messages.len(),
                total_tokens: doc.usage.input_tokens + doc.usage.output_tokens,
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

#[cfg(test)]
mod tests {
    use super::*;
    use cersei::types::Message;
    use std::sync::atomic::{AtomicU64, Ordering};

    // Unique temp config dir per test (no external tempfile dep).
    fn temp_dir() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let id = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("atlas-cersei-test-{}-{id}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = temp_dir();
        let cwd = "/proj/a";
        let msgs = vec![Message::user("hello"), Message::assistant("hi there")];
        save(&dir, cwd, "s1", "anthropic", "claude-opus-4-8", &msgs, "2026-06-23T00:00:00Z", &StoredUsage::default(), None);

        let loaded = load(&dir, cwd, "s1").expect("session should load");
        assert_eq!(loaded.session_id, "s1");
        assert_eq!(loaded.provider, "anthropic");
        assert_eq!(loaded.model, "claude-opus-4-8");
        assert_eq!(loaded.messages.len(), 2);
        // Different cwd → isolated namespace, nothing there.
        assert!(load(&dir, "/proj/b", "s1").is_none());
    }


    #[test]
    fn atomic_save_leaves_no_temp_files_and_overwrites() {
        let dir = temp_dir();
        let cwd = "/proj/atomic";
        // Mid-turn partial snapshot (the incremental-save path)…
        save(&dir, cwd, "s1", "anthropic", "m", &[Message::user("q")], "t1", &StoredUsage::default(), None);
        let partial = load(&dir, cwd, "s1").expect("partial snapshot loads");
        assert_eq!(partial.messages.len(), 1, "partial history present after 'crash'");
        // …then the final save overwrites it atomically.
        let msgs = vec![Message::user("q"), Message::assistant("a")];
        save(&dir, cwd, "s1", "anthropic", "m", &msgs, "t2", &StoredUsage::default(), None);
        let full = load(&dir, cwd, "s1").expect("final save loads");
        assert_eq!(full.messages.len(), 2);
        assert_eq!(full.updated_at, "t2");
        // No temp residue in the session dir.
        let residue: Vec<_> = fs::read_dir(project_sessions_dir(&dir, cwd))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(residue.is_empty(), "atomic write must not leave temp files");
    }

    #[test]
    fn failed_turn_marker_roundtrips() {
        let dir = temp_dir();
        let cwd = "/proj/fail";
        let msgs = vec![Message::user("do the thing"), Message::assistant("partial…")];
        save(&dir, cwd, "s1", "anthropic", "m", &msgs, "t1", &StoredUsage::default(),
             Some("HTTP 429: rate limited (gave up after 4 attempts)"));
        let doc = load(&dir, cwd, "s1").expect("failed turn must be persisted");
        assert_eq!(doc.messages.len(), 2, "user msg + partial assistant survive");
        assert!(doc.turn_error.as_deref().unwrap().contains("HTTP 429"));
        // The next successful save clears the marker.
        save(&dir, cwd, "s1", "anthropic", "m", &msgs, "t2", &StoredUsage::default(), None);
        assert!(load(&dir, cwd, "s1").unwrap().turn_error.is_none());
    }

    #[test]
    fn corrupt_file_is_backed_up_and_surfaced_not_silently_empty() {
        let dir = temp_dir();
        let cwd = "/proj/corrupt";
        // A valid session that then gets truncated (crash mid-write pre-M2,
        // disk error, editor accident…).
        save(&dir, cwd, "s1", "anthropic", "m", &[Message::user("q")], "t1", &StoredUsage::default(), None);
        let path = project_sessions_dir(&dir, cwd).join("s1.json");
        fs::write(&path, "{\"session_id\": \"s1\", \"trunca").unwrap();

        let outcome = load_checked(&dir, cwd, "s1");
        let LoadOutcome::Corrupt { backup_path } = outcome else {
            panic!("corrupt file must be reported, not silently empty");
        };
        assert!(std::path::Path::new(&backup_path).exists(), "backup written");
        assert!(backup_path.contains(".corrupt-"));
        assert!(!path.exists(), "damaged original moved aside");
        // Second load: the file is gone → Missing (fresh start), still not an error.
        assert!(matches!(load_checked(&dir, cwd, "s1"), LoadOutcome::Missing));
        // And the lossy `load` treats it as absent.
        assert!(load(&dir, cwd, "s1").is_none());
    }


    #[test]
    fn list_is_newest_first_with_preview() {
        let dir = temp_dir();
        let cwd = "/proj/list";
        save(&dir, cwd, "old", "openai", "gpt-5.1", &[Message::user("first task")], "2026-06-23T00:00:00Z", &StoredUsage { input_tokens: 100, output_tokens: 50, cost: 0.01 }, None);
        save(&dir, cwd, "new", "openai", "gpt-5.1", &[Message::user("second task")], "2026-06-23T12:00:00Z", &StoredUsage::default(), None);

        let metas = list(&dir, cwd);
        assert_eq!(metas.len(), 2);
        assert_eq!(metas[0].id, "new", "newest session must sort first");
        assert_eq!(metas[0].preview, "second task");
        assert_eq!(metas[0].message_count, 1);
        // Usage persists + surfaces as cumulative total_tokens (oldest session).
        assert_eq!(metas[1].total_tokens, 150);
    }

    #[test]
    fn corpus_sessions_flattens_transcript_and_usage() {
        let dir = temp_dir();
        let cwd = "/proj/corpus";
        let msgs = vec![
            Message::user("how does auth work"),
            Message::assistant("it uses JWT tokens"),
        ];
        save(
            &dir,
            cwd,
            "c1",
            "anthropic",
            "claude-opus-4-8",
            &msgs,
            "2026-06-24T00:00:00Z",
            &StoredUsage { input_tokens: 300, output_tokens: 120, cost: 0.02 },
            None,
        );

        let corpus = corpus_sessions(&dir, cwd);
        assert_eq!(corpus.len(), 1);
        let c = &corpus[0];
        assert_eq!(c.id, "c1");
        assert_eq!(c.first_user, "how does auth work");
        assert!(c.transcript.contains("how does auth work"));
        assert!(c.transcript.contains("it uses JWT tokens"), "assistant turn must be indexed");
        assert_eq!(c.total_tokens, 420);
        // Isolated per cwd.
        assert!(corpus_sessions(&dir, "/proj/other").is_empty());
    }

    #[test]
    fn byok_reads_shared_keys_file() {
        let dir = temp_dir();
        fs::write(
            dir.join("byok-keys.json"),
            r#"{ "anthropic": { "key": "sk-ant" }, "openai": { "key": "sk-oai" } }"#,
        )
        .unwrap();
        assert_eq!(byok_get(&dir, "anthropic").as_deref(), Some("sk-ant"));
        assert_eq!(byok_get(&dir, "missing"), None);
        let mut providers = byok_providers(&dir);
        providers.sort();
        assert_eq!(providers, vec!["anthropic".to_string(), "openai".to_string()]);
    }

    #[test]
    fn byok_missing_file_is_empty() {
        let dir = temp_dir();
        assert_eq!(byok_get(&dir, "anthropic"), None);
        assert!(byok_providers(&dir).is_empty());
    }
}

/// Plain text of a message (joins text blocks; ignores images/tool payloads).
fn message_text(m: &Message) -> String {
    use cersei::types::{ContentBlock, MessageContent};
    match &m.content {
        MessageContent::Text(t) => t.clone(),
        MessageContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

/// First user message's FULL text — used as the session title/preview. Returned
/// untruncated so the caller can strip Atlas-injected context (which may be
/// prepended) from the whole block before truncating; truncating here first
/// would chop an injected block mid-way and defeat the strip.
pub fn first_user_text(messages: &[Message]) -> Option<String> {
    use cersei::types::Role;
    for m in messages {
        if m.role != Role::User {
            continue;
        }
        let text = message_text(m);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        return Some(text.to_string());
    }
    None
}

/// One stored session flattened for the memory corpus (Chat / Graph indexing).
/// `first_user` + `transcript` are RAW (the caller strips Atlas-injected
/// context, which it can — `atlas-cersei` can't depend on the strip helper).
#[derive(Debug, Clone)]
pub struct CorpusSession {
    pub id: String,
    pub first_user: String,
    pub transcript: String,
    pub updated_at: String,
    pub total_tokens: u64,
}

/// Flatten every stored session for `cwd` into corpus-ready records so the
/// native agent's conversations are searchable in Memory ▸ Chat / Graph
/// (parity with Codex threads).
pub fn corpus_sessions(config_dir: &Path, cwd: &str) -> Vec<CorpusSession> {
    use cersei::types::Role;
    let dir = project_dir(config_dir, cwd);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let path = e.path();
            let raw = match fs::read_to_string(&path) {
                Ok(r) => r,
                Err(err) => {
                    tracing::warn!(target: "atlas_cersei::store", "skip corpus session {}: read failed: {err}", path.display());
                    return None;
                }
            };
            let doc: StoredSession = match serde_json::from_str(&raw) {
                Ok(d) => d,
                Err(err) => {
                    tracing::warn!(target: "atlas_cersei::store", "skip corpus session {}: parse failed: {err}", path.display());
                    return None;
                }
            };
            let first_user = first_user_text(&doc.messages).unwrap_or_default();
            // Only the conversational turns (user + assistant), newline-joined.
            let transcript = doc
                .messages
                .iter()
                .filter(|m| matches!(m.role, Role::User | Role::Assistant))
                .map(message_text)
                .filter(|t| !t.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            Some(CorpusSession {
                id: doc.session_id,
                first_user,
                transcript,
                updated_at: doc.updated_at,
                total_tokens: doc.usage.input_tokens + doc.usage.output_tokens,
            })
        })
        .collect()
}
