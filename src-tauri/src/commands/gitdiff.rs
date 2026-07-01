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
fn run_git_diff(
    path: &str,
    file: &str,
    staged: bool,
    context: u32,
    commit: Option<&str>,
) -> Result<String, String> {
    let ctx = format!("-U{context}");
    // Commit mode: the diff INTRODUCED by `commit` for this file. `git show`
    // diffs the commit against its parent (and against the empty tree for the
    // root commit), so it works uniformly.
    if let Some(sha) = commit {
        let output = Command::new("git")
            .args(["show", "--no-color", &ctx, "--format=", sha, "--", file])
            .current_dir(path)
            .output()
            .map_err(|e| e.to_string())?;
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
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
    commit: Option<String>,
) -> Result<FileDiff, String> {
    tokio::task::spawn_blocking(move || {
        let diff = run_git_diff(&path, &file, staged, 100_000, commit.as_deref())?;
        Ok(build_file_diff(&diff, &file, &language_of(&file)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Serde-friendly changed-file entry (path + porcelain status letter).
#[derive(serde::Serialize)]
pub struct CommitFile {
    pub path: String,
    pub status: String,
}

/// Files changed by a single commit (name + status), for the diff viewer's
/// commit-browsing tree. `git show --name-status` against the commit.
#[tauri::command]
pub async fn git_commit_changed_files(
    path: String,
    sha: String,
) -> Result<Vec<CommitFile>, String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("git")
            .args(["show", "--no-color", "--name-status", "--format=", &sha])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&output.stdout);
        let mut out = Vec::new();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let mut parts = line.split('\t');
            let status = parts.next().unwrap_or("").to_string();
            // Renames are `R100\told\tnew` — take the last field (new path).
            let file = parts.last().unwrap_or("").to_string();
            if !file.is_empty() {
                out.push(CommitFile { path: file, status });
            }
        }
        Ok(out)
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
        let diff = run_git_diff(&path, &file, staged, 0, None)?;
        let fd = build_file_diff(&diff, &file, "");
        Ok(line_status(&fd))
    })
    .await
    .map_err(|e| e.to_string())?
}
