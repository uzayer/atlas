//! Atlas-owned coding tools — a from-scratch reimplementation of the basic
//! file/shell tools, modeled on opencode (MIT), so they work reliably across
//! every BYOK model. See `plans/atlas-cersei-tools-from-scratch.md` and
//! `ATTRIBUTION.md`.
//!
//! [`atlas_coding`] is the single seam: an explicit, hand-built tool vector used
//! for both the main turn and delegate sub-agents. Building it by hand (rather
//! than filtering `cersei::tools::coding()`) keeps every tool swap a one-line
//! change and avoids name-filter fragility.

pub mod bash;
pub mod coerce;
pub mod cwd;
pub mod edit;
pub mod errors;
pub mod list;
pub mod read;
pub mod replace;
pub mod skill;
pub mod truncate;

use cersei::tools::Tool;

use cwd::CwdTool;

/// The coding toolset handed to the Cersei agent (main turn + delegate factory).
///
/// Atlas-owned: `Read / Edit / List / Bash` resolve cwd internally, so they need
/// no wrapper — each is kept only because it's PROVEN more capable than the SDK
/// equivalent (tests/sdk_native_capability.rs). `Grep` + `Glob` are the SDK's
/// native in-process tools (rg-free since 0.2.5); `Write` + `MultiEdit` +
/// `NotebookEdit` are SDK tools that ignore `ctx.working_dir`, so they stay
/// `CwdTool`-wrapped. `ApplyPatch` already joins `working_dir`, so it is raw.
/// As the SDK closes its gaps, the Atlas-owned set shrinks (Grep/Glob/Write
/// already handed off).
pub fn atlas_coding() -> Vec<Box<dyn Tool>> {
    atlas_coding_with(None)
}

/// Like [`atlas_coding`], but with the turn's cancel token injected into the
/// tools that manage their own subprocesses (Bash), so Stop kills the process
/// group instead of letting the command run to completion after cancel.
pub fn atlas_coding_with(
    cancel: Option<tokio_util::sync::CancellationToken>,
) -> Vec<Box<dyn Tool>> {
    use cersei::tools as t;
    vec![
        // ── Atlas-owned basic tools (resolve cwd internally — no wrapper) ─
        // Kept because each is PROVEN more capable than the SDK's same-named
        // tool (see tests/sdk_native_capability.rs): Read adds line-numbered
        // output + did-you-mean + binary detection; Edit adds 2 replacer
        // strategies (EscapeNormalized + TrimmedBoundary) the SDK's 5 miss.
        Box::new(read::ReadTool),
        Box::new(edit::EditTool),
        // Write was a pure duplicate (SDK FileWriteTool is fully capable —
        // creates parent dirs, same fields), so we hand it off to cersei. It
        // ignores `ctx.working_dir`, so cwd-wrap it like MultiEdit/NotebookEdit.
        CwdTool::wrap(Box::new(t::file_write::FileWriteTool)),
        // Native cersei `MultiEdit` (added in SDK 0.2.4): apply several string
        // replacements to one file atomically (all-or-nothing). Atlas keeps its
        // own 9-strategy `Edit` (broader fuzzy coverage than the SDK's 5-tier
        // ladder), but has no MultiEdit of its own, so adopt the native one.
        // It resolves a bare `file_path` and ignores `ctx.working_dir`, so it
        // must stay cwd-wrapped (same as NotebookEdit).
        CwdTool::wrap(Box::new(cersei::tools::multi_edit::MultiEditTool)),
        // Native cersei `Grep` + `Glob` (in-process since SDK 0.2.5 — ripgrep's
        // `ignore`/`grep` library crates, no external `rg` binary). This is the
        // fix for the recurring "model shells out to ripgrep and fails on stock
        // machines" issue: the tools work identically everywhere, and Grep's
        // own description steers the model to call it instead of running `rg` in
        // Bash. Both honor `ctx.working_dir`, so no cwd wrapper is needed.
        Box::new(t::grep_tool::GrepTool),
        Box::new(t::glob_tool::GlobTool),
        // `List` stays Atlas-owned (no SDK equivalent) but is now also rg-free —
        // it walks via the `ignore` crate directly. cwd-aware internally.
        Box::new(list::ListTool),
        Box::new(bash::BashTool { cancel }),
        // ── Retained SDK tools (not reimplemented) ───────────────────────
        Box::new(t::web_fetch::WebFetchTool),
        Box::new(t::web_search::WebSearchTool),
        Box::new(t::exa_search::ExaSearchTool),
        Box::new(t::apply_patch::ApplyPatchTool), // already joins working_dir — safe raw
        Box::new(t::code_search::CodeSearchTool::new()),
        Box::new(t::powershell::PowerShellTool), // retained for Windows
        // NotebookEdit reads via a bare path — must stay cwd-wrapped.
        CwdTool::wrap(Box::new(t::notebook_edit::NotebookEditTool)),
    ]
}

/// Minimal self-cleaning temp dir for tests (avoids a `tempfile` dev-dep).
#[cfg(test)]
pub(crate) struct TmpDir(pub std::path::PathBuf);

#[cfg(test)]
impl TmpDir {
    pub fn new() -> Self {
        let p = std::env::temp_dir().join(format!("atlas-cersei-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        TmpDir(p)
    }
    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
}

#[cfg(test)]
impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
pub(crate) fn test_ctx(working_dir: std::path::PathBuf) -> cersei::tools::ToolContext {
    use std::sync::Arc;
    cersei::tools::ToolContext {
        working_dir,
        session_id: "test-session".into(),
        permissions: Arc::new(cersei::tools::permissions::AllowAll),
        cost_tracker: Arc::new(cersei::tools::CostTracker::new()),
        mcp_manager: None,
        extensions: cersei::tools::Extensions::default(),
    }
}
