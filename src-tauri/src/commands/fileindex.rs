//! In-memory file index per project, with `.gitignore`-respecting initial
//! walk and a debounced filesystem watcher for incremental updates. The
//! frontend's Cmd+P palette queries this — search must feel instant on large
//! repos, so all matching happens in Rust via nucleo and only the top N
//! results cross the IPC boundary.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ignore::WalkBuilder;
use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebouncedEvent};
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::Matcher;
use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// One indexed file. `path` is absolute; `rel` is relative to the project
/// root so the UI can render `crates/foo/src/lib.rs` instead of the full
/// `/Users/.../atlas/crates/foo/src/lib.rs`. `rel` is also what we feed into
/// the fuzzy matcher (users search by relative path, not absolute).
#[derive(Debug, Clone)]
struct IndexedFile {
    path: PathBuf,
    rel: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileMatch {
    pub path: String,
    pub rel: String,
}

/// One project being indexed. The watcher thread is kept alive by the
/// `_debouncer` handle; dropping `ProjectIndex` stops the watcher.
struct ProjectIndex {
    root: PathBuf,
    files: Arc<RwLock<Vec<IndexedFile>>>,
    /// `notify_debouncer_full` returns the debouncer guard; keeping it alive
    /// keeps the OS-level watch active. We never read from it.
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::RecommendedCache,
    >,
}

#[derive(Default)]
pub struct FileIndexState {
    current: RwLock<Option<ProjectIndex>>,
}

impl FileIndexState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Open (or replace) the indexed project. Returns once the initial walk
/// completes — for very large repos this can take a moment, but everything
/// after is incremental.
#[tauri::command]
pub fn fileindex_open_project(
    path: String,
    app: AppHandle,
    state: State<'_, FileIndexState>,
) -> Result<usize, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    let files = Arc::new(RwLock::new(walk_project(&root)));
    let count = files.read().len();

    // Wire a debounced watcher. notify-debouncer-full batches rapid changes
    // (e.g. git checkout flipping 1000 files) into a single tick so we don't
    // thrash the index.
    let files_for_watch = files.clone();
    let root_for_watch = root.clone();
    let app_for_watch = app.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(150),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| match result {
            Ok(events) => {
                apply_events(&root_for_watch, &files_for_watch, events);
                let _ = app_for_watch.emit(
                    "atlas:fileindex:updated",
                    serde_json::json!({ "count": files_for_watch.read().len() }),
                );
            }
            Err(errors) => {
                for e in errors {
                    tracing::warn!("file watch error: {e}");
                }
            }
        },
    )
    .map_err(|e| format!("failed to create watcher: {e}"))?;

    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch {}: {e}", root.display()))?;

    *state.current.write() = Some(ProjectIndex {
        root,
        files,
        _debouncer: debouncer,
    });

    Ok(count)
}

#[tauri::command]
pub fn fileindex_close_project(state: State<'_, FileIndexState>) {
    *state.current.write() = None;
}

#[derive(Debug, Clone, Serialize)]
pub struct FileIndexStatus {
    pub indexed: bool,
    pub count: usize,
    pub root: Option<String>,
}

#[tauri::command]
pub fn fileindex_status(state: State<'_, FileIndexState>) -> FileIndexStatus {
    match state.current.read().as_ref() {
        Some(idx) => FileIndexStatus {
            indexed: true,
            count: idx.files.read().len(),
            root: Some(idx.root.to_string_lossy().into_owned()),
        },
        None => FileIndexStatus {
            indexed: false,
            count: 0,
            root: None,
        },
    }
}

/// Fuzzy-search the index. Empty query returns the first `limit` entries —
/// useful for the palette's empty state ("recent files" effect).
#[tauri::command]
pub fn fileindex_search(
    query: String,
    limit: usize,
    state: State<'_, FileIndexState>,
) -> Vec<FileMatch> {
    let Some(idx) = state.current.read().as_ref().cloned_files() else {
        return Vec::new();
    };

    let trimmed = query.trim();
    if trimmed.is_empty() {
        return idx
            .iter()
            .take(limit.max(1))
            .map(|f| FileMatch {
                path: f.path.to_string_lossy().into_owned(),
                rel: f.rel.clone(),
            })
            .collect();
    }

    let mut matcher = Matcher::default();
    let pattern = Pattern::parse(trimmed, CaseMatching::Smart, Normalization::Smart);

    let mut scored: Vec<(u32, &IndexedFile)> = idx
        .iter()
        .filter_map(|f| {
            pattern
                .score(nucleo_matcher::Utf32Str::Ascii(f.rel.as_bytes()), &mut matcher)
                .map(|score| (score, f))
        })
        .collect();
    // Highest score first; stable order on ties (insertion = file walk order).
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(limit.max(1))
        .map(|(_, f)| FileMatch {
            path: f.path.to_string_lossy().into_owned(),
            rel: f.rel.clone(),
        })
        .collect()
}

// ── internals ────────────────────────────────────────────────────────────

trait IndexClone {
    fn cloned_files(&self) -> Option<Vec<IndexedFile>>;
}

impl IndexClone for Option<&ProjectIndex> {
    fn cloned_files(&self) -> Option<Vec<IndexedFile>> {
        self.map(|p| p.files.read().clone())
    }
}

fn walk_project(root: &Path) -> Vec<IndexedFile> {
    let walker = WalkBuilder::new(root)
        .hidden(false) // dotfiles like .env / .gitignore are valid hits
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build();

    let mut out = Vec::new();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.into_path();
        if let Some(rel) = relative(&path, root) {
            out.push(IndexedFile { path, rel });
        }
    }
    out
}

fn relative(path: &Path, root: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

fn apply_events(
    root: &Path,
    files: &Arc<RwLock<Vec<IndexedFile>>>,
    events: Vec<DebouncedEvent>,
) {
    // Strategy: collect adds/removes/renames separately, then mutate the
    // vec once under a single write lock. For complex events (e.g. branch
    // switch), `notify` may not surface kind-level info, in which case we
    // re-walk the affected subtree.
    let mut to_remove: Vec<PathBuf> = Vec::new();
    let mut to_add: Vec<PathBuf> = Vec::new();
    let mut needs_rewalk = false;

    for ev in events {
        match ev.event.kind {
            EventKind::Create(_) => {
                for p in &ev.event.paths {
                    if p.is_file() {
                        to_add.push(p.clone());
                    } else if p.is_dir() {
                        needs_rewalk = true;
                    }
                }
            }
            EventKind::Remove(_) => {
                for p in &ev.event.paths {
                    to_remove.push(p.clone());
                }
            }
            EventKind::Modify(_) => {
                // Rename or move shows up here; the cheapest correct fix is
                // a full re-walk of the project. notify-full's rename events
                // are fiddly across platforms.
                needs_rewalk = true;
            }
            _ => {}
        }
    }

    if needs_rewalk {
        let fresh = walk_project(root);
        *files.write() = fresh;
        return;
    }

    if to_add.is_empty() && to_remove.is_empty() {
        return;
    }

    let mut w = files.write();
    if !to_remove.is_empty() {
        let remove_set: std::collections::HashSet<_> = to_remove.into_iter().collect();
        w.retain(|f| !remove_set.contains(&f.path));
    }
    for p in to_add {
        // Skip if already present (notify can fire Create twice on macOS).
        if w.iter().any(|f| f.path == p) {
            continue;
        }
        if let Some(rel) = relative(&p, root) {
            w.push(IndexedFile { path: p, rel });
        }
    }
}
