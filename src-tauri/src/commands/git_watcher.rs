//! Filesystem watcher for the project's `.git/` metadata. Emits
//! `atlas:git-changed` whenever a commit, checkout, branch
//! create/delete, fetch, or HEAD move happens. The frontend git-store
//! and git-graph-panel listen for it and refresh — no more 3-second
//! polling.
//!
//! We watch four things specifically (NOT all of `.git/`):
//!   - `.git/HEAD`          — checkout / commit moves the symbolic ref
//!   - `.git/packed-refs`   — `git pack-refs` rewrites; rare but
//!                            necessary
//!   - `.git/refs/`         — every branch / tag / remote update lives
//!                            here as a loose ref file
//!   - `.git/index`         — `git add` / `git reset` (stage / unstage)
//!                            — changes the working-tree status the
//!                            Changes panel renders
//!
//! Watching all of `.git/` would surface every blob write inside
//! `.git/objects/…` during `git add` / `git commit` — huge noise for
//! zero signal. The above cover every state change the UI cares about.

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::new_debouncer;
use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

struct ActiveWatcher {
    root: PathBuf,
    /// Keeping the debouncer alive keeps the OS-level watches active.
    /// We never read from it.
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::RecommendedCache,
    >,
}

#[derive(Default)]
pub struct GitWatcherState {
    current: RwLock<Option<ActiveWatcher>>,
}

impl GitWatcherState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone, Serialize)]
struct GitChangedPayload {
    project: String,
}

/// Start (or replace) the watcher for `project_path`. Idempotent: if
/// the same project is already being watched, this is effectively a
/// re-arm (drops the old watcher and starts a fresh one). Returns
/// silently if the project isn't a git repo.
#[tauri::command]
pub async fn git_watch_start(
    project_path: String,
    app: AppHandle,
    state: State<'_, GitWatcherState>,
) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    let dot_git = root.join(".git");
    if !dot_git.is_dir() {
        // Not a git project — leave any existing watcher alone (caller
        // may switch projects in/out of a non-repo).
        return Ok(());
    }

    // Off the main thread: watcher creation does an initial FSEvents
    // scan on macOS.
    let root_for_task = root.clone();
    let app_for_task = app.clone();
    let debouncer = tokio::task::spawn_blocking(
        move || -> Result<
            notify_debouncer_full::Debouncer<
                notify::RecommendedWatcher,
                notify_debouncer_full::RecommendedCache,
            >,
            String,
        > {
            let project_str = root_for_task.to_string_lossy().into_owned();
            let app_for_cb = app_for_task.clone();
            let mut debouncer = new_debouncer(
                Duration::from_millis(200),
                None,
                move |result: notify_debouncer_full::DebounceEventResult| match result {
                    Ok(_events) => {
                        let _ = app_for_cb.emit(
                            "atlas:git-changed",
                            GitChangedPayload {
                                project: project_str.clone(),
                            },
                        );
                    }
                    Err(errors) => {
                        for e in errors {
                            tracing::warn!("git watch error: {e}");
                        }
                    }
                },
            )
            .map_err(|e| format!("failed to create git watcher: {e}"))?;

            // Targeted watches — see module doc for rationale.
            let dot_git = root_for_task.join(".git");
            let head = dot_git.join("HEAD");
            let packed_refs = dot_git.join("packed-refs");
            let refs_dir = dot_git.join("refs");
            let index = dot_git.join("index");

            for (label, path, recursive) in [
                ("HEAD", head, RecursiveMode::NonRecursive),
                ("packed-refs", packed_refs, RecursiveMode::NonRecursive),
                ("refs/", refs_dir, RecursiveMode::Recursive),
                ("index", index, RecursiveMode::NonRecursive),
            ] {
                if path.exists() {
                    if let Err(e) = debouncer.watch(&path, recursive) {
                        tracing::warn!(
                            "git_watch: failed to watch {label} at {}: {e}",
                            path.display()
                        );
                    }
                }
            }

            Ok(debouncer)
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    *state.current.write() = Some(ActiveWatcher {
        root,
        _debouncer: debouncer,
    });
    Ok(())
}

#[tauri::command]
pub fn git_watch_stop(state: State<'_, GitWatcherState>) {
    *state.current.write() = None;
}

#[derive(Debug, Clone, Serialize)]
pub struct GitWatcherStatus {
    pub watching: bool,
    pub root: Option<String>,
}

#[tauri::command]
pub fn git_watch_status(state: State<'_, GitWatcherState>) -> GitWatcherStatus {
    match state.current.read().as_ref() {
        Some(w) => GitWatcherStatus {
            watching: true,
            root: Some(w.root.to_string_lossy().into_owned()),
        },
        None => GitWatcherStatus {
            watching: false,
            root: None,
        },
    }
}

/// Allow other modules (e.g. `git_status` post-write or future
/// commands that mutate the repo directly) to ping the watcher
/// channel synthetically.
#[allow(dead_code)]
pub fn emit_synthetic_change(app: &AppHandle, project_path: &Path) {
    let _ = app.emit(
        "atlas:git-changed",
        GitChangedPayload {
            project: project_path.to_string_lossy().into_owned(),
        },
    );
}
