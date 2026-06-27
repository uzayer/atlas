//! Atlas-owned coding tools — a from-scratch reimplementation of the basic
//! file/shell tools, modeled on opencode (MIT), so they work reliably across
//! every BYOK model. See `plans/atlas-cersei-tools-from-scratch.md` and
//! `ATTRIBUTION.md`.
//!
//! [`atlas_coding`] is the single seam: an explicit, hand-built tool vector used
//! for both the main turn and delegate sub-agents. Building it by hand (rather
//! than filtering `cersei::tools::coding()`) keeps every tool swap a one-line
//! change and avoids name-filter fragility.

pub mod coerce;
pub mod cwd;
pub mod errors;
pub mod replace;
pub mod truncate;

use cersei::tools::Tool;

use cwd::CwdTool;

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
        // ── Atlas-owned basic tools ──────────────────────────────────────
        // (filled in over Steps 3–7; today these delegate to the SDK tools,
        // CwdTool-wrapped exactly as the old `cwd_tool::wrap_file_tools` did.)
        CwdTool::wrap(Box::new(t::file_read::FileReadTool)),
        CwdTool::wrap(Box::new(t::file_write::FileWriteTool)),
        CwdTool::wrap(Box::new(t::file_edit::FileEditTool)),
        Box::new(t::grep_tool::GrepTool),
        Box::new(t::glob_tool::GlobTool),
        Box::new(t::bash::BashTool),
        // ── Retained SDK tools (not reimplemented) ───────────────────────
        Box::new(t::apply_patch::ApplyPatchTool),
        Box::new(t::code_search::CodeSearchTool::new()),
        Box::new(t::web_fetch::WebFetchTool),
        Box::new(t::web_search::WebSearchTool),
        Box::new(t::exa_search::ExaSearchTool),
        Box::new(t::powershell::PowerShellTool),
        // NotebookEdit reads via a bare path — must stay cwd-wrapped.
        CwdTool::wrap(Box::new(t::notebook_edit::NotebookEditTool)),
    ]
}
