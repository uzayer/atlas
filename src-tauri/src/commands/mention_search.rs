//! Unified `mention_search` command — replaces the JS-side per-provider
//! fan-out + ranking in `src/features/chat/lib/mentions.ts`.
//!
//! Previously: each keystroke in the picker triggered N parallel JS
//! providers (`Promise.allSettled([files, folders, symbols, knowledge,
//! repos, papers, branches])`), each invoking its own Tauri command
//! and returning results, then JS ran `rankMention` to blend + sort.
//! That's per-keystroke N+1 IPCs + JS-side fuzzy scoring across all
//! results.
//!
//! Now: one Tauri command. Rust reads the data sources it already
//! owns (file/folder via the live `FileIndexState`, repo/paper via
//! existing computes, branch via `git_refs_compute`). Knowledge +
//! symbols are passed in from the frontend caches that already
//! mirror Rust state — the input is small (a few hundred entries)
//! and the alternative (a second Rust cache layer for them) was a
//! larger refactor without payoff for this round. All seven kinds
//! fan out in parallel via `tokio::join!`; every fuzzy match runs
//! through `nucleo` (the same matcher Cmd+P uses) and returns a
//! unified ranked top-N. Past-message is intentionally out of
//! scope — it's a two-level pick-session-then-search flow that
//! doesn't fit the unified shape.

use std::collections::HashMap;
use std::path::PathBuf;

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Matcher, Utf32Str};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};

use super::fileindex::FileIndexState;
use super::git::{GitRef, GitRefs};
use super::git_watcher::GitWatcherState;
use super::github::{list_cloned_repos, ClonedRepo};
use super::papers::{list_saved_papers, SavedPaper, SavedPapersIndex};

const PER_KIND_LIMIT: usize = 30;
const TOTAL_LIMIT: usize = 30;

/// Per-process cache of the two mention-search inputs whose authoritative
/// state currently lives in JS stores (knowledge entries from
/// `useKnowledgeStore`, symbols from `useAnalysisStore`). Pushed in via
/// `mention_cache_set_knowledge` / `mention_cache_set_symbols` when the
/// JS stores hydrate or mutate; read by `mention_search`.
///
/// Why this exists: before the cache, every @-picker keystroke
/// serialized the full knowledge + symbols arrays from JS to JSON,
/// shipped them over IPC to Rust, then Rust deserialized them. On a
/// project with 1000 symbols this was ~150 KB of JSON encode +
/// decode work on the JS main thread per keystroke — the perceived
/// typing lag in the picker. With the cache the per-keystroke
/// payload is just `(query, scope, project_path)` (a few hundred
/// bytes) and the heavy data sits hot in Rust.
/// Per-WINDOW caches (keyed by webview label), for the same reason as
/// `FileIndexState`: `.manage()` state is process-global, so a single cache
/// would let window B's knowledge/symbols leak into window A's @-mentions.
#[derive(Default)]
struct WindowCache {
    knowledge: Vec<KnowledgeInput>,
    symbols: Vec<SymbolInput>,
}

#[derive(Default)]
pub struct MentionCacheState {
    per_window: RwLock<HashMap<String, WindowCache>>,
}

impl MentionCacheState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drop a window's cache (called on window close).
    pub fn drop_window(&self, label: &str) {
        self.per_window.write().remove(label);
    }
}

#[tauri::command]
pub fn mention_cache_set_knowledge(
    items: Vec<KnowledgeInput>,
    webview: WebviewWindow,
    state: State<'_, MentionCacheState>,
) {
    state
        .per_window
        .write()
        .entry(webview.label().to_string())
        .or_default()
        .knowledge = items;
}

#[tauri::command]
pub fn mention_cache_set_symbols(
    items: Vec<SymbolInput>,
    webview: WebviewWindow,
    state: State<'_, MentionCacheState>,
) {
    state
        .per_window
        .write()
        .entry(webview.label().to_string())
        .or_default()
        .symbols = items;
}

#[tauri::command]
pub fn mention_cache_clear(webview: WebviewWindow, state: State<'_, MentionCacheState>) {
    state.per_window.write().remove(webview.label());
}

