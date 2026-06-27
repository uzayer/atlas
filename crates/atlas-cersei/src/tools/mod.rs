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
pub mod glob;
pub mod grep;
pub mod list;
pub mod read;
pub mod replace;
pub mod truncate;
pub mod write;

use std::path::PathBuf;

use cersei::tools::Tool;

use cwd::CwdTool;

/// Hard-error returned when ripgrep is not available (no silent literal fallback —
/// a degraded substring search would return *wrong* results for real regexes).
pub(crate) const RG_MISSING: &str =
    "ripgrep (`rg`) was not found on PATH. Grep/Glob/List require ripgrep; install it \
     (e.g. `brew install ripgrep`) or ensure it is bundled with the app.";

/// Run ripgrep with `args` inside `cwd` on a blocking thread. Returns stdout on
/// success, or a hard error if `rg` is missing or fails. rg exit code 1 means
/// "no matches" (success with empty output); exit code 2 is a real error.
pub(crate) async fn run_rg(args: Vec<String>, cwd: PathBuf) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        match std::process::Command::new("rg")
            .args(&args)
            .current_dir(&cwd)
            .output()
        {
            Ok(o) => {
                if o.status.code() == Some(2) {
                    return Err(format!(
                        "ripgrep failed: {}",
                        String::from_utf8_lossy(&o.stderr).trim()
                    ));
                }
                Ok(String::from_utf8_lossy(&o.stdout).into_owned())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(RG_MISSING.to_string()),
            Err(e) => Err(format!("failed to run ripgrep: {e}")),
        }
    })
    .await
    .unwrap_or_else(|e| Err(format!("ripgrep task panicked: {e}")))
}

/// The coding toolset handed to the Cersei agent (main turn + delegate factory).
///
/// Atlas-owned: `Read / Write / Edit / Grep / Glob / List / Bash` resolve cwd
/// internally, so they need no wrapper. Retained SDK tools cover the surface
/// Atlas does not reimplement; `NotebookEdit` ignores `ctx.working_dir` and so
/// stays `CwdTool`-wrapped (`ApplyPatch` already joins `working_dir`, so it is
/// safe raw).
pub fn atlas_coding() -> Vec<Box<dyn Tool>> {
    use cersei::tools as t;
    vec![
        // ── Atlas-owned basic tools (resolve cwd internally — no wrapper) ─
        Box::new(read::ReadTool),
        Box::new(write::WriteTool),
        Box::new(edit::EditTool),
        Box::new(grep::GrepTool),
        Box::new(glob::GlobTool),
        Box::new(list::ListTool),
        Box::new(bash::BashTool),
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
