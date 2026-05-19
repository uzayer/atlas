//! File-watcher for `~/.claude/projects/<encoded-cwd>/` so the sidebar gets
//! push notifications instead of polling.
//!
//! Pre-existing path: the sidebar's `useQuery` polled `list_claude_sessions`
//! every 1.5s while any chat was streaming and every 5s otherwise. Each call
//! re-walked the project's JSONL directory and reopened every file to
//! sidechain-check + count messages. For 50+ historical sessions that's a
//! lot of disk thrashing whose only purpose is "did anything change?" —
//! exactly what the OS already tells us via fs events.
//!
//! New path: one watcher per opened cwd, debounced at 250ms. Any create /
//! modify / remove inside that directory fires a single `atlas:sessions-changed`
//! window event. The sidebar drops the polling timer and refetches only on
//! the event.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, Debouncer, RecommendedCache};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Watch handle. Dropping it stops the OS-level watch — the debouncer is
/// held alive solely for that side effect.
struct WatchHandle {
    cwd: String,
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
}

#[derive(Default)]
pub struct SessionsWatchState {
    current: Mutex<Option<WatchHandle>>,
}

impl SessionsWatchState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WatchStatus {
    pub watching: bool,
    pub cwd: Option<String>,
    pub folder: Option<String>,
}

/// Open (or replace) the per-cwd watcher. Idempotent for the same cwd: if
/// we're already watching this directory we don't recreate the watcher,
/// which would otherwise drop and rebuild the OS handle for a no-op.
#[tauri::command]
pub fn sessions_watch_open(
    cwd: String,
    app: AppHandle,
    state: State<'_, SessionsWatchState>,
) -> Result<WatchStatus, String> {
    {
        let cur = state.current.lock();
        if let Some(handle) = cur.as_ref() {
            if handle.cwd == cwd {
                let folder = encoded_folder(&cwd);
                return Ok(WatchStatus {
                    watching: true,
                    cwd: Some(cwd),
                    folder: folder.map(|p| p.to_string_lossy().into_owned()),
                });
            }
        }
    }

    let Some(folder) = encoded_folder(&cwd) else {
        return Err("could not resolve ~/.claude/projects".into());
    };

    // Make sure the folder exists before trying to watch it — claude-code
    // doesn't create the cwd's project dir until the first session writes
    // a JSONL, so a brand-new project will hit this path empty. Create it
    // upfront so the watcher has a target.
    if !folder.exists() {
        if let Err(e) = std::fs::create_dir_all(&folder) {
            return Err(format!(
                "could not create {}: {e}",
                folder.display()
            ));
        }
    }

    let app_for_watch = app.clone();
    let cwd_for_watch = cwd.clone();
    let folder_for_log = folder.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(250),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| match result {
            Ok(_events) => {
                // Don't try to be precise about what changed — the sidebar
                // already does the full listing on demand. The event is
                // purely a "something moved, refetch now" notification.
                if let Err(e) = app_for_watch.emit(
                    "atlas:sessions-changed",
                    serde_json::json!({ "cwd": &cwd_for_watch }),
                ) {
                    tracing::warn!(target: "atlas::sessions_watch", "emit failed: {e}");
                }
            }
            Err(errors) => {
                for e in errors {
                    tracing::warn!(target: "atlas::sessions_watch", "watch error: {e}");
                }
            }
        },
    )
    .map_err(|e| format!("failed to create watcher: {e}"))?;

    debouncer
        .watch(&folder, RecursiveMode::NonRecursive)
        .map_err(|e| format!("failed to watch {}: {e}", folder_for_log.display()))?;

    let folder_str = folder.to_string_lossy().into_owned();
    *state.current.lock() = Some(WatchHandle {
        cwd: cwd.clone(),
        _debouncer: debouncer,
    });

    Ok(WatchStatus {
        watching: true,
        cwd: Some(cwd),
        folder: Some(folder_str),
    })
}

#[tauri::command]
pub fn sessions_watch_close(state: State<'_, SessionsWatchState>) {
    *state.current.lock() = None;
}

#[tauri::command]
pub fn sessions_watch_status(state: State<'_, SessionsWatchState>) -> WatchStatus {
    match state.current.lock().as_ref() {
        Some(handle) => WatchStatus {
            watching: true,
            cwd: Some(handle.cwd.clone()),
            folder: encoded_folder(&handle.cwd).map(|p| p.to_string_lossy().into_owned()),
        },
        None => WatchStatus {
            watching: false,
            cwd: None,
            folder: None,
        },
    }
}

fn encoded_folder(cwd: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let trimmed = cwd.trim_end_matches('/');
    let encoded = trimmed.replace('/', "-");
    Some(home.join(".claude").join("projects").join(encoded))
}

// Suppress dead-code warnings on the Arc import which is referenced via the
// state wrapper rather than directly.
#[allow(dead_code)]
type _ArcMarker = Arc<()>;