/// Frontend-supplied caches for kinds whose source-of-truth state
/// lives in JS today (analysis store, knowledge store). Mirrors of
/// Rust types but with `Deserialize` so the wire decoder can rebuild
/// them — the originals (`commands::analysis::Symbol`,
/// `commands::knowledge::KnowledgeEntry`) are Serialize-only.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolInput {
    pub name: String,
    pub kind: String,
    pub file_path: String,
    pub line: u32,
    pub signature: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeInput {
    pub id: String,
    pub title: String,
    /// Per-note emoji/glyph from `_meta.json`. `#[serde(default)]` so an
    /// older publisher that omits it still deserializes (→ None).
    #[serde(default)]
    pub icon: Option<String>,
    pub source: String,
    pub file_path: String,
}


/// Single result, discriminated by `kind`. Mirrors the TS
/// `MentionData` union field-for-field; `kind` is rendered in
/// snake_case so `kind: "past_message"` reads cleanly were it ever
/// added (today this enum doesn't include it).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum MentionResult {
    File {
        id: String,
        display_name: String,
        abs_path: String,
    },
    Folder {
        id: String,
        display_name: String,
        abs_path: String,
    },
    Symbol {
        id: String,
        display_name: String,
        signature: String,
        symbol_kind: String,
        file_path: String,
        line: u32,
    },
    Knowledge {
        id: String,
        display_name: String,
        icon: Option<String>,
        source: String,
        file_path: String,
        folder: Option<String>,
    },
    Repo {
        id: String,
        display_name: String,
        abs_path: String,
        has_readme: bool,
    },
    Paper {
        id: String,
        display_name: String,
        authors: Vec<String>,
        metadata_path: String,
    },
    Branch {
        id: String,
        display_name: String,
        sha: String,
        ref_kind: String,
        is_current: bool,
    },
}

fn matches_scope(scope: Option<&str>, kind: &str) -> bool {
    scope.is_none_or(|s| s == kind)
}

