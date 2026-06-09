//! Atlas code-review engine.
//!
//! Produces a CodeRabbit-style **report**: each changed file is reviewed by its
//! own tool-free single-turn Cersei agent (bounded concurrency), then a
//! synthesis agent produces the overall verdict + a mandatory Mermaid
//! architecture diagram. Host-agnostic: callers pass the diff + BYOK key in and
//! forward [`ReviewEvent`]s back out; the crate never touches the keystore, git,
//! or Tauri.

pub mod diff;
pub mod prompt;
pub mod provider;
pub mod report;
pub mod verdict;

use std::sync::Arc;

use cersei::prelude::{Agent, AgentEvent, DenyAll};
use futures::StreamExt;

pub use provider::{is_supported, openai_base_url, supported_providers};
pub use report::{FileVerdict, ReviewReport};
pub use tokio_util::sync::CancellationToken;
pub use verdict::{KeyIssue, ReviewVerdict};

/// Default token budget for the diff (informational; per-file truncation uses
/// [`PER_FILE_TOKEN_BUDGET`]).
pub const DEFAULT_MAX_INPUT_TOKENS: usize = 60_000;
/// Max files individually reviewed; the rest are listed as not-reviewed.
pub const MAX_FILES: usize = 40;
/// Concurrent per-file review agents (files are analyzed in parallel).
const CONCURRENCY: usize = 8;
/// Per-file diff token budget before truncation.
const PER_FILE_TOKEN_BUDGET: usize = 24_000;

/// Inputs for one review run.
pub struct ReviewOptions {
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub raw_diff: String,
    pub title: Option<String>,
    pub language: Option<String>,
    pub max_input_tokens: usize,
}

/// Streamed progress from a review run.
#[derive(Debug, Clone)]
pub enum ReviewEvent {
    /// A file's review has begun.
    FileStarted { path: String },
    /// A file's verdict is ready.
    FileDone { verdict: FileVerdict },
    /// A chunk of the synthesis summary text.
    Delta(String),
    /// Extended-thinking text (if emitted).
    Thinking(String),
    /// A non-fatal error (e.g. one file failed).
    Error(String),
}

/// Result of running one tool-free agent turn.
struct AgentRun {
    text: String,
    input_tokens: u64,
    output_tokens: u64,
    cost_usd: Option<f64>,
}

