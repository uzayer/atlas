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
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

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
    /// Derived unique-parent-directories list, cached. Lazily built
    /// on first folder query (or first `snapshot_folders` call) and
    /// invalidated in lockstep with `files` via `apply_events`. For
    /// a 5k-file project the derivation walks ~25k parent paths and
    /// does that many HashSet ops; doing it per @-mention keystroke
    /// was a meaningful chunk of the picker's perceived lag.
    folders: Arc<RwLock<Option<Vec<(String, PathBuf)>>>>,
    /// `notify_debouncer_full` returns the debouncer guard; keeping it alive
    /// keeps the OS-level watch active. We never read from it.
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::RecommendedCache,
    >,
}

/// Per-WINDOW index. Tauri `.manage()` state is one instance per process, so a
/// single `Option<ProjectIndex>` would be shared across every window — opening a
/// project in window B would clobber window A's Cmd+P / @-mention results. We
/// key by the calling webview's label (`main`, `atlas-<ts>`) so each window has
/// its own index. Entries are dropped on `WindowEvent::Destroyed` (see lib.rs).
#[derive(Default)]
pub struct FileIndexState {
    per_window: RwLock<HashMap<String, ProjectIndex>>,
}

impl FileIndexState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot a window's project file list + root for consumers outside this
    /// module (e.g. `mention_search`). Returns `None` when that window has no
    /// project indexed yet.
    pub fn snapshot_files(&self, label: &str) -> Option<(Vec<(String, PathBuf)>, PathBuf)> {
        let guard = self.per_window.read();
        guard.get(label).map(|p| {
            let files = p
                .files
                .read()
                .iter()
                .map(|f| (f.rel.clone(), f.path.clone()))
                .collect();
            (files, p.root.clone())
        })
    }

    /// Drop a window's index (called on window close). Dropping `ProjectIndex`
    /// also drops its `_debouncer`, stopping the fs watcher.
    pub fn drop_window(&self, label: &str) {
        self.per_window.write().remove(label);
    }

    /// Snapshot the derived unique-folder list. Lazily built on first
    /// access (cost: ~O(files × depth)), cached, invalidated by the
    /// fs watcher on the next file-set change. After warmup this is
    /// a constant-time clone of a small vec (~100s of entries for a
    /// typical project) — what makes the @-mention picker's folder
    /// kind sub-millisecond per keystroke.
    pub fn snapshot_folders(&self, label: &str) -> Option<Vec<(String, PathBuf)>> {
        let guard = self.per_window.read();
        let project = guard.get(label)?;
        if let Some(cached) = project.folders.read().as_ref() {
            return Some(cached.clone());
        }
        // Cache miss — derive once, store, return. Drop the read
        // lock around the (heavy) derivation so concurrent searches
        // don't pile up; worst case is two derivations land and the
        // second overwrites the first with the same data.
        let files = project.files.read().clone();
        let root = project.root.clone();
        let derived = derive_folders(&files, &root);
        *project.folders.write() = Some(derived.clone());
        Some(derived)
    }
}

/// Walk each file's parent chain, collect unique relative folders.
/// Pulled out as a free function so the lazy-cache path in
/// `snapshot_folders` can call it without holding the project lock.
fn derive_folders(files: &[IndexedFile], root: &Path) -> Vec<(String, PathBuf)> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for f in files {
        let mut cur = Path::new(&f.rel).parent();
        while let Some(p) = cur {
            let rel = p.to_string_lossy();
            if rel.is_empty() {
                break;
            }
            let rel = rel.into_owned();
            if seen.insert(rel.clone()) {
                out.push((rel, root.join(p)));
            }
            cur = p.parent();
        }
    }
    out
}

