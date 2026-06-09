//! AI code-review commands — the Tauri bridge over the `atlas-review` engine.
//!
//! Mirrors the Model-Chat streaming pattern: the frontend calls `review_start`
//! with a diff `source`, Rust resolves the BYOK key + git diff and drives the
//! Cersei-backed reviewer, streaming `atlas:review` events (`delta`, `thinking`,
//! `complete`, `error`) tagged by review id. Completed verdicts are persisted to
//! `<project>/.atlas/reviews.json` so they survive reload.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use atlas_review::{
    run_review, CancellationToken, ReviewEvent, ReviewOptions, ReviewVerdict,
    DEFAULT_MAX_INPUT_TOKENS,
};

use super::byok;

// ── State ───────────────────────────────────────────────────────────────────

/// Cancellation tokens for in-flight reviews, keyed by review id.
#[derive(Default)]
pub struct ReviewState {
    inflight: Mutex<HashMap<String, CancellationToken>>,
}

impl ReviewState {
    pub fn new() -> Self {
        Self::default()
    }
}

// ── Streaming events ─────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ReviewEvt {
    Delta {
        delta: String,
    },
    Thinking {
        delta: String,
    },
    Complete {
        record: ReviewRecord,
    },
    Error {
        message: String,
    },
}

#[derive(Serialize, Clone)]
struct Envelope {
    id: String,
    #[serde(flatten)]
    event: ReviewEvt,
}

fn emit(app: &AppHandle, id: &str, event: ReviewEvt) {
    let _ = app.emit("atlas:review", Envelope { id: id.to_string(), event });
}

// ── Persisted record ─────────────────────────────────────────────────────────

/// A completed review, persisted under `.atlas/reviews.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub created_at: String,
    pub verdict: Option<ReviewVerdict>,
    pub raw_text: String,
    pub omitted_files: Vec<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: Option<f64>,
}

// ── Diff source ──────────────────────────────────────────────────────────────

/// Which diff to review, chosen in the UI.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReviewSource {
    /// Uncommitted changes vs HEAD (working tree).
    Working,
    /// Staged changes only.
    Staged,
    /// A single commit.
    Commit { sha: String },
    /// A commit range `from..to`.
    Range { from: String, to: String },
}