#[tauri::command]
pub async fn mention_search(
    query: String,
    scope: Option<String>,
    project_path: Option<String>,
    webview: WebviewWindow,
    fileindex: State<'_, FileIndexState>,
    papers: State<'_, SavedPapersIndex>,
    git_watcher: State<'_, GitWatcherState>,
    cache: State<'_, MentionCacheState>,
) -> Result<Vec<MentionResult>, String> {
    let label = webview.label().to_string();
    let scope_ref = scope.as_deref();
    let trimmed = query.trim().to_string();

    let want_file = matches_scope(scope_ref, "file");
    let want_folder = matches_scope(scope_ref, "folder");
    let want_repo = matches_scope(scope_ref, "repo");
    let want_paper = matches_scope(scope_ref, "paper");
    let want_branch = matches_scope(scope_ref, "branch");
    let want_symbol = matches_scope(scope_ref, "symbol");
    let want_knowledge = matches_scope(scope_ref, "knowledge");

    // Pull file/folder snapshots ONCE (no redundant clone) directly
    // from the lock-protected state. snapshot_folders uses the
    // watcher-invalidated cache so the O(files × depth) derivation
    // only runs after a real file-set change — not per keystroke.
    let files_snapshot: Option<Vec<(String, PathBuf)>> = if want_file {
        fileindex.snapshot_files(&label).map(|(files, _)| files)
    } else {
        None
    };
    let folders_snapshot: Option<Vec<(String, PathBuf)>> = if want_folder {
        fileindex.snapshot_folders(&label)
    } else {
        None
    };

    let project_for_repo = project_path.clone();
    let project_for_paper = project_path.clone();
    let project_for_branch = project_path.clone();

    let trimmed_for_file = trimmed.clone();
    let trimmed_for_folder = trimmed.clone();
    let trimmed_for_repo = trimmed.clone();
    let trimmed_for_paper = trimmed.clone();
    let trimmed_for_branch = trimmed.clone();
    let trimmed_for_symbol = trimmed.clone();
    let trimmed_for_knowledge = trimmed.clone();

    let file_fut = async move {
        let Some(files) = files_snapshot else {
            return Vec::new();
        };
        rank_files(&trimmed_for_file, files)
    };

    let folder_fut = async move {
        let Some(folders) = folders_snapshot else {
            return Vec::new();
        };
        rank_folders(&trimmed_for_folder, folders)
    };

    let repo_fut = async move {
        if !want_repo {
            return Vec::new();
        }
        let Some(project_path) = project_for_repo else {
            return Vec::new();
        };
        match list_cloned_repos(project_path).await {
            Ok(rows) => rank_repos(&trimmed_for_repo, rows),
            Err(_) => Vec::new(),
        }
    };

    let papers_state = papers.clone();
    let paper_fut = async move {
        if !want_paper {
            return Vec::new();
        }
        let Some(project_path) = project_for_paper else {
            return Vec::new();
        };
        match list_saved_papers(project_path, papers_state).await {
            Ok(rows) => rank_papers(&trimmed_for_paper, rows),
            Err(_) => Vec::new(),
        }
    };

    // Branch refs come from a watcher-invalidated cache (see
    // `GitWatcherState::get_or_compute_refs`). First call per project
    // pays the ~80 ms of `git rev-parse` / `for-each-ref` shell-outs;
    // every subsequent keystroke is sub-microsecond until the
    // watcher flushes the cache on the next git mutation. Before
    // this cache the @-mention picker fired three `git` subprocesses
    // per keystroke and stuttered visibly on large repos.
    let cached_refs: Option<GitRefs> = match (&project_for_branch, want_branch) {
        (Some(p), true) => git_watcher.get_or_compute_refs(p),
        _ => None,
    };
    let branch_fut = async move {
        if !want_branch {
            return Vec::new();
        }
        let Some(refs) = cached_refs else {
            return Vec::new();
        };
        rank_branches(&trimmed_for_branch, refs)
    };

    // Pull from the cache instead of taking the data as an argument.
    // Cloning a few hundred entries here is sub-millisecond; the
    // savings come from NOT serializing+deserializing those
    // entries across the IPC boundary on every keystroke (the old
    // path could push 100-500 KB per keystroke on a project with
    // many symbols, which was the visible typing lag).
    let symbols_data: Vec<SymbolInput> = if want_symbol {
        cache
            .per_window
            .read()
            .get(&label)
            .map(|c| c.symbols.clone())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let symbol_fut = async move {
        if !want_symbol {
            return Vec::new();
        }
        rank_symbols(&trimmed_for_symbol, symbols_data)
    };

    let knowledge_data: Vec<KnowledgeInput> = if want_knowledge {
        cache
            .per_window
            .read()
            .get(&label)
            .map(|c| c.knowledge.clone())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let knowledge_fut = async move {
        if !want_knowledge {
            return Vec::new();
        }
        rank_knowledge(&trimmed_for_knowledge, knowledge_data)
    };

    let (files, folders, repos, papers_res, branches, symbols_res, knowledge_res) = tokio::join!(
        file_fut, folder_fut, repo_fut, paper_fut, branch_fut, symbol_fut, knowledge_fut
    );

    // Blend in the order JS used to. The picker's existing UI groups
    // by kind so order matters less than per-kind ranking; we
    // preserve the prior visual sequence for parity.
    let mut all: Vec<MentionResult> = Vec::new();
    all.extend(files);
    all.extend(folders);
    all.extend(symbols_res);
    all.extend(knowledge_res);
    all.extend(repos);
    all.extend(papers_res);
    all.extend(branches);

    if scope_ref.is_some() {
        Ok(all.into_iter().take(PER_KIND_LIMIT).collect())
    } else {
        Ok(all.into_iter().take(TOTAL_LIMIT).collect())
    }
}

// ── Per-kind ranking ────────────────────────────────────────────────────

/// Empty-query fast path: no scoring, no full vec, no sort. The
/// caller is asking for "top N in some natural order" — for a
/// scoped picker view this is "the first N items as we have them."
/// Skipping nucleo for the empty case avoids the previous behavior
/// of allocating an N-entry scored vec + sort_by every keystroke
/// when no query has been typed yet.
fn rank_files(query: &str, files: Vec<(String, PathBuf)>) -> Vec<MentionResult> {
    if query.is_empty() {
        return files
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|(rel, abs)| {
                let abs_str = abs.to_string_lossy().into_owned();
                MentionResult::File {
                    id: abs_str.clone(),
                    display_name: rel,
                    abs_path: abs_str,
                }
            })
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, (String, PathBuf))> = files
        .into_iter()
        .filter_map(|(rel, abs)| {
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&rel, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, (rel, abs)))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(_, (rel, abs))| {
            let abs_str = abs.to_string_lossy().into_owned();
            MentionResult::File {
                id: abs_str.clone(),
                display_name: rel,
                abs_path: abs_str,
            }
        })
        .collect()
}

fn rank_folders(
    query: &str,
    folders: Vec<(String, PathBuf)>,
) -> Vec<MentionResult> {
    if query.is_empty() {
        return folders
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|(rel, abs)| {
                let abs_str = abs.to_string_lossy().into_owned();
                MentionResult::Folder {
                    id: abs_str.clone(),
                    display_name: rel,
                    abs_path: abs_str,
                }
            })
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, (String, PathBuf))> = folders
        .into_iter()
        .filter_map(|(rel, abs)| {
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&rel, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, (rel, abs)))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(_, (rel, abs))| {
            let abs_str = abs.to_string_lossy().into_owned();
            MentionResult::Folder {
                id: abs_str.clone(),
                display_name: rel,
                abs_path: abs_str,
            }
        })
        .collect()
}

