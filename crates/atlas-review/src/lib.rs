//! Atlas code-review engine.
//!
//! A tool-free, single-turn Cersei agent that takes a raw `git` diff and a BYOK
//! `(provider, model, key)` and produces a structured, PR-Agent-style verdict —
//! streamed token-by-token so the UI feels live. The pipeline is:
//! pack diff ([`diff`]) → prompt ([`prompt`]) → stream agent → parse
//! ([`verdict`]). The crate is host-agnostic: it never touches the keystore,
//! git, or Tauri — callers pass the diff and key in and forward [`ReviewEvent`]s
//! back out.

pub mod diff;
pub mod prompt;
pub mod provider;
pub mod verdict;

use std::sync::Arc;

// Import specific items, NOT a glob: `cersei::prelude` re-exports its own
// single-parameter `Result` alias, which would shadow std `Result<T, E>`.
use cersei::prelude::{Agent, AgentEvent, DenyAll};

pub use provider::{is_supported, openai_base_url, supported_providers};
pub use tokio_util::sync::CancellationToken;
pub use verdict::{KeyIssue, ReviewVerdict};

/// Default token budget for the diff sent to the model (input side). Generous
/// enough for most local changes; large diffs are compressed to fit.
pub const DEFAULT_MAX_INPUT_TOKENS: usize = 60_000;

/// Inputs for one review run.
pub struct ReviewOptions {
    /// BYOK provider id (e.g. "anthropic", "openai", "groq").
    pub provider: String,
    /// Model id understood by that provider.
    pub model: String,
    /// The provider API key (resolved by the caller from BYOK storage).
    pub api_key: String,
    /// Raw unified `git` diff to review.
    pub raw_diff: String,
    /// Optional human label for the change (commit subject, "working tree", …).
    pub title: Option<String>,
    /// Optional primary language hint.
    pub language: Option<String>,
    /// Input-side token budget for the diff. Use [`DEFAULT_MAX_INPUT_TOKENS`].
    pub max_input_tokens: usize,
}

/// Streamed progress from a review run.
#[derive(Debug, Clone)]
pub enum ReviewEvent {
    /// A chunk of assistant text (the verdict streaming in).
    Delta(String),
    /// A chunk of extended-thinking text (if the model emits it).
    Thinking(String),
    /// A non-fatal provider error message.
    Error(String),
}

/// Outcome of a completed review.
pub struct ReviewResult {
    /// Parsed structured verdict, or `None` if the model's output didn't parse
    /// (callers should then fall back to rendering `raw_text`).
    pub verdict: Option<ReviewVerdict>,
    /// Full accumulated model text (the source the verdict was parsed from).
    pub raw_text: String,
    /// Files dropped from the diff because it exceeded the token budget.
    pub omitted_files: Vec<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: Option<f64>,
}

/// Run a review, forwarding streamed text via `on_event` and returning the
/// final parsed result. Cooperatively stops when `cancel` is triggered.
pub async fn run_review<F>(
    opts: ReviewOptions,
    cancel: CancellationToken,
    on_event: F,
) -> Result<ReviewResult, String>
where
    F: Fn(ReviewEvent) + Send,
{
    if opts.raw_diff.trim().is_empty() {
        return Err("nothing to review: the diff is empty".into());
    }

    let provider = provider::build_provider(&opts.provider, &opts.api_key, &opts.model)?;
    let packed = diff::pack(&opts.raw_diff, opts.max_input_tokens);
    let user = prompt::user_prompt(opts.title.as_deref(), opts.language.as_deref(), &packed.text);

    let agent = Agent::builder()
        .provider_boxed(provider)
        // The Agent's own model drives the request; Cersei's runner falls back to
        // a hardcoded "claude-sonnet-4-6" if it's unset, which would be sent to
        // EVERY provider (e.g. 404 against Google). Setting it on the provider
        // alone is not enough — it must be set here too.
        .model(opts.model.clone())
        .tools(Vec::new()) // review-only: no filesystem/shell access
        .permission_policy(DenyAll)
        .max_turns(1)
        .system_prompt(prompt::REVIEW_SYSTEM_PROMPT)
        .cancel_token(cancel.clone())
        .build()
        .map_err(|e| e.to_string())?;
    let agent = Arc::new(agent);

    let mut stream = agent.run_stream(&user);
    let mut raw = String::new();
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut cost_usd = None;

    while let Some(ev) = stream.next().await {
        if cancel.is_cancelled() {
            break;
        }
        match ev {
            AgentEvent::TextDelta(t) => {
                raw.push_str(&t);
                on_event(ReviewEvent::Delta(t));
            }
            AgentEvent::ThinkingDelta(t) => on_event(ReviewEvent::Thinking(t)),
            AgentEvent::Complete(output) => {
                if raw.is_empty() {
                    raw.push_str(output.text());
                }
                input_tokens = output.usage.input_tokens;
                output_tokens = output.usage.output_tokens;
                cost_usd = output.usage.cost_usd;
                break;
            }
            AgentEvent::Error(e) => {
                on_event(ReviewEvent::Error(e.clone()));
                return Err(e);
            }
            _ => {}
        }
    }

    let verdict = verdict::parse(&raw);
    Ok(ReviewResult {
        verdict,
        raw_text: raw,
        omitted_files: packed.omitted,
        input_tokens,
        output_tokens,
        cost_usd,
    })
}