/// Run a full multi-file review report, forwarding progress via `on_event`.
pub async fn run_report(
    opts: ReviewOptions,
    cancel: CancellationToken,
    on_event: Arc<dyn Fn(ReviewEvent) + Send + Sync>,
) -> Result<ReviewReport, String> {
    if opts.raw_diff.trim().is_empty() {
        return Err("nothing to review: the diff is empty".to_string());
    }
    let patches = diff::split_files(&opts.raw_diff);
    if patches.is_empty() {
        return Err("no file changes found in the diff".to_string());
    }

    let not_reviewed: Vec<String> =
        patches.iter().skip(MAX_FILES).map(|p| p.path.clone()).collect();
    let reviewed: Vec<diff::FilePatch> = patches.into_iter().take(MAX_FILES).collect();

    let provider = opts.provider.clone();
    let model = opts.model.clone();
    let key = opts.api_key.clone();

    // ── Per-file fan-out (bounded concurrency) ───────────────────────────────
    let file_futs = reviewed.into_iter().enumerate().map(|(idx, p)| {
        let (provider, model, key) = (provider.clone(), model.clone(), key.clone());
        let cancel = cancel.clone();
        let evt = on_event.clone();
        async move {
            if cancel.is_cancelled() {
                return (idx, None);
            }
            evt(ReviewEvent::FileStarted { path: p.path.clone() });
            let body = truncate_tokens(&p.body, PER_FILE_TOKEN_BUDGET);
            let user = prompt::file_user_prompt(&p.path, &body);
            match run_agent(
                &provider,
                &model,
                &key,
                prompt::FILE_REVIEW_SYSTEM_PROMPT,
                &user,
                &cancel,
                None,
            )
            .await
            {
                Ok(r) => {
                    let verdict = report::parse_file_verdict(&r.text, &p.path);
                    evt(ReviewEvent::FileDone { verdict: verdict.clone() });
                    (idx, Some((verdict, r.input_tokens, r.output_tokens, r.cost_usd)))
                }
                Err(e) => {
                    evt(ReviewEvent::Error(format!("{}: {e}", p.path)));
                    (idx, None)
                }
            }
        }
    });

    let mut results: Vec<(usize, Option<(FileVerdict, u64, u64, Option<f64>)>)> =
        futures::stream::iter(file_futs)
            .buffer_unordered(CONCURRENCY)
            .collect()
            .await;
    if cancel.is_cancelled() {
        return Err("cancelled".to_string());
    }
    results.sort_by_key(|(i, _)| *i);

    let mut files = Vec::new();
    let (mut in_tok, mut out_tok, mut cost, mut any_cost) = (0u64, 0u64, 0f64, false);
    for (_, r) in results {
        if let Some((v, it, ot, c)) = r {
            in_tok += it;
            out_tok += ot;
            if let Some(c) = c {
                cost += c;
                any_cost = true;
            }
            files.push(v);
        }
    }

    // ── Synthesis pass (overall verdict + mandatory diagram) ─────────────────
    let file_lines = files
        .iter()
        .map(|f| {
            format!(
                "- {} [risk: {}]: {} (issues: {})",
                f.path,
                f.risk,
                f.summary,
                f.key_issues.len()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let synth_user = prompt::synthesis_user_prompt(&file_lines, &not_reviewed);

    let evt = on_event.clone();
    let on_delta = move |t: String| evt(ReviewEvent::Delta(t));
    let synth = run_agent(
        &provider,
        &model,
        &key,
        prompt::SYNTHESIS_SYSTEM_PROMPT,
        &synth_user,
        &cancel,
        Some(&on_delta),
    )
    .await?;
    in_tok += synth.input_tokens;
    out_tok += synth.output_tokens;
    if let Some(c) = synth.cost_usd {
        cost += c;
        any_cost = true;
    }
    let mut synthesis = report::parse_synthesis(&synth.text);

    // The diagram is mandatory: one stricter retry if it came back empty.
    if synthesis.architecture_mermaid.trim().is_empty() && !cancel.is_cancelled() {
        let retry_user = format!("{synth_user}{}", prompt::SYNTHESIS_RETRY_SUFFIX);
        if let Ok(r2) = run_agent(
            &provider,
            &model,
            &key,
            prompt::SYNTHESIS_SYSTEM_PROMPT,
            &retry_user,
            &cancel,
            None,
        )
        .await
        {
            in_tok += r2.input_tokens;
            out_tok += r2.output_tokens;
            if let Some(c) = r2.cost_usd {
                cost += c;
                any_cost = true;
            }
            let retry = report::parse_synthesis(&r2.text);
            if !retry.architecture_mermaid.trim().is_empty() {
                synthesis = retry;
            }
        }
    }

    Ok(ReviewReport {
        summary: synthesis.summary,
        architecture_mermaid: sanitize_mermaid(&synthesis.architecture_mermaid),
        score: synthesis.score,
        estimated_effort_to_review: synthesis.estimated_effort_to_review,
        security_concerns: synthesis.security_concerns,
        relevant_tests: synthesis.relevant_tests,
        files,
        not_reviewed,
        input_tokens: in_tok,
        output_tokens: out_tok,
        cost_usd: if any_cost { Some(cost) } else { None },
    })
}

/// Run one tool-free, single-turn agent and collect its text + usage.
async fn run_agent(
    provider_id: &str,
    model: &str,
    api_key: &str,
    system: &str,
    user: &str,
    cancel: &CancellationToken,
    on_delta: Option<&(dyn Fn(String) + Send + Sync)>,
) -> Result<AgentRun, String> {
    let provider = provider::build_provider(provider_id, api_key, model)?;
    let agent = Agent::builder()
        .provider_boxed(provider)
        // Must set the model on the AGENT (Cersei's runner defaults to a
        // hardcoded "claude-sonnet-4-6" otherwise — see the v1 fix).
        .model(model.to_string())
        .tools(Vec::new())
        .permission_policy(DenyAll)
        .max_turns(1)
        .system_prompt(system.to_string())
        .cancel_token(cancel.clone())
        .build()
        .map_err(|e| e.to_string())?;
    let agent = Arc::new(agent);

    let mut stream = agent.run_stream(user);
    let mut text = String::new();
    let (mut it, mut ot, mut cost) = (0u64, 0u64, None);
    while let Some(ev) = stream.next().await {
        if cancel.is_cancelled() {
            break;
        }
        match ev {
            AgentEvent::TextDelta(t) => {
                if let Some(cb) = on_delta {
                    cb(t.clone());
                }
                text.push_str(&t);
            }
            AgentEvent::Complete(out) => {
                if text.is_empty() {
                    text.push_str(out.text());
                }
                it = out.usage.input_tokens;
                ot = out.usage.output_tokens;
                cost = out.usage.cost_usd;
                break;
            }
            AgentEvent::Error(e) => return Err(e),
            _ => {}
        }
    }
    Ok(AgentRun { text, input_tokens: it, output_tokens: ot, cost_usd: cost })
}

/// Truncate a file's diff to a token budget (rough chars/4), with a marker.
fn truncate_tokens(s: &str, budget_tokens: usize) -> String {
    if diff::estimate_tokens(s) <= budget_tokens {
        return s.to_string();
    }
    let max_chars = budget_tokens * 4;
    let mut out: String = s.chars().take(max_chars).collect();
    out.push_str("\n… [file diff truncated for length] …\n");
    out
}

/// Strip any ``` fences the model wrapped the mermaid source in, despite the
/// instruction to return raw source.
fn sanitize_mermaid(s: &str) -> String {
    let mut t = s.trim();
    if let Some(rest) = t.strip_prefix("```mermaid") {
        t = rest;
    } else if let Some(rest) = t.strip_prefix("```") {
        t = rest;
    }
    t = t.trim_start();
    if let Some(rest) = t.strip_suffix("```") {
        t = rest;
    }
    t.trim().to_string()
}