fn rank_repos(query: &str, rows: Vec<ClonedRepo>) -> Vec<MentionResult> {
    if query.is_empty() {
        return rows
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|r| MentionResult::Repo {
                id: r.path.clone(),
                display_name: r.name,
                abs_path: r.path,
                has_readme: r.has_readme,
            })
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, ClonedRepo)> = rows
        .into_iter()
        .filter_map(|r| {
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&r.name, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, r))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(_, r)| MentionResult::Repo {
            id: r.path.clone(),
            display_name: r.name,
            abs_path: r.path,
            has_readme: r.has_readme,
        })
        .collect()
}

fn rank_papers(query: &str, rows: Vec<SavedPaper>) -> Vec<MentionResult> {
    if query.is_empty() {
        return rows
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|p| MentionResult::Paper {
                id: p.id,
                display_name: p.title,
                authors: p.authors,
                metadata_path: p.metadata_path,
            })
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, SavedPaper)> = rows
        .into_iter()
        .filter_map(|p| {
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&p.title, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, p))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(_, p)| MentionResult::Paper {
            id: p.id,
            display_name: p.title,
            authors: p.authors,
            metadata_path: p.metadata_path,
        })
        .collect()
}

fn rank_branches(query: &str, refs: GitRefs) -> Vec<MentionResult> {
    let pool: Vec<GitRef> = refs
        .refs
        .into_iter()
        .filter(|r| r.kind == "branch" || r.kind == "remote")
        .collect();
    if query.is_empty() {
        return pool
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|r| MentionResult::Branch {
                id: r.name.clone(),
                display_name: r.name,
                sha: r.sha,
                ref_kind: r.kind,
                is_current: r.is_current,
            })
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, GitRef)> = pool
        .into_iter()
        .filter_map(|r| {
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&r.name, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, r))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(_, r)| MentionResult::Branch {
            id: r.name.clone(),
            display_name: r.name,
            sha: r.sha,
            ref_kind: r.kind,
            is_current: r.is_current,
        })
        .collect()
}

fn rank_symbols(query: &str, symbols: Vec<SymbolInput>) -> Vec<MentionResult> {
    if query.is_empty() {
        return symbols
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|s| MentionResult::Symbol {
                id: format!("{}@{}:{}", s.name, s.file_path, s.line),
                display_name: s.name,
                signature: s.signature,
                symbol_kind: s.kind,
                file_path: s.file_path,
                line: s.line,
            })
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, SymbolInput)> = symbols
        .into_iter()
        .filter_map(|s| {
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&s.name, &mut buf);
            pattern.score(utf, &mut matcher).map(|sc| (sc, s))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(_, s)| MentionResult::Symbol {
            id: format!("{}@{}:{}", s.name, s.file_path, s.line),
            display_name: s.name,
            signature: s.signature,
            symbol_kind: s.kind,
            file_path: s.file_path,
            line: s.line,
        })
        .collect()
}

fn rank_knowledge(query: &str, entries: Vec<KnowledgeInput>) -> Vec<MentionResult> {
    if query.is_empty() {
        return entries
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|e| {
                let folder = e.id.rfind('/').map(|i| e.id[..i].to_string());
                MentionResult::Knowledge {
                    id: e.id,
                    display_name: e.title,
                    icon: e.icon,
                    source: e.source,
                    file_path: e.file_path,
                    folder,
                }
            })
            .collect();
    }
    // Match against `title + " " + folder` so typing a space name
    // surfaces its entries — parity with the prior JS behavior.
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, KnowledgeInput, Option<String>)> = entries
        .into_iter()
        .map(|e| {
            let folder = e.id.rfind('/').map(|i| e.id[..i].to_string());
            (e, folder)
        })
        .filter_map(|(e, folder)| {
            let haystack = match &folder {
                Some(f) => format!("{} {}", e.title, f),
                None => e.title.clone(),
            };
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&haystack, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, e, folder))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(_, e, folder)| MentionResult::Knowledge {
            id: e.id,
            display_name: e.title,
            icon: e.icon,
            source: e.source,
            file_path: e.file_path,
            folder,
        })
        .collect()
}
