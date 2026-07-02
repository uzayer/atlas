//! `chat` — a small on-device quantized instruct model for local RAG answers.
//!
//! Sibling to the BERT `Embedder`: same candle stack, but a generative decoder
//! instead of an encoder. Loads a GGUF Qwen3 checkpoint + its `tokenizer.json`,
//! then streams tokens for a fully-formatted prompt. Runs on the Apple-Silicon
//! GPU via candle's Metal backend when the `metal` feature is compiled in
//! (`src-tauri` enables it for macOS), falling back to CPU otherwise — a 0.6B
//! model at Q4 answers a short RAG query in a second or two, which is the point:
//! no API key, no network, the codebase's own memory answered locally.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use candle_core::quantized::gguf_file;
use candle_core::{Device, Tensor};
use candle_transformers::generation::LogitsProcessor;
use candle_transformers::models::quantized_qwen3::ModelWeights;
use tokenizers::Tokenizer;

/// Qwen3 ChatML control tokens. Generation stops at either.
const STOP_TOKENS: [&str; 2] = ["<|im_end|>", "<|endoftext|>"];

/// Pick the fastest available device: the Apple-Silicon GPU via Metal when the
/// `metal` feature is compiled in, else CPU. Metal init failures (e.g. headless
/// CI) fall back to CPU rather than erroring.
fn best_device() -> Device {
    #[cfg(feature = "metal")]
    {
        match Device::new_metal(0) {
            Ok(d) => {
                eprintln!("atlas-embed: chat model using Metal device");
                return d;
            }
            Err(e) => eprintln!("atlas-embed: Metal init failed ({e}); using CPU"),
        }
    }
    Device::Cpu
}

pub struct QuantizedChatModel {
    model: ModelWeights,
    tokenizer: Tokenizer,
    device: Device,
    stop_ids: Vec<u32>,
}

impl QuantizedChatModel {
    /// Load a GGUF checkpoint + its tokenizer. `gguf_path` is a quantized
    /// Qwen2.5-Instruct file; `tokenizer_path` the matching `tokenizer.json`.
    pub fn load(gguf_path: &Path, tokenizer_path: &Path) -> Result<Self> {
        let device = best_device();
        let mut file = std::fs::File::open(gguf_path)
            .with_context(|| format!("open {}", gguf_path.display()))?;
        let content = gguf_file::Content::read(&mut file)
            .map_err(|e| anyhow!("read gguf header: {e}"))?;
        let model = ModelWeights::from_gguf(content, &mut file, &device)
            .map_err(|e| anyhow!("load gguf weights: {e}"))?;

        let tokenizer =
            Tokenizer::from_file(tokenizer_path).map_err(|e| anyhow!("load tokenizer: {e}"))?;

        let stop_ids = STOP_TOKENS
            .iter()
            .filter_map(|t| tokenizer.token_to_id(t))
            .collect::<Vec<_>>();

        Ok(Self {
            model,
            tokenizer,
            device,
            stop_ids,
        })
    }

    /// Stream a completion for an already chat-templated `prompt`. `on_token` is
    /// called with each decoded text delta; `should_stop` is polled to support
    /// cooperative cancellation. Returns the full generated text.
    ///
    /// Blocking + CPU-heavy — run under `spawn_blocking`.
    pub fn generate<F, S>(
        &mut self,
        prompt: &str,
        max_tokens: usize,
        temperature: f64,
        mut on_token: F,
        should_stop: S,
    ) -> Result<String>
    where
        F: FnMut(&str),
        S: Fn() -> bool,
    {
        let encoding = self
            .tokenizer
            .encode(prompt, true)
            .map_err(|e| anyhow!("encode prompt: {e}"))?;
        let prompt_ids = encoding.get_ids().to_vec();
        if prompt_ids.is_empty() {
            return Ok(String::new());
        }

        let mut sampler = LogitsProcessor::new(42, Some(temperature), Some(0.9));

        // The model is cached across turns and Qwen3's ConcatKvCache *appends*
        // every forward (it is NOT reset by offset==0). Clear it before each turn
        // so the new prompt's kv length matches the freshly-built causal mask —
        // otherwise the second message fails with a broadcast_add shape mismatch.
        self.model.clear_kv_cache();

        // Prompt pass: offset 0 starts a fresh sequence on the cleared cache.
        let input = Tensor::new(prompt_ids.as_slice(), &self.device)?.unsqueeze(0)?;
        let mut logits = self.model.forward(&input, 0)?.squeeze(0)?;
        let mut pos = prompt_ids.len();

        let mut generated: Vec<u32> = Vec::new();
        // Decode the whole generated run each step and emit the new suffix — robust
        // to multi-byte tokens that a per-token decode would split.
        let mut prev = String::new();

        for _ in 0..max_tokens {
            if should_stop() {
                break;
            }
            let next = sampler.sample(&logits)?;
            if self.stop_ids.contains(&next) {
                break;
            }
            generated.push(next);

            let decoded = self.tokenizer.decode(&generated, true).unwrap_or_default();
            // Defensive: suppress any reasoning the model emits. The prompt already
            // pre-closes an empty <think> block (non-thinking mode), but if a quant
            // ignores that, strip <think>…</think> so reasoning never reaches the UI.
            let visible = strip_think(&decoded);
            if visible.len() > prev.len() && visible.starts_with(&prev) {
                on_token(&visible[prev.len()..]);
            }
            prev = visible;

            let input = Tensor::new(&[next], &self.device)?.unsqueeze(0)?;
            logits = self.model.forward(&input, pos)?.squeeze(0)?;
            pos += 1;
        }

        Ok(prev)
    }
}

/// Remove `<think>…</think>` reasoning from generated text. Complete blocks are
/// dropped entirely; an unclosed trailing `<think>` suppresses everything from it
/// onward (so partial reasoning is never streamed). Leading whitespace left by a
/// removed block is trimmed so the visible answer starts clean.
fn strip_think(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    loop {
        match rest.find("<think>") {
            Some(start) => {
                out.push_str(&rest[..start]);
                let after = &rest[start + "<think>".len()..];
                match after.find("</think>") {
                    Some(end) => rest = &after[end + "</think>".len()..],
                    None => break, // unclosed — drop the rest
                }
            }
            None => {
                out.push_str(rest);
                break;
            }
        }
    }
    out.trim_start().to_string()
}

/// Build a Qwen3 ChatML prompt from a system message + alternating user/assistant
/// turns. The final turn must be a user message.
///
/// Qwen3 is a hybrid reasoning model; for fast RAG we want **non-thinking** mode.
/// Rather than let it emit a `<think>…</think>` block (which would have to be
/// streamed then stripped), we PRE-FILL an empty, already-closed think block after
/// the assistant tag — exactly what Qwen3's `enable_thinking=false` template does —
/// so generation starts directly at the answer.
pub fn build_qwen_prompt(system: &str, turns: &[(String, String)]) -> String {
    let mut out = String::new();
    out.push_str("<|im_start|>system\n");
    out.push_str(system);
    out.push_str("\n<|im_end|>\n");
    for (role, content) in turns {
        out.push_str("<|im_start|>");
        out.push_str(role);
        out.push('\n');
        out.push_str(content);
        out.push_str("\n<|im_end|>\n");
    }
    out.push_str("<|im_start|>assistant\n<think>\n\n</think>\n\n");
    out
}