/// Open (or replace) the indexed project. Returns once the initial walk
/// completes — for very large repos this can take a moment (multi-second on
/// huge monorepos with deep .gitignore trees), but everything after is
/// incremental.
///
/// **Async + `spawn_blocking`**: the recursive walk and the macOS FSEvents
/// stream creation both block. A sync `#[tauri::command]` would run them on
/// the NSApp main thread and produce a 2–3 s beachball during project open.
/// We move the work onto tokio's blocking pool and only write back to the
/// shared `State` once the heavy lifting is done.
#[tauri::command]
pub async fn fileindex_open_project(
    path: String,
    app: AppHandle,
    webview: WebviewWindow,
    state: State<'_, FileIndexState>,
) -> Result<usize, String> {
    let label = webview.label().to_string();
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    // Off the main thread: walk the tree AND build the watcher. Watcher
    // creation isn't free on macOS — FSEvents does an initial scan of the
    // path tree before returning a stream handle.
    let root_for_task = root.clone();
    let app_for_task = app.clone();
    let label_for_task = label.clone();
    let (files, folders, debouncer): (
        Arc<RwLock<Vec<IndexedFile>>>,
        Arc<RwLock<Option<Vec<(String, PathBuf)>>>>,
        notify_debouncer_full::Debouncer<
            notify::RecommendedWatcher,
            notify_debouncer_full::RecommendedCache,
        >,
    ) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let walked = walk_project(&root_for_task);
        let files = Arc::new(RwLock::new(walked));
        // Folder cache starts empty — first folder query fills it.
        // The watcher callback flushes it on any file-set change so
        // the next derivation pass sees fresh data.
        let folders: Arc<RwLock<Option<Vec<(String, PathBuf)>>>> = Arc::new(RwLock::new(None));

        let files_for_watch = files.clone();
        let folders_for_watch = folders.clone();
        let root_for_watch = root_for_task.clone();
        let app_for_watch = app_for_task.clone();
        let label_for_watch = label_for_task.clone();

        let mut debouncer = new_debouncer(
            Duration::from_millis(150),
            None,
            move |result: notify_debouncer_full::DebounceEventResult| match result {
                Ok(events) => {
                    // Compute the set of parent dirs touched BEFORE
                    // we hand `events` to `apply_events` (which
                    // consumes them). The explorer uses this to
                    // refetch only the affected, currently-loaded
                    // directories instead of re-walking the whole
                    // project — agent file writes are tiny bursts,
                    // typically one parent dir per debounce.
                    let (dirs_touched, full_refresh) = summarise_events(&events);

                    apply_events(&root_for_watch, &files_for_watch, events);
                    // Files just changed — drop the derived folder
                    // cache so the next mention_search rebuilds it.
                    *folders_for_watch.write() = None;
                    let _ = app_for_watch.emit_to(
                        label_for_watch.as_str(),
                        "atlas:fileindex:updated",
                        serde_json::json!({ "count": files_for_watch.read().len() }),
                    );
                    let _ = app_for_watch.emit_to(
                        label_for_watch.as_str(),
                        "atlas:explorer:changed",
                        serde_json::json!({
                            "dirs": dirs_touched
                                .iter()
                                .map(|p| p.to_string_lossy().into_owned())
                                .collect::<Vec<_>>(),
                            // When `notify` gives us an opaque modify
                            // event (e.g. rename) we can't pinpoint
                            // dirs — the frontend should re-walk the
                            // whole loaded tree in that case.
                            "fullRefresh": full_refresh,
                        }),
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
            .watch(&root_for_task, RecursiveMode::Recursive)
            .map_err(|e| format!("failed to watch {}: {e}", root_for_task.display()))?;

        Ok((files, folders, debouncer))
    })
    .await
    .map_err(|e| e.to_string())??;

    let count = files.read().len();
    state.per_window.write().insert(
        label.clone(),
        ProjectIndex {
            root,
            files,
            folders,
            _debouncer: debouncer,
        },
    );

    // Tell THIS window the index is now searchable. Mirrors the event the
    // watcher fires on file-set changes — palette + mention picker both listen
    // for it, so a re-query lands the user's first results the instant the walk
    // finishes (no manual reopen needed).
    let _ = app.emit_to(
        label.as_str(),
        "atlas:fileindex:updated",
        serde_json::json!({ "count": count }),
    );

    Ok(count)
}

#[tauri::command]
pub fn fileindex_close_project(webview: WebviewWindow, state: State<'_, FileIndexState>) {
    state.per_window.write().remove(webview.label());
}

#[derive(Debug, Clone, Serialize)]
pub struct FileIndexStatus {
    pub indexed: bool,
    pub count: usize,
    pub root: Option<String>,
}

#[tauri::command]
pub fn fileindex_status(
    webview: WebviewWindow,
    state: State<'_, FileIndexState>,
) -> FileIndexStatus {
    match state.per_window.read().get(webview.label()) {
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

#[derive(Debug, Clone, Serialize)]
pub struct FolderMatch {
    pub path: String,
    pub rel: String,
}

/// Fuzzy-search the project for **directories**. Derived on-demand from the
/// file index's parent paths — no separate directory walk or watcher. The
/// derivation is O(files), which is fine for the few-thousand-file
/// projects Atlas targets; if it ever becomes a hot path, cache the
/// derived set inside `ProjectIndex`.
#[tauri::command]
pub fn fileindex_search_dirs(
    query: String,
    limit: usize,
    webview: WebviewWindow,
    state: State<'_, FileIndexState>,
) -> Vec<FolderMatch> {
    // Clone the Arc (pointer copy) + root, not the whole file Vec, then hold the
    // inner read lock across the folder derivation (avoids a multi-MB per-call
    // clone on large repos — same fix as fileindex_search).
    let (files_arc, root) = {
        let guard = state.per_window.read();
        match guard.get(webview.label()) {
            Some(p) => (p.files.clone(), p.root.clone()),
            None => return Vec::new(),
        }
    };
    let files = files_arc.read();

    // Collect unique parent directories, in first-seen order. We walk each
    // file's `rel` up to (but not including) the project root.
    let mut seen = std::collections::HashSet::<String>::new();
    let mut folders: Vec<(String, PathBuf)> = Vec::new();
    for f in files.iter() {
        let mut cur = Path::new(&f.rel).parent();
        while let Some(p) = cur {
            let rel = p.to_string_lossy();
            if rel.is_empty() {
                break;
            }
            let rel = rel.into_owned();
            if seen.insert(rel.clone()) {
                folders.push((rel, root.join(p)));
            }
            cur = p.parent();
        }
    }

    let trimmed = query.trim();
    if trimmed.is_empty() {
        return folders
            .into_iter()
            .take(limit.max(1))
            .map(|(rel, abs)| FolderMatch {
                path: abs.to_string_lossy().into_owned(),
                rel,
            })
            .collect();
    }

    let mut matcher = Matcher::default();
    let pattern = Pattern::parse(trimmed, CaseMatching::Smart, Normalization::Smart);
    let mut scored: Vec<(u32, (String, PathBuf))> = folders
        .into_iter()
        .filter_map(|(rel, abs)| {
            pattern
                .score(nucleo_matcher::Utf32Str::Ascii(rel.as_bytes()), &mut matcher)
                .map(|score| (score, (rel, abs)))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(limit.max(1))
        .map(|(_, (rel, abs))| FolderMatch {
            path: abs.to_string_lossy().into_owned(),
            rel,
        })
        .collect()
}

/// Fuzzy-search the index. Empty query returns the first `limit` entries —
/// useful for the palette's empty state ("recent files" effect).
#[tauri::command]
pub fn fileindex_search(
    query: String,
    limit: usize,
    webview: WebviewWindow,
    state: State<'_, FileIndexState>,
) -> Vec<FileMatch> {
    // Clone the Arc (a pointer copy), not the whole file Vec, then hold the
    // inner read lock across the match. The old code deep-cloned every
    // IndexedFile (path + rel String) on *each keystroke* just to read it —
    // multi-MB per search on a large repo. Matching is pure CPU (no .await),
    // so holding the read lock is fine; a concurrent re-index inserts a fresh
    // ProjectIndex, leaving this Arc as a safe snapshot.
    let files_arc = {
        let guard = state.per_window.read();
        match guard.get(webview.label()) {
            Some(p) => p.files.clone(),
            None => return Vec::new(),
        }
    };
    let files = files_arc.read();

    let trimmed = query.trim();
    if trimmed.is_empty() {
        return files
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

    let mut scored: Vec<(u32, &IndexedFile)> = files
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

/// Bucket a batch of debounced filesystem events into:
///   - the unique parent directories whose contents changed (so the
///     explorer can refetch JUST those), and
///   - a `full_refresh` flag for events `notify` reports as opaque
///     `Modify(_)` (typically renames) that we can't pin to a specific
///     parent. The explorer falls back to re-walking the loaded tree
///     in that case.
fn summarise_events(events: &[DebouncedEvent]) -> (std::collections::HashSet<PathBuf>, bool) {
    use std::collections::HashSet;
    let mut dirs: HashSet<PathBuf> = HashSet::new();
    let mut full_refresh = false;
    for ev in events {
        match ev.event.kind {
            EventKind::Create(_) | EventKind::Remove(_) => {
                for p in &ev.event.paths {
                    if let Some(parent) = p.parent() {
                        dirs.insert(parent.to_path_buf());
                    }
                }
            }
            EventKind::Modify(_) => {
                full_refresh = true;
            }
            _ => {}
        }
    }
    (dirs, full_refresh)
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
