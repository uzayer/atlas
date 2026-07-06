//! `atlas-embed` — on-device text embeddings + a small vector store, isolated
//! in its own crate so the heavy `candle` dependency tree doesn't slow the main
//! app's incremental builds.
//!
//! The embedder loads a BERT-style sentence-transformer (default target:
//! `all-MiniLM-L6-v2`, 384-dim) from a local directory of three files —
//! `config.json`, `tokenizer.json`, `model.safetensors` — and produces
//! L2-normalized mean-pooled sentence vectors. Because vectors are unit-length,
//! cosine similarity is just a dot product.
//!
//! The crate also hosts a small generative counterpart in [`chat`]: a quantized
//! Qwen2.5-Instruct decoder for local RAG answers, sharing the same candle stack.

use std::path::Path;

pub mod chat;

use anyhow::{anyhow, Context, Result};
use candle_core::{Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config, DTYPE};
use tokenizers::{Tokenizer, TruncationDirection, TruncationParams, TruncationStrategy};

/// BERT position embeddings cap; MiniLM/BERT support up to 512 tokens.
const MAX_TOKENS: usize = 512;

/// A loaded sentence-embedding model. Runs on the Apple-Silicon GPU via Metal
/// when the `metal` feature is compiled in (falling back to CPU on init
/// failure); CPU otherwise.
pub struct Embedder {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
    dim: usize,
}

/// Try to build the Apple-Silicon Metal device. `None` when the `metal` feature
/// is off or device init fails. As with the chat model, a successful device does
/// NOT guarantee candle's Metal *kernels* compile on this OS — hence the guarded
/// load below. Mirrors `chat::metal_device`.
#[cfg(feature = "metal")]
fn metal_device() -> Option<Device> {
    match Device::new_metal(0) {
        Ok(d) => Some(d),
        Err(e) => {
            eprintln!("atlas-embed: Metal init failed ({e}); using CPU");
            None
        }
    }
}

impl Embedder {
    /// Load from a directory containing `config.json`, `tokenizer.json` and
    /// `model.safetensors`, preferring the Apple-Silicon GPU but resiliently
    /// falling back to CPU.
    ///
    /// Like the chat model, candle can panic while compiling its Metal kernels on
    /// an OS/toolchain metallib mismatch. The Metal path is `catch_unwind`-guarded
    /// (with a warm-up forward inside `load_on` to force lazy kernel compilation)
    /// and retries on CPU. `ATLAS_EMBED_CPU=1` skips Metal entirely.
    pub fn load(model_dir: &Path) -> Result<Self> {
        let force_cpu = std::env::var_os("ATLAS_EMBED_CPU").is_some();

        #[cfg(feature = "metal")]
        {
            if !force_cpu {
                if let Some(dev) = metal_device() {
                    let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        Self::load_on(model_dir, dev)
                    }));
                    match attempt {
                        Ok(Ok(model)) => return Ok(model),
                        Ok(Err(e)) => eprintln!(
                            "atlas-embed: Metal embedder load failed ({e}); falling back to CPU"
                        ),
                        Err(_) => eprintln!(
                            "atlas-embed: Metal embedder kernels failed to compile \
                             (candle/OS metallib mismatch); falling back to CPU"
                        ),
                    }
                    return Self::load_on(model_dir, Device::Cpu);
                }
            }
        }

        let _ = force_cpu; // silence unused warning when metal is off
        Self::load_on(model_dir, Device::Cpu)
    }

    /// Build the embedder on an explicit device, ending with a warm-up forward so
    /// candle's lazy Metal kernel compilation surfaces here (inside the caller's
    /// panic guard) rather than on the first real embed.
    fn load_on(model_dir: &Path, device: Device) -> Result<Self> {
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

        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_path.clone()], DTYPE, &device)
                .with_context(|| format!("mmap {}", weights_path.display()))?
        };
        let model = BertModel::load(vb, &config).context("load BERT weights")?;

        let embedder = Self {
            model,
            tokenizer,
            device,
            dim,
        };
        // Warm-up: run one forward so Metal kernels compile now (or panic here,
        // under the load-time guard) instead of on the first retrieval.
        let _ = embedder.embed_one("warm");

        Ok(embedder)
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
