//! Map an Atlas BYOK `(provider, model)` + key to a boxed Cersei provider.
//!
//! Identical strategy to `atlas-review`'s provider table (Anthropic native, all
//! others via the OpenAI-compatible client with a per-provider base URL) — kept
//! as a small self-contained copy so the native-agent crate doesn't pull in the
//! whole review engine.

use cersei::prelude::{Anthropic, OpenAi};
use cersei::provider::Provider;

/// OpenAI-compatible base URL for `provider`, or `None` if it isn't an
/// OpenAI-compatible provider (i.e. Anthropic, handled natively).
pub fn openai_base_url(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "openai" => "https://api.openai.com/v1",
        "google" => "https://generativelanguage.googleapis.com/v1beta/openai",
        "cohere" => "https://api.cohere.ai/compatibility/v1",
        "mistral" => "https://api.mistral.ai/v1",
        "xai" => "https://api.x.ai/v1",
        "deepseek" => "https://api.deepseek.com/v1",
        "groq" => "https://api.groq.com/openai/v1",
        "together" => "https://api.together.xyz/v1",
        "fireworks" => "https://api.fireworks.ai/inference/v1",
        "deepinfra" => "https://api.deepinfra.com/v1/openai",
        "cerebras" => "https://api.cerebras.ai/v1",
        "perplexity" => "https://api.perplexity.ai",
        "openrouter" => "https://openrouter.ai/api/v1",
        _ => return None,
    })
}

/// Build a boxed Cersei provider for `(provider, model)` using `api_key`.
pub fn build_provider(
    provider: &str,
    api_key: &str,
    model: &str,
) -> Result<Box<dyn Provider>, String> {
    if provider == "anthropic" {
        let p = Anthropic::builder()
            .api_key(api_key)
            .model(model)
            .build()
            .map_err(|e| format!("anthropic provider: {e}"))?;
        return Ok(Box::new(p));
    }

    let base = openai_base_url(provider)
        .ok_or_else(|| format!("unsupported provider: {provider}"))?;
    let p = OpenAi::builder()
        .api_key(api_key)
        .base_url(base)
        .model(model)
        .build()
        .map_err(|e| format!("{provider} provider: {e}"))?;
    Ok(Box::new(p))
}

/// Best-first preferred coding model per provider — the offline default the
/// runtime selects when the UI hasn't pinned one yet. Mirrors the frontend
/// `review-agents/lib/model-catalog.ts` PREFERRED table (keep in sync).
pub fn default_model_for(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "anthropic" => "claude-opus-4-8",
        "openai" => "gpt-5.1",
        "google" => "gemini-3.1-pro",
        "xai" => "grok-4",
        "deepseek" => "deepseek-reasoner",
        "mistral" => "mistral-large-latest",
        "groq" => "moonshotai/kimi-k2-instruct",
        "together" => "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "fireworks" => "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
        "deepinfra" => "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "cerebras" => "qwen-3-coder-480b",
        "openrouter" => "anthropic/claude-sonnet-4.6",
        "perplexity" => "sonar-reasoning-pro",
        "cohere" => "command-a-03-2025",
        _ => return None,
    })
}

/// Priority order used to pick a default provider from the configured BYOK keys
/// (strongest coding providers first).
pub const PROVIDER_PRIORITY: &[&str] = &[
    "anthropic",
    "openai",
    "google",
    "xai",
    "deepseek",
    "mistral",
    "groq",
    "together",
    "fireworks",
    "deepinfra",
    "cerebras",
    "openrouter",
    "perplexity",
    "cohere",
];
