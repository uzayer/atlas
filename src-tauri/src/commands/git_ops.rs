//! Extended git operations for the unified Source-Control manager.
//!
//! Mirrors the dugite-shaped CLI calls GitHub Desktop uses, built on the
//! same `std::process::Command` spawn pattern as `git.rs`. Every spawn sets
//! `GIT_TERMINAL_PROMPT=0` so a missing credential fails fast with a
//! readable error instead of hanging on a tty prompt (push/pull rely on the
//! user's system credential helper / ssh-agent). Mutating commands emit
//! `atlas:git-changed` via the watcher helper so the UI refreshes live.

use serde::Serialize;
use std::path::Path;
use std::process::Command;
use tauri::AppHandle;

use crate::commands::git_watcher::emit_synthetic_change;

const US: char = '\u{1f}'; // unit separator for --format parsing

/// Run git in `path`, returning stdout. Fails with trimmed stderr on a
/// non-zero exit. `GIT_TERMINAL_PROMPT=0` prevents credential hangs.
fn git_out(path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "git command failed".into()
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Run a mutating git command, then notify the watcher so listeners refresh.
fn git_mut(app: &AppHandle, path: &str, args: &[&str]) -> Result<String, String> {
    let out = git_out(path, args)?;
    emit_synthetic_change(app, Path::new(path));
    Ok(out)
}

// ── Read models ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub subject: String,
    pub date: String,
}

#[derive(Debug, Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
    pub branch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
    pub body: String,
    pub diff: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InProgress {
    pub merge: bool,
    pub rebase: bool,
    pub cherry_pick: bool,
    pub revert: bool,
}

// ── Branches ─────────────────────────────────────────────────────────────

/// Parse git's `%(upstream:track)` ("[ahead 2, behind 1]" / "[gone]") into
/// (ahead, behind).
fn parse_track(track: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    let inner = track.trim_start_matches('[').trim_end_matches(']');
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

#[tauri::command]
pub async fn git_branches_full(path: String) -> Result<Vec<BranchInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let fmt = format!(
            "%(refname:short){US}%(HEAD){US}%(upstream:short){US}%(upstream:track){US}%(contents:subject){US}%(committerdate:relative)"
        );
        let out = git_out(
            &path,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                &format!("--format={fmt}"),
                "refs/heads",
            ],
        )?;
        let branches = out
            .lines()
            .filter(|l| !l.is_empty())
            .map(|line| {
                let p: Vec<&str> = line.split(US).collect();
                let track = p.get(3).copied().unwrap_or("");
                let (ahead, behind) = parse_track(track);
                let upstream = p.get(2).copied().unwrap_or("");
                BranchInfo {
                    name: p.first().copied().unwrap_or("").to_string(),
                    is_current: p.get(1).map_or(false, |h| h.trim() == "*"),
                    upstream: if upstream.is_empty() {
                        None
                    } else {
                        Some(upstream.to_string())
                    },
                    ahead,
                    behind,
                    subject: p.get(4).copied().unwrap_or("").to_string(),
                    date: p.get(5).copied().unwrap_or("").to_string(),
                }
            })
            .collect();
        Ok(branches)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_rename_branch(
    path: String,
    old_name: String,
    new_name: String,
    app: AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["branch", "-m", &old_name, &new_name])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_branch_delete(
    path: String,
    name: String,
    force: bool,
    app: AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let flag = if force { "-D" } else { "-d" };
        git_mut(&app, &path, &["branch", flag, &name])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_merge_branch(path: String, branch: String, app: AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git_mut(&app, &path, &["merge", "--no-edit", &branch]))
        .await
        .map_err(|e| e.to_string())?
}

