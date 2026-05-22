//! Saved-papers index for the chat input's @-mention picker.
//!
//! Papers downloaded via `commands::research::download_paper` end up at
//! `<project>/.atlas/papers/<id>.json` (the metadata sidecar) plus a matching
//! `<id>.pdf`. This command enumerates the JSON sidecars so the mention
//! picker has a fast, reliable list without re-walking the directory on
//! every call.
//!
//! Cached in-process with the same mtime-pair pattern used by
//! `ClaudeSessionIndex` — entries with unchanged mtime are reused; the
//! mutex is never held across disk I/O.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
pub struct SavedPaper {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub metadata_path: String,
    pub local_pdf_path: Option<String>,
    pub downloaded_at: Option<String>,
}

#[derive(Default)]
pub struct SavedPapersIndex {
    inner: Mutex<HashMap<PathBuf, CacheEntry>>,
}

impl SavedPapersIndex {
    pub fn new() -> Self {
        Self::default()
    }
}

struct CacheEntry {
    mtime: SystemTime,
    paper: SavedPaper,
}

#[tauri::command]
pub async fn list_saved_papers(
    project_path: String,
    index: State<'_, SavedPapersIndex>,
) -> Result<Vec<SavedPaper>, String> {
    // Snapshot the cache so the disk walk runs without holding the mutex.
    let snapshot: HashMap<PathBuf, CacheEntry> = {
        let guard = index.inner.lock();
        guard
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    CacheEntry {
                        mtime: v.mtime,
                        paper: v.paper.clone(),
                    },
                )
            })
            .collect()
    };

    let (out, fresh) = tokio::task::spawn_blocking(
        move || -> Result<
            (Vec<SavedPaper>, Vec<(PathBuf, SystemTime, SavedPaper)>),
            String,
        > {
            let papers_dir = Path::new(&project_path).join(".atlas").join("papers");
            if !papers_dir.exists() {
                return Ok((Vec::new(), Vec::new()));
            }

            let mut out: Vec<SavedPaper> = Vec::new();
            let mut fresh: Vec<(PathBuf, SystemTime, SavedPaper)> = Vec::new();

            for entry in std::fs::read_dir(&papers_dir).map_err(|e| e.to_string())? {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let mtime = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                if let Some(prev) = snapshot.get(&path) {
                    if prev.mtime == mtime {
                        out.push(prev.paper.clone());
                        continue;
                    }
                }
                let Some(paper) = parse_metadata(&path) else {
                    continue;
                };
                out.push(paper.clone());
                fresh.push((path, mtime, paper));
            }

            // Most recently downloaded first.
            out.sort_by(|a, b| b.downloaded_at.cmp(&a.downloaded_at));
            Ok((out, fresh))
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    // Commit fresh entries, prune removed ones.
    {
        let mut guard = index.inner.lock();
        let present: std::collections::HashSet<PathBuf> = out
            .iter()
            .map(|p| PathBuf::from(&p.metadata_path))
            .collect();
        guard.retain(|k, _| present.contains(k));
        for (path, mtime, paper) in fresh {
            guard.insert(path, CacheEntry { mtime, paper });
        }
    }

    Ok(out)
}

fn parse_metadata(path: &Path) -> Option<SavedPaper> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    let v: serde_json::Value = serde_json::from_str(&buf).ok()?;
    let id = v.get("id")?.as_str()?.to_string();
    let title = v
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("(untitled paper)")
        .to_string();
    // The current download_paper command doesn't write authors into the
    // metadata sidecar, but save_paper_to_knowledge does receive them.
    // Tolerate both shapes — array or missing.
    let authors = v
        .get("authors")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let local_pdf_path = v
        .get("local_path")
        .and_then(|s| s.as_str())
        .map(String::from);
    let downloaded_at = v
        .get("downloaded_at")
        .and_then(|s| s.as_str())
        .map(String::from);
    Some(SavedPaper {
        id,
        title,
        authors,
        metadata_path: path.to_string_lossy().to_string(),
        local_pdf_path,
        downloaded_at,
    })
}
