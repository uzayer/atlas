//! Plugin descriptors. Each describes a spawnable agent and how Atlas should
//! treat its persistent transcripts.
//!
//! v1 wraps `atlas_acp::AgentRegistry::known_specs()` — the underlying process
//! commands still live in atlas-acp. atlas-agents adds metadata (transcript
//! kind, capability flags) and the manager surface above it. New plugins
//! (codex, opencode) plug in by adding entries to both lists.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSpec {
    /// Identifier matching `atlas_acp::AgentSpec::spec_id`.
    pub plugin_id: String,
    pub display_name: String,
    /// Shell-words–parseable command. Informational; spawning goes through
    /// atlas-acp which already owns the command.
    pub command: String,
    pub transcript: TranscriptKind,
    /// Whether the agent supports `session/set_mode`.
    pub supports_modes: bool,
    /// Whether the agent supports `session/set_model` style notifications.
    pub supports_models: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TranscriptKind {
    /// No on-disk transcript — sessions are in-memory only and die with the process.
    None,
    /// Canonical Claude Code JSONL at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
    ClaudeJsonl,
}

/// Built-in plugin catalog. Add new entries here to make them selectable in
/// the UI; ensure the matching `atlas_acp::AgentSpec` exists too.
pub fn builtin_plugins() -> Vec<PluginSpec> {
    atlas_acp::AgentRegistry::known_specs()
        .into_iter()
        .map(|s| PluginSpec {
            plugin_id: s.spec_id.clone(),
            display_name: s.display_name.clone(),
            command: s.command.clone(),
            transcript: classify_transcript(&s.spec_id),
            supports_modes: true,
            supports_models: true,
        })
        .collect()
}

pub fn find_plugin(plugin_id: &str) -> Option<PluginSpec> {
    builtin_plugins().into_iter().find(|p| p.plugin_id == plugin_id)
}

fn classify_transcript(spec_id: &str) -> TranscriptKind {
    if spec_id.starts_with("claude") {
        TranscriptKind::ClaudeJsonl
    } else {
        TranscriptKind::None
    }
}