fn git(path: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Resolve `(raw_diff, human_title)` for a source. Blocking; call off-thread.
fn resolve_diff(path: &str, source: &ReviewSource) -> Result<(String, String), String> {
    match source {
        ReviewSource::Working => {
            let diff = git(path, &["diff", "--no-color", "HEAD"])?;
            Ok((diff, "Working tree changes".to_string()))
        }
        ReviewSource::Staged => {
            let diff = git(path, &["diff", "--no-color", "--cached"])?;
            Ok((diff, "Staged changes".to_string()))
        }
        ReviewSource::Commit { sha } => {
            // `--format=` suppresses the commit header so we get just the patch.
            let diff = git(path, &["show", "--no-color", "--format=", sha])?;
            let subject = git(path, &["show", "-s", "--format=%s", sha])
                .unwrap_or_default()
                .trim()
                .to_string();
            let short = sha.chars().take(7).collect::<String>();
            let title = if subject.is_empty() {
                format!("Commit {short}")
            } else {
                format!("{short} — {subject}")
            };
            Ok((diff, title))
        }
        ReviewSource::Range { from, to } => {
            let diff = git(path, &["diff", "--no-color", &format!("{from}..{to}")])?;
            Ok((diff, format!("{from}..{to}")))
        }
    }
}

// ── Persistence ──────────────────────────────────────────────────────────────

const MAX_PERSISTED: usize = 50;

fn store_path(project: &str) -> PathBuf {
    PathBuf::from(project).join(".atlas").join("reviews.json")
}

fn load_records(project: &str) -> Vec<ReviewRecord> {
    std::fs::read_to_string(store_path(project))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_record(project: &str, record: &ReviewRecord) {
    let mut records = load_records(project);
    records.retain(|r| r.id != record.id);
    records.insert(0, record.clone());
    records.truncate(MAX_PERSISTED);
    let path = store_path(project);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(&records) {
        let _ = std::fs::write(path, json);
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// BYOK providers that both have a key configured AND the reviewer can drive.
#[tauri::command]
pub fn review_providers(app: AppHandle) -> Vec<String> {
    byok::byok_list(app)
        .into_iter()
        .map(|m| m.provider)
        .filter(|p| atlas_review::is_supported(p))
        .collect()
}

/// List persisted reviews for a project, newest first.
#[tauri::command]
pub fn review_list(project: String) -> Vec<ReviewRecord> {
    load_records(&project)
}

/// Fetch one persisted review by id.
#[tauri::command]
pub fn review_get(project: String, id: String) -> Option<ReviewRecord> {
    load_records(&project).into_iter().find(|r| r.id == id)
}

/// Cancel an in-flight review.
#[tauri::command]
pub fn review_cancel(state: State<'_, ReviewState>, id: String) {
    if let Some(tok) = state.inflight.lock().get(&id) {
        tok.cancel();
    }
}

/// Start a review. Resolves the diff + key, streams `atlas:review` events, and
/// on success persists the verdict. Resolves when the review finishes.
#[tauri::command]
pub async fn review_start(
    app: AppHandle,
    state: State<'_, ReviewState>,
    id: String,
    project: String,
    provider: String,
    model: String,
    source: ReviewSource,
) -> Result<(), String> {
    let key = byok::byok_get(app.clone(), provider.clone())?
        .ok_or_else(|| format!("No API key configured for {provider}"))?;

    let (raw_diff, title) = {
        let project = project.clone();
        tokio::task::spawn_blocking(move || resolve_diff(&project, &source))
            .await
            .map_err(|e| e.to_string())??
    };
    if raw_diff.trim().is_empty() {
        return Err("Nothing to review for the selected source.".to_string());
    }

    let cancel = CancellationToken::new();
    state.inflight.lock().insert(id.clone(), cancel.clone());

    let on_event = {
        let app = app.clone();
        let id = id.clone();
        move |ev: ReviewEvent| match ev {
            ReviewEvent::Delta(d) => emit(&app, &id, ReviewEvt::Delta { delta: d }),
            ReviewEvent::Thinking(d) => emit(&app, &id, ReviewEvt::Thinking { delta: d }),
            ReviewEvent::Error(e) => emit(&app, &id, ReviewEvt::Error { message: e }),
        }
    };

    let opts = ReviewOptions {
        provider: provider.clone(),
        model: model.clone(),
        api_key: key,
        raw_diff,
        title: Some(title.clone()),
        language: None,
        max_input_tokens: DEFAULT_MAX_INPUT_TOKENS,
    };

    let result = run_review(opts, cancel.clone(), on_event).await;
    state.inflight.lock().remove(&id);

    match result {
        Ok(r) => {
            let record = ReviewRecord {
                id: id.clone(),
                title,
                provider,
                model,
                created_at: chrono::Utc::now().to_rfc3339(),
                verdict: r.verdict,
                raw_text: r.raw_text,
                omitted_files: r.omitted_files,
                input_tokens: r.input_tokens,
                output_tokens: r.output_tokens,
                cost_usd: r.cost_usd,
            };
            let project_for_save = project.clone();
            let record_for_save = record.clone();
            let _ = tokio::task::spawn_blocking(move || {
                save_record(&project_for_save, &record_for_save)
            })
            .await;
            emit(&app, &id, ReviewEvt::Complete { record });
            Ok(())
        }
        Err(e) => {
            if cancel.is_cancelled() {
                Ok(())
            } else {
                emit(&app, &id, ReviewEvt::Error { message: e.clone() });
                Err(e)
            }
        }
    }
}
