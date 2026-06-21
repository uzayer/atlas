//! Shared Cross-Agent Memory (v2) — injection (read/push path).
//!
//! Builds the per-turn `--- SHARED MEMORY ---` block that `agents_send`
//! prepends to a user message. Gated by a **per-session sync clock** (the last
//! event `seq` that session has already seen, tracked in
//! [`super::memory_sharing::MemorySharingState`]):
//! - **First sync** (`since_seq == 0`): the session inherits the *current*
//!   shared state — active plan + recent decisions/changes/facts.
//! - **Later turns** (`since_seq > 0`): only the **delta** — what other agents
//!   recorded since this session last looked. Empty ⇒ nothing injected.
//!
//! This is what makes the feature continuous and bidirectional, replacing v1's
//! first-send-only one-directional handoff.

use super::shared_memory::{SharedMemoryStore, SharedState};

/// Char budget for the composed block body (≈ a few hundred tokens).
const BLOCK_MAX_CHARS: usize = 1600;
/// Max line items per section.
const MAX_ITEMS: usize = 8;

/// Read the current view and compose the block for a session at `since_seq`.
/// Returns `None` when there is nothing new to say.
pub fn build_shared_block(
    store: &SharedMemoryStore,
    project_path: &str,
    since_seq: u64,
) -> Option<String> {
    compose_shared_block(&store.get_state(project_path), since_seq)
}

/// Pure composer (unit-testable). `since_seq == 0` = first sync (full current
/// state); otherwise only entries with `seq > since_seq`.
pub fn compose_shared_block(state: &SharedState, since_seq: u64) -> Option<String> {
    let first = since_seq == 0;
    let mut sections: Vec<String> = Vec::new();

    if let Some(plan) = &state.active_plan {
        if first || plan.seq > since_seq {
            sections.push(format!("[ACTIVE PLAN] (by {})\n{}", plan.agent, plan.text));
        }
    }

    let decisions: Vec<String> = state
        .decisions
        .iter()
        .filter(|d| first || d.seq > since_seq)
        .rev()
        .take(MAX_ITEMS)
        .map(|d| format!("- {} (by {})", d.text, d.agent))
        .collect();
    if !decisions.is_empty() {
        sections.push(format!("[DECISIONS]\n{}", decisions.join("\n")));
    }

    let changes: Vec<String> = state
        .recent_changes
        .iter()
        .filter(|c| first || c.seq > since_seq)
        .rev()
        .take(MAX_ITEMS)
        .map(|c| {
            if c.summary.is_empty() {
                format!("- {} (by {})", c.path, c.agent)
            } else {
                format!("- {} — {} (by {})", c.path, c.summary, c.agent)
            }
        })
        .collect();
    if !changes.is_empty() {
        sections.push(format!("[FILES CHANGED]\n{}", changes.join("\n")));
    }

    // Failures / anti-patterns — high-value as deltas so a second agent never
    // repeats a dead end the moment it's recorded.
    let failures: Vec<String> = state
        .failures
        .iter()
        .filter(|f| first || f.seq > since_seq)
        .rev()
        .take(MAX_ITEMS)
        .map(|f| format!("- {} (by {})", f.text, f.agent))
        .collect();
    if !failures.is_empty() {
        sections.push(format!("[FAILURES / AVOID]\n{}", failures.join("\n")));
    }

    let architecture: Vec<String> = state
        .architecture
        .iter()
        .filter(|a| first || a.seq > since_seq)
        .rev()
        .take(MAX_ITEMS)
        .map(|a| format!("- {} (by {})", a.text, a.agent))
        .collect();
    if !architecture.is_empty() {
        sections.push(format!("[ARCHITECTURE]\n{}", architecture.join("\n")));
    }

    // Facts are durable context — surface them only on first sync to avoid
    // re-injecting standing facts every turn.
    if first {
        let facts: Vec<String> = state
            .facts
            .iter()
            .rev()
            .take(MAX_ITEMS)
            .map(|f| format!("- {} (by {})", f.text, f.agent))
            .collect();
        if !facts.is_empty() {
            sections.push(format!("[FACTS]\n{}", facts.join("\n")));
        }
    }

    if sections.is_empty() {
        return None;
    }

    let label = if first {
        "SHARED MEMORY"
    } else {
        "SHARED MEMORY — UPDATES SINCE LAST TURN"
    };
    let body = truncate_chars(&sections.join("\n\n"), BLOCK_MAX_CHARS);
    Some(format!("--- {label} ---\n{body}\n--- END SHARED MEMORY ---"))
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::super::shared_memory::{DecisionView, PlanView};
    use super::*;

    fn state_with_plan() -> SharedState {
        SharedState {
            last_seq: 3,
            active_plan: Some(PlanView {
                seq: 1,
                agent: "claude-code".into(),
                text: "Migrate auth to JWT".into(),
                status: "active".into(),
            }),
            decisions: vec![DecisionView {
                seq: 3,
                agent: "codex".into(),
                key: "auth.alg".into(),
                text: "Use RS256".into(),
            }],
            ..Default::default()
        }
    }

    #[test]
    fn first_sync_includes_plan_and_decisions() {
        let block = compose_shared_block(&state_with_plan(), 0).unwrap();
        assert!(block.contains("--- SHARED MEMORY ---"));
        assert!(block.contains("Migrate auth to JWT"));
        assert!(block.contains("Use RS256"));
    }

    #[test]
    fn delta_sync_only_new_entries() {
        // Session already saw up to seq 1 (the plan). Only the seq-3 decision is new.
        let block = compose_shared_block(&state_with_plan(), 1).unwrap();
        assert!(block.contains("UPDATES SINCE LAST TURN"));
        assert!(block.contains("Use RS256"));
        assert!(!block.contains("Migrate auth to JWT"));
    }

    #[test]
    fn nothing_new_returns_none() {
        assert!(compose_shared_block(&state_with_plan(), 3).is_none());
    }

    #[test]
    fn empty_state_returns_none() {
        assert!(compose_shared_block(&SharedState::default(), 0).is_none());
    }
}
