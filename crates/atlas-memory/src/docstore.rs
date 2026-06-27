//! `DocStore` — the id→display-text side-map persisted beside the HNSW + manifest.
//!
//! The HNSW store holds only vectors and the [`crate::manifest::Manifest`] holds
//! only the id↔key bijection + content hashes — neither carries the snippet text
//! a retrieval result needs. The legacy brute-force path re-derived text from the
//! Tauri-side corpus at query time, but the engine is a LOW crate with no access
//! to `collect_corpus`, and re-gathering the corpus on the retrieve hot path is
//! exactly the coupling this replan removes. So the engine persists a lightweight
//! `id → {title, source, text}` map (`docstore.json`) written atomically with the
//! manifest during indexing; retrieval reads it to build [`crate::RetrievedDoc`]s.
//!
//! The display fields are derived from the indexed [`crate::CorpusDoc`]: `source`
//! is its `corpus` tag, and `title`/`text` are recovered by splitting the embedded
//! text on its first blank line (the indexer folds a doc as `"{title}\n\n{body}"`
//! for embedding signal — see `memory_indexer::embed_text`). Single-line titles
//! never contain a blank line, so the split is lossless.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

/// Display fields for one indexed document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocText {
    pub title: String,
    pub source: String,
    pub text: String,
}

/// id → display-text map, persisted as `docstore.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DocStore {
    docs: HashMap<String, DocText>,
}

impl DocStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Load from JSON at `path`. A missing file is an error — callers fall back to
    /// [`DocStore::new`] (mirrors [`crate::manifest::Manifest::load`]).
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|e| anyhow!("read docstore: {e}"))?;
        serde_json::from_slice(&bytes).map_err(|e| anyhow!("parse docstore: {e}"))
    }

    /// Atomically persist to JSON at `path` (temp + rename), so a reader never
    /// observes a partial file — same discipline as the manifest write.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec_pretty(self).map_err(|e| anyhow!("serialize docstore: {e}"))?;
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = std::path::PathBuf::from(tmp);
        std::fs::write(&tmp, &json).map_err(|e| anyhow!("write tmp: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| anyhow!("rename: {e}"))?;
        Ok(())
    }

    /// Insert/replace the display text for `id`.
    pub fn upsert(&mut self, id: &str, doc: DocText) {
        self.docs.insert(id.to_string(), doc);
    }

    /// Drop the entry for `id` (no-op if absent).
    pub fn remove(&mut self, id: &str) {
        self.docs.remove(id);
    }

    /// Display text for `id`, if indexed.
    pub fn get(&self, id: &str) -> Option<&DocText> {
        self.docs.get(id)
    }

    pub fn len(&self) -> usize {
        self.docs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }
}

/// Recover `(title, body)` from an embedded text blob. The indexer folds a doc as
/// `"{title}\n\n{body}"` (or just `"{title}"` when the body is empty); split on the
/// first blank line. Titles are single-line, so this is lossless.
pub fn split_embedded(text: &str) -> (String, String) {
    match text.split_once("\n\n") {
        Some((title, body)) => (title.trim().to_string(), body.trim().to_string()),
        None => (text.trim().to_string(), String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("atlas-memory-docstore-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn split_embedded_recovers_title_and_body() {
        let (t, b) = split_embedded("Auth design\n\nUses Better Auth with DB sessions");
        assert_eq!(t, "Auth design");
        assert_eq!(b, "Uses Better Auth with DB sessions");

        // Title-only doc (empty body folded to just the title).
        let (t2, b2) = split_embedded("Just a title");
        assert_eq!(t2, "Just a title");
        assert_eq!(b2, "");
    }

    #[test]
    fn roundtrip_persist_reload() {
        let mut ds = DocStore::new();
        ds.upsert(
            "a",
            DocText {
                title: "T".into(),
                source: "claude".into(),
                text: "body".into(),
            },
        );
        let dir = tmp_dir("roundtrip");
        let path = dir.join("docstore.json");
        ds.save(&path).unwrap();

        let loaded = DocStore::load(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded.get("a").unwrap().source, "claude");

        ds.remove("a");
        assert!(ds.is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
