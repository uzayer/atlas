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

use std::path::{Path, PathBuf};

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Matcher, Utf32Str};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::fileindex::FileIndexState;
use super::git::{git_refs_compute, GitRef, GitRefs};
use super::github::{list_cloned_repos, ClonedRepo};
use super::papers::{list_saved_papers, SavedPaper, SavedPapersIndex};

const PER_KIND_LIMIT: usize = 30;
const TOTAL_LIMIT: usize = 30;

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
    pub source: String,
    pub file_path: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct MentionSearchInputs {
    #[serde(default)]
    pub knowledge: Vec<KnowledgeInput>,
    #[serde(default)]
    pub symbols: Vec<SymbolInput>,
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
    inputs: MentionSearchInputs,
    fileindex: State<'_, FileIndexState>,
    papers: State<'_, SavedPapersIndex>,
) -> Result<Vec<MentionResult>, String> {
    let scope_ref = scope.as_deref();
    let trimmed = query.trim().to_string();

    // Snapshot the file-index data once — releasing the lock before
    // any async work — so the two file/folder branches can run
    // without contending. Empty when no project is open.
    let file_snapshot: Option<(Vec<(String, PathBuf)>, PathBuf)> = {
        let guard = fileindex.snapshot_files();
        guard.map(|(files, root)| {
            (
                files
                    .into_iter()
                    .map(|(rel, abs)| (rel, abs))
                    .collect::<Vec<_>>(),
                root,
            )
        })
    };

    let want_file = matches_scope(scope_ref, "file");
    let want_folder = matches_scope(scope_ref, "folder");
    let want_repo = matches_scope(scope_ref, "repo");
    let want_paper = matches_scope(scope_ref, "paper");
    let want_branch = matches_scope(scope_ref, "branch");
    let want_symbol = matches_scope(scope_ref, "symbol");
    let want_knowledge = matches_scope(scope_ref, "knowledge");

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

    let file_snapshot_for_file = file_snapshot.clone();
    let file_fut = async move {
        if !want_file {
            return Vec::new();
        }
        let Some((files, _)) = file_snapshot_for_file else {
            return Vec::new();
        };
        rank_files(&trimmed_for_file, files)
    };

    let folder_fut = async move {
        if !want_folder {
            return Vec::new();
        }
        let Some((files, root)) = file_snapshot else {
            return Vec::new();
        };
        rank_folders(&trimmed_for_folder, files, root)
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

    let branch_fut = async move {
        if !want_branch {
            return Vec::new();
        }
        let Some(project_path) = project_for_branch else {
            return Vec::new();
        };
        let result =
            tokio::task::spawn_blocking(move || git_refs_compute(&project_path)).await;
        let Ok(Ok(refs)) = result else {
            return Vec::new();
        };
        rank_branches(&trimmed_for_branch, refs)
    };

    let symbols_data = inputs.symbols;
    let symbol_fut = async move {
        if !want_symbol {
            return Vec::new();
        }
        rank_symbols(&trimmed_for_symbol, symbols_data)
    };

    let knowledge_data = inputs.knowledge;
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

fn pattern_for(query: &str) -> Option<Pattern> {
    if query.is_empty() {
        None
    } else {
        Some(Pattern::parse(
            query,
            CaseMatching::Smart,
            Normalization::Smart,
        ))
    }
}

fn score_one(matcher: &mut Matcher, pattern: Option<&Pattern>, haystack: &str) -> Option<u32> {
    match pattern {
        Some(p) => {
            let mut buf = Vec::new();
            let utf = Utf32Str::new(haystack, &mut buf);
            p.score(utf, matcher)
        }
        None => Some(0),
    }
}

fn rank_files(query: &str, files: Vec<(String, PathBuf)>) -> Vec<MentionResult> {
    let pattern = pattern_for(query);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, (String, PathBuf))> = files
        .into_iter()
        .filter_map(|(rel, abs)| score_one(&mut matcher, pattern.as_ref(), &rel).map(|s| (s, (rel, abs))))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(_, (rel, abs))| MentionResult::File {
            id: abs.to_string_lossy().into_owned(),
            display_name: rel,
            abs_path: abs.to_string_lossy().into_owned(),
        })
        .collect()
}

fn rank_folders(
    query: &str,
    files: Vec<(String, PathBuf)>,
    root: PathBuf,
) -> Vec<MentionResult> {
    // Derive unique parent dirs from the file list — same logic as
    // fileindex_search_dirs.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut folders: Vec<(String, PathBuf)> = Vec::new();
    for (rel, _) in &files {
        let mut cur = Path::new(rel).parent();
        while let Some(p) = cur {
            let r = p.to_string_lossy();
            if r.is_empty() {
                break;
            }
            let r = r.into_owned();
            if seen.insert(r.clone()) {
                folders.push((r, root.join(p)));
            }
            cur = p.parent();
        }
    }

    let pattern = pattern_for(query);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, (String, PathBuf))> = folders
        .into_iter()
        .filter_map(|(rel, abs)| score_one(&mut matcher, pattern.as_ref(), &rel).map(|s| (s, (rel, abs))))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(_, (rel, abs))| MentionResult::Folder {
            id: abs.to_string_lossy().into_owned(),
            display_name: rel,
            abs_path: abs.to_string_lossy().into_owned(),
        })
        .collect()
}

fn rank_repos(query: &str, rows: Vec<ClonedRepo>) -> Vec<MentionResult> {
    let pattern = pattern_for(query);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, ClonedRepo)> = rows
        .into_iter()
        .filter_map(|r| score_one(&mut matcher, pattern.as_ref(), &r.name).map(|s| (s, r)))
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
    let pattern = pattern_for(query);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, SavedPaper)> = rows
        .into_iter()
        .filter_map(|p| score_one(&mut matcher, pattern.as_ref(), &p.title).map(|s| (s, p)))
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
    let pattern = pattern_for(query);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, GitRef)> = pool
        .into_iter()
        .filter_map(|r| score_one(&mut matcher, pattern.as_ref(), &r.name).map(|s| (s, r)))
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
    let pattern = pattern_for(query);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, SymbolInput)> = symbols
        .into_iter()
        .filter_map(|s| score_one(&mut matcher, pattern.as_ref(), &s.name).map(|sc| (sc, s)))
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
    // Match against `title + " " + folder` so typing a space name
    // surfaces its entries — parity with the prior JS behavior.
    let pattern = pattern_for(query);
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
            score_one(&mut matcher, pattern.as_ref(), &haystack).map(|s| (s, e, folder))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(_, e, folder)| MentionResult::Knowledge {
            id: e.id,
            display_name: e.title,
            source: e.source,
            file_path: e.file_path,
            folder,
        })
        .collect()
}
