//! Per-turn project context for the native agent's system prompt.
//!
//! `cersei_agent::system_prompt::build_system_prompt` renders structured context
//! sections (git status, cwd, project docs) when given a `SystemPromptOptions`.
//! This module gathers that context for a working directory — a git snapshot
//! (branch / recent commits / dirty files / user) and the project's AGENTS.md /
//! CLAUDE.md — so the agent is grounded in the repo it's actually editing
//! instead of running off a static prompt.
//!
//! Kept self-contained (git CLI + fs) so `atlas-cersei` stays a low crate with
//! no dependency on the Tauri app layer.

use std::path::Path;
use std::process::Command;

use cersei_agent::system_prompt::GitSnapshot;

/// Run `git` in `cwd` and return trimmed stdout, or `None` on any failure / non-zero exit.
fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).current_dir(cwd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Build a git snapshot for `cwd`, or `None` when it isn't a git repo.
pub fn git_snapshot(cwd: &str) -> Option<GitSnapshot> {
    // Cheap repo gate first — avoids four subprocesses on non-repos.
    let inside = git(cwd, &["rev-parse", "--is-inside-work-tree"])?;
    if inside != "true" {
        return None;
    }

    let branch = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|| "HEAD".into());

    let recent_commits = git(cwd, &["log", "-n", "10", "--pretty=format:%h %s"])
        .map(|s| s.lines().map(|l| l.to_string()).collect())
        .unwrap_or_default();

    // Cap the dirty-file list so a huge working tree can't bloat the prompt.
    let status_lines = git(cwd, &["status", "--short"])
        .map(|s| s.lines().take(40).map(|l| l.to_string()).collect())
        .unwrap_or_default();

    let user = git(cwd, &["config", "user.name"]).filter(|s| !s.is_empty());

    Some(GitSnapshot {
        branch,
        recent_commits,
        status_lines,
        user,
    })
}

/// Read the project's agent docs (`AGENTS.md`, `CLAUDE.md`) from `cwd`, if any,
/// concatenated with a header per file. Empty string when none exist. Capped so
/// an oversized doc can't dominate the context window.
pub fn project_docs(cwd: &str) -> String {
    const MAX_PER_DOC: usize = 8_000;
    let mut out = String::new();
    for name in ["AGENTS.md", "CLAUDE.md"] {
        let path = Path::new(cwd).join(name);
        if let Ok(body) = std::fs::read_to_string(&path) {
            let body = body.trim();
            if body.is_empty() {
                continue;
            }
            let clipped: String = body.chars().take(MAX_PER_DOC).collect();
            out.push_str(&format!("## {name}\n{clipped}\n\n"));
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_repo_has_no_snapshot() {
        let dir = std::env::temp_dir().join(format!("atlas-ctx-nonrepo-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // A fresh temp dir is not a git work tree.
        assert!(git_snapshot(dir.to_str().unwrap()).is_none());
    }

    #[test]
    fn reads_project_docs() {
        let dir = std::env::temp_dir().join(format!("atlas-ctx-docs-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("AGENTS.md"), "Use 4-space indent.").unwrap();
        let docs = project_docs(dir.to_str().unwrap());
        assert!(docs.contains("## AGENTS.md"));
        assert!(docs.contains("4-space indent"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_of_this_repo() {
        // The crate lives in a git repo; snapshot should resolve a branch.
        if let Some(snap) = git_snapshot(env!("CARGO_MANIFEST_DIR")) {
            assert!(!snap.branch.is_empty());
        }
    }
}
