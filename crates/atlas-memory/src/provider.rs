//! `MiniLmProvider` — bridges Atlas's on-device MiniLM embedder ([`atlas_embed::Embedder`])
//! into Cersei's [`EmbeddingProvider`] trait, so the same HNSW pipeline can later
//! accept a BYOK remote provider behind the same interface.
//!
//! Embeddings stay **on-device** (no network). The blocking candle forward pass
//! runs inside [`tokio::task::spawn_blocking`] so it never stalls the async
//! runtime / IPC channel.

use std::sync::Arc;

use async_trait::async_trait;
use atlas_embed::Embedder;
use cersei_embeddings::{EmbeddingError, EmbeddingProvider};

/// Provider identifier recorded in the manifest. A change here (e.g. switching to
/// a BYOK 1536-d provider) forces a full re-embed via `Manifest::provider_name`.
pub const PROVIDER_NAME: &str = "atlas-minilm-384";
/// `all-MiniLM-L6-v2` output dimensionality.
pub const DIM: usize = 384;

/// On-device MiniLM provider. Wraps a shared [`Embedder`] (the model is loaded
/// once, then cloned cheaply via `Arc` into each blocking task).
pub struct MiniLmProvider {
    embedder: Arc<Embedder>,
}

impl MiniLmProvider {
    /// Wrap an already-loaded embedder. Loading the model from disk is the
    /// caller's responsibility ([`Embedder::load`]) so the provider stays cheap
    /// to construct and testable without a model.
    pub fn new(embedder: Arc<Embedder>) -> Self {
        Self { embedder }
    }

    /// The wrapped on-device embedder, for callers that need synchronous
    /// `embed_one` / `embed` inside their own `spawn_blocking` (memory graph,
    /// index query, policy distillation, memory-chat). A cheap `Arc` clone — the
    /// underlying MiniLM model is loaded once (via [`MemoryRegistry::provider`])
    /// and shared everywhere, so no call site ever re-loads it from disk.
    pub fn embedder(&self) -> Arc<Embedder> {
        self.embedder.clone()
    }
}

#[async_trait]
impl EmbeddingProvider for MiniLmProvider {
    fn name(&self) -> &str {
        PROVIDER_NAME
    }

    fn dimensions(&self) -> usize {
        DIM
    }

    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let embedder = self.embedder.clone();
        let texts = texts.to_vec();
        // The candle forward pass is blocking CPU work — keep it off the async
        // runtime so the IPC channel never stalls (CLAUDE.md convention).
        tokio::task::spawn_blocking(move || embedder.embed(&texts))
            .await
            .map_err(|e| EmbeddingError::Api(format!("embed join error: {e}")))?
            .map_err(|e| EmbeddingError::Api(format!("on-device embed failed: {e}")))
    }
}

// Compile-time guarantee the provider is object-safe-friendly and shareable.
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<MiniLmProvider>();
};

#[cfg(test)]
mod tests {
    use super::*;

    /// Locate a local MiniLM model dir if one is installed, else `None`. Tests
    /// that need real embeddings skip cleanly when absent (no hard-fail / no
    /// network download).
    fn find_model_dir() -> Option<std::path::PathBuf> {
        if let Ok(dir) = std::env::var("ATLAS_MINILM_DIR") {
            let p = std::path::PathBuf::from(dir);
            if p.join("model.safetensors").exists() {
                return Some(p);
            }
        }
        None
    }

    #[test]
    fn name_and_dimensions_are_stable() {
        // No model needed: name()/dimensions() are constants on the type.
        // Build a provider only if a model is present; otherwise assert the
        // constants directly (the trait values mirror them).
        assert_eq!(PROVIDER_NAME, "atlas-minilm-384");
        assert_eq!(DIM, 384);

        if let Some(dir) = find_model_dir() {
            let embedder = Embedder::load(&dir).expect("load MiniLM model");
            let provider = MiniLmProvider::new(Arc::new(embedder));
            assert_eq!(provider.name(), "atlas-minilm-384");
            assert_eq!(provider.dimensions(), 384);
        }
    }

    #[test]
    fn embed_produces_384d_when_model_available() {
        let Some(dir) = find_model_dir() else {
            eprintln!("skipping: no MiniLM model dir (set ATLAS_MINILM_DIR to enable)");
            return;
        };
        let embedder = Embedder::load(&dir).expect("load MiniLM model");
        let provider = MiniLmProvider::new(Arc::new(embedder));
        let rt = tokio::runtime::Runtime::new().expect("tokio rt");
        let vecs = rt
            .block_on(provider.embed_batch(&["hello world".to_string()]))
            .expect("embed");
        assert_eq!(vecs.len(), 1);
        assert_eq!(vecs[0].len(), 384);
    }
}
