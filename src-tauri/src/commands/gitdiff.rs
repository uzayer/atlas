//! Structured side-by-side git diff commands, backed by the `atlas-gitdiff`
//! engine (which vendors delta's word-diff). The frontend diff viewer + the
//! editor gutter consume these.

use atlas_gitdiff::{build_file_diff, line_status, FileDiff, LineStatus};
use std::process::Command;

/// Run `git diff` for one file and return the raw unified output. `staged`
/// selects the index-vs-HEAD diff; otherwise it's worktree-vs-HEAD. `context`
/// is the `-U` value (large → whole-file side-by-side). Falls back to
/// `--no-index` against /dev/null so brand-new / untracked files render as
/// all-added instead of an empty diff.
fn run_git_diff(path: &str, file: &str, staged: bool, context: u32) -> Result<String, String> {
    let ctx = format!("-U{context}");
    let mut args: Vec<&str> = vec!["diff", "--no-color", &ctx];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(file);

    let output = Command::new("git")
        .args(&args)
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    if !text.trim().is_empty() {
        return Ok(text);
    }

    // Empty diff. This is the COMMON case for a clean, tracked file — and it
    // genuinely means "no changes", so return empty. We must NOT fall back to
    // `--no-index` here: that would diff the file against /dev/null and report
    // EVERY line as added, which is what made the editor gutter mark all lines
    // until the first edit. Only an UNTRACKED file should render as all-added.
    if is_tracked(path, file) {
        return Ok(String::new());
    }

    // Untracked / brand-new file — diff against /dev/null so it shows as fully
    // added. `--no-index` exits non-zero by design, so ignore status; take stdout.
    let nul = devnull();
    let no_index = Command::new("git")
        .args(["diff", "--no-color", &ctx, "--no-index", "--", nul, file])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&no_index.stdout).to_string())
}

/// Whether `file` is tracked by git (in the index). `git ls-files
/// --error-unmatch` exits 0 only for tracked paths.
fn is_tracked(path: &str, file: &str) -> bool {
    Command::new("git")
        .args(["ls-files", "--error-unmatch", "--", file])
        .current_dir(path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn devnull() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

/// Lowercased file extension (drives syntax highlighting on the frontend).
fn language_of(file: &str) -> String {
    file.rsplit('/')
        .next()
        .and_then(|n| n.rsplit_once('.'))
        .map(|(_, ext)| ext.to_lowercase())
        .unwrap_or_default()
}

/// Full side-by-side diff model for one file (whole-file context).
#[tauri::command]
pub async fn git_diff_structured(
    path: String,
    file: String,
    staged: bool,
) -> Result<FileDiff, String> {
    tokio::task::spawn_blocking(move || {
        let diff = run_git_diff(&path, &file, staged, 100_000)?;
        Ok(build_file_diff(&diff, &file, &language_of(&file)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// New-file line classification for the editor gutter (added / changed /
/// deleted-before). Uses zero-context diff — cheap.
#[tauri::command]
pub async fn git_diff_line_status(
    path: String,
    file: String,
    staged: bool,
) -> Result<LineStatus, String> {
    tokio::task::spawn_blocking(move || {
        let diff = run_git_diff(&path, &file, staged, 0)?;
        let fd = build_file_diff(&diff, &file, "");
        Ok(line_status(&fd))
    })
    .await
    .map_err(|e| e.to_string())?
}
