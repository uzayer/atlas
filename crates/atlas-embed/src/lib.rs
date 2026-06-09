//! `atlas-embed` — on-device text embeddings + a small vector store, isolated
//! in its own crate so the heavy `candle` dependency tree doesn't slow the main
//! app's incremental builds.
//!
//! The embedder loads a BERT-style sentence-transformer (default target:
//! `all-MiniLM-L6-v2`, 384-dim) from a local directory of three files —
//! `config.json`, `tokenizer.json`, `model.safetensors` — and produces
//! L2-normalized mean-pooled sentence vectors. Because vectors are unit-length,
//! cosine similarity is just a dot product.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use candle_core::{Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config, DTYPE};
use tokenizers::{Tokenizer, TruncationDirection, TruncationParams, TruncationStrategy};

/// BERT position embeddings cap; MiniLM/BERT support up to 512 tokens.
const MAX_TOKENS: usize = 512;

/// A loaded sentence-embedding model. CPU-only — embedding a few hundred short
/// memory documents is sub-second and avoids Metal/Accelerate setup cost.
pub struct Embedder {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
    dim: usize,
}

impl Embedder {
    /// Load from a directory containing `config.json`, `tokenizer.json` and
    /// `model.safetensors`.
    pub fn load(model_dir: &Path) -> Result<Self> {
        let config_path = model_dir.join("config.json");
        let tokenizer_path = model_dir.join("tokenizer.json");
        let weights_path = model_dir.join("model.safetensors");

        let config_str = std::fs::read_to_string(&config_path)
            .with_context(|| format!("read {}", config_path.display()))?;
        let config: Config = serde_json::from_str(&config_str).context("parse config.json")?;
        let dim = config.hidden_size;

        let mut tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| anyhow!("load tokenizer: {e}"))?;
        // Cap sequence length so long memory bodies don't blow past the model's
        // position-embedding range.
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_TOKENS,
                strategy: TruncationStrategy::LongestFirst,
                stride: 0,
                direction: TruncationDirection::Right,
            }))
            .map_err(|e| anyhow!("set truncation: {e}"))?;

        let device = Device::Cpu;
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_path.clone()], DTYPE, &device)
                .with_context(|| format!("mmap {}", weights_path.display()))?
        };
        let model = BertModel::load(vb, &config).context("load BERT weights")?;

        Ok(Self {
            model,
            tokenizer,
            device,
            dim,
        })
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    /// Embed a batch of texts, one forward pass each (no padding needed).
    /// Returns L2-normalized vectors of length `self.dim`.
    pub fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        texts.iter().map(|t| self.embed_one(t)).collect()
    }

    pub fn embed_one(&self, text: &str) -> Result<Vec<f32>> {
        let encoding = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| anyhow!("tokenize: {e}"))?;
        let ids = encoding.get_ids();
        if ids.is_empty() {
            return Ok(vec![0.0; self.dim]);
        }

        let input_ids = Tensor::new(ids, &self.device)?.unsqueeze(0)?; // [1, n]
        let token_type_ids = input_ids.zeros_like()?;
        let attention_mask = Tensor::ones_like(&input_ids)?;

        // [1, n, hidden]
        let ys = self
            .model
            .forward(&input_ids, &token_type_ids, Some(&attention_mask))?;

        // Mean-pool over the token dimension → [1, hidden].
        let (_b, n_tokens, _h) = ys.dims3()?;
        let summed = ys.sum(1)?;
        let mean = (summed / n_tokens as f64)?;

        // L2-normalize so cosine == dot.
        let norm = mean.sqr()?.sum_keepdim(1)?.sqrt()?;
        let normed = mean.broadcast_div(&norm)?;

        Ok(normed.squeeze(0)?.to_vec1::<f32>()?)
    }
}

// ── Vector store ────────────────────────────────────────────────────────────

/// Cosine similarity of two unit vectors == dot product.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Pluggable nearest-neighbor backend. `BruteForce` is exact and ideal at the
/// memory-corpus scale (dozens–hundreds of vectors); a DiskANN-backed impl can
/// drop in behind this trait later for large corpora.
pub trait VectorStore {
    /// Top-`k` (index, score) pairs for `query`, best first.
    fn search(&self, query: &[f32], k: usize) -> Vec<(usize, f32)>;
}

/// Exact O(n) cosine search over in-memory unit vectors.
pub struct BruteForce {
    vectors: Vec<Vec<f32>>,
}

impl BruteForce {
    pub fn new(vectors: Vec<Vec<f32>>) -> Self {
        Self { vectors }
    }

    pub fn len(&self) -> usize {
        self.vectors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.vectors.is_empty()
    }

    /// For each vector, its top-`k` neighbors (excluding itself). Used to build
    /// the similarity graph edges.
    pub fn all_pairs_topk(&self, k: usize) -> Vec<Vec<(usize, f32)>> {
        (0..self.vectors.len())
            .map(|i| {
                let mut scored: Vec<(usize, f32)> = self
                    .vectors
                    .iter()
                    .enumerate()
                    .filter(|(j, _)| *j != i)
                    .map(|(j, v)| (j, cosine(&self.vectors[i], v)))
                    .collect();
                scored.sort_by(|a, b| b.1.total_cmp(&a.1));
                scored.truncate(k);
                scored
            })
            .collect()
    }
}

impl VectorStore for BruteForce {
    fn search(&self, query: &[f32], k: usize) -> Vec<(usize, f32)> {
        let mut scored: Vec<(usize, f32)> = self
            .vectors
            .iter()
            .enumerate()
            .map(|(i, v)| (i, cosine(query, v)))
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        scored.truncate(k);
        scored
    }
}