// ── Remote sync ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_fetch(path: String, app: AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git_mut(&app, &path, &["fetch", "--all", "--prune"]))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_pull(path: String, rebase: bool, app: AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["pull"];
        if rebase {
            args.push("--rebase");
        }
        git_mut(&app, &path, &args)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_push(
    path: String,
    force_with_lease: bool,
    follow_tags: bool,
    app: AppHandle,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["push"];
        if force_with_lease {
            args.push("--force-with-lease");
        }
        if follow_tags {
            args.push("--follow-tags");
        }
        git_mut(&app, &path, &args)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Push the current branch to `origin` and set it as upstream.
#[tauri::command]
pub async fn git_publish_branch(path: String, app: AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git_mut(&app, &path, &["push", "-u", "origin", "HEAD"]))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_remotes(path: String) -> Result<Vec<RemoteInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let out = git_out(&path, &["remote", "-v"])?;
        let mut seen = std::collections::HashSet::new();
        let mut remotes = Vec::new();
        for line in out.lines() {
            // "origin\turl (fetch)"
            let mut it = line.split_whitespace();
            let (Some(name), Some(url)) = (it.next(), it.next()) else {
                continue;
            };
            if seen.insert(name.to_string()) {
                remotes.push(RemoteInfo {
                    name: name.to_string(),
                    url: url.to_string(),
                });
            }
        }
        Ok(remotes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_remote_add(
    path: String,
    name: String,
    url: String,
    app: AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["remote", "add", &name, &url])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_remote_remove(path: String, name: String, app: AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["remote", "remove", &name])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Stash ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_stash_list(path: String) -> Result<Vec<StashEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let out = git_out(
            &path,
            &["stash", "list", &format!("--format=%gd{US}%gs")],
        )?;
        let stashes = out
            .lines()
            .filter(|l| !l.is_empty())
            .enumerate()
            .map(|(i, line)| {
                let p: Vec<&str> = line.split(US).collect();
                let gs = p.get(1).copied().unwrap_or("");
                // "WIP on main: abc1234 message" → branch = "main"
                let branch = gs
                    .strip_prefix("WIP on ")
                    .or_else(|| gs.strip_prefix("On "))
                    .and_then(|s| s.split(':').next())
                    .unwrap_or("")
                    .to_string();
                StashEntry {
                    index: i as u32,
                    message: gs.to_string(),
                    branch,
                }
            })
            .collect();
        Ok(stashes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stash_push(
    path: String,
    message: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["stash".to_string(), "push".to_string()];
        if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
            args.push("-m".into());
            args.push(m);
        }
        let argv: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git_mut(&app, &path, &argv)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stash only the given paths (e.g. a single file flagged in a review).
/// Only affects working-tree/index changes for those paths.
#[tauri::command]
pub async fn git_stash_paths(
    path: String,
    paths: Vec<String>,
    message: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("no paths to stash".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["stash".to_string(), "push".to_string()];
        if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
            args.push("-m".into());
            args.push(m);
        }
        args.push("--".into());
        args.extend(paths);
        let argv: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git_mut(&app, &path, &argv)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stash_apply(path: String, index: u32, app: AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["stash", "apply", &format!("stash@{{{index}}}")])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stash_pop(path: String, index: u32, app: AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["stash", "pop", &format!("stash@{{{index}}}")])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stash_drop(path: String, index: u32, app: AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["stash", "drop", &format!("stash@{{{index}}}")])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Working tree / history ops ───────────────────────────────────────────

/// Discard tracked changes (staged + worktree) for `files`, back to HEAD.
/// Untracked files are left alone (deleting them is destructive).
#[tauri::command]
pub async fn git_discard(path: String, files: Vec<String>, app: AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec![
            "restore".to_string(),
            "--staged".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
        ];
        args.extend(files);
        let argv: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git_mut(&app, &path, &argv)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_reset(
    path: String,
    target: String,
    mode: String,
    app: AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let flag = match mode.as_str() {
            "soft" => "--soft",
            "hard" => "--hard",
            _ => "--mixed",
        };
        git_mut(&app, &path, &["reset", flag, &target])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_revert(path: String, sha: String, app: AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // Plain revert first; merge commits need a parent (-m 1).
        match git_mut(&app, &path, &["revert", "--no-edit", &sha]) {
            Ok(o) => Ok(o),
            Err(e) if e.contains("is a merge") || e.contains("mainline") => {
                git_mut(&app, &path, &["revert", "--no-edit", "-m", "1", &sha])
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_cherry_pick(path: String, sha: String, app: AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git_mut(&app, &path, &["cherry-pick", &sha]))
        .await
        .map_err(|e| e.to_string())?
}

/// Extended commit: summary + optional description, optional `--amend`.
#[tauri::command]
pub async fn git_commit_ex(
    path: String,
    summary: String,
    description: Option<String>,
    amend: bool,
    app: AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["commit".to_string()];
        if amend {
            args.push("--amend".into());
        }
        args.push("-m".into());
        args.push(summary);
        if let Some(d) = description.filter(|d| !d.trim().is_empty()) {
            args.push("-m".into());
            args.push(d);
        }
        let argv: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git_mut(&app, &path, &argv)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_diff_staged(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git_out(&path, &["diff", "--cached"]))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_diff_unstaged(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git_out(&path, &["diff"]))
        .await
        .map_err(|e| e.to_string())?
}

// ── Tags ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_tags(path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let out = git_out(&path, &["tag", "--sort=-creatordate"])?;
        Ok(out.lines().filter(|l| !l.is_empty()).map(String::from).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_create_tag(
    path: String,
    name: String,
    target: Option<String>,
    message: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["tag".to_string(), "-a".to_string(), name];
        args.push("-m".into());
        args.push(message.unwrap_or_default());
        if let Some(t) = target.filter(|t| !t.is_empty()) {
            args.push(t);
        }
        let argv: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git_mut(&app, &path, &argv)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_delete_tag(path: String, name: String, app: AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        git_mut(&app, &path, &["tag", "-d", &name])?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Commit detail (history view) ─────────────────────────────────────────

#[tauri::command]
pub async fn git_show(path: String, sha: String) -> Result<CommitDetail, String> {
    tokio::task::spawn_blocking(move || {
        let fmt = format!("%H{US}%h{US}%an{US}%ae{US}%ad{US}%s{US}%b");
        let meta = git_out(
            &path,
            &["log", "-1", "--date=format:%Y-%m-%d %H:%M", &format!("--format={fmt}"), &sha],
        )?;
        let p: Vec<&str> = meta.trim_end().split(US).collect();
        // Diff only (empty --format suppresses the header).
        let diff = git_out(&path, &["show", "--no-color", "--format=", &sha])?;
        Ok(CommitDetail {
            hash: p.first().copied().unwrap_or("").to_string(),
            short_hash: p.get(1).copied().unwrap_or("").to_string(),
            author: p.get(2).copied().unwrap_or("").to_string(),
            email: p.get(3).copied().unwrap_or("").to_string(),
            date: p.get(4).copied().unwrap_or("").to_string(),
            subject: p.get(5).copied().unwrap_or("").to_string(),
            body: p.get(6).copied().unwrap_or("").trim().to_string(),
            diff,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── In-progress operation detection (conflict banner) ────────────────────

#[tauri::command]
pub async fn git_inprogress(path: String) -> Result<InProgress, String> {
    tokio::task::spawn_blocking(move || {
        let git_dir = git_out(&path, &["rev-parse", "--absolute-git-dir"])?
            .trim()
            .to_string();
        let exists = |p: &str| Path::new(&git_dir).join(p).exists();
        Ok(InProgress {
            merge: exists("MERGE_HEAD"),
            rebase: exists("rebase-merge") || exists("rebase-apply"),
            cherry_pick: exists("CHERRY_PICK_HEAD"),
            revert: exists("REVERT_HEAD"),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Abort or continue an in-progress merge/rebase/cherry-pick/revert.
#[tauri::command]
pub async fn git_op_control(
    path: String,
    kind: String,
    action: String, // "abort" | "continue"
    app: AppHandle,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let flag = if action == "continue" {
            "--continue"
        } else {
            "--abort"
        };
        // A merge has no `--continue`; finishing it is a no-edit commit.
        if kind == "merge" && action == "continue" {
            return git_mut(&app, &path, &["commit", "--no-edit"]);
        }
        git_mut(&app, &path, &[kind.as_str(), flag])
    })
    .await
    .map_err(|e| e.to_string())?
}
