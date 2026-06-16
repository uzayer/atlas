//! Map an Atlas BYOK `(provider, model)` + key to a boxed Cersei provider.
//!
//! Anthropic uses Cersei's native client; every other provider is reached
//! through the OpenAI-compatible client with a per-provider base URL. This
//! table is the canonical list of providers the review engine can drive — the
//! Tauri layer filters it against which BYOK keys are actually configured.
//!
//! (Atlas's Model-Chat tab keeps its own table because it runs on Rig, a
//! different SDK; the two are intentionally independent.)

use cersei::prelude::{Anthropic, OpenAi};
use cersei::provider::Provider;

/// OpenAI-compatible base URL for `provider`, or `None` if it isn't an
/// OpenAI-compatible provider (i.e. Anthropic, which is handled natively).
pub fn openai_base_url(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "openai" => "https://api.openai.com/v1",
        // Gemini exposes an OpenAI-compatible surface; reuse it so the same
        // code path serves Google keys.
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

/// Every provider the review engine can drive (Anthropic native + all
/// OpenAI-compatible ones above).
pub fn supported_providers() -> &'static [&'static str] {
    &[
        "anthropic",
        "openai",
        "google",
        "cohere",
        "mistral",
        "xai",
        "deepseek",
        "groq",
        "together",
        "fireworks",
        "deepinfra",
        "cerebras",
        "perplexity",
        "openrouter",
    ]
}

/// Whether the review engine knows how to drive `provider`.
pub fn is_supported(provider: &str) -> bool {
    provider == "anthropic" || openai_base_url(provider).is_some()
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
        .ok_or_else(|| format!("unsupported review provider: {provider}"))?;
    let p = OpenAi::builder()
        .api_key(api_key)
        .base_url(base)
        .model(model)
        .build()
        .map_err(|e| format!("{provider} provider: {e}"))?;
    Ok(Box::new(p))
}
