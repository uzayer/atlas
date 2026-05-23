//! `compose_prompt` — turn (user prose, list of @-mentions) into the
//! final wire string sent to the agent.
//!
//! Used to live in `src/features/chat/lib/mentions.ts::composePrompt`:
//! N sequential `invoke("read_file_content")` calls (one IPC per
//! mention) + JS string assembly. For a message with 5 mentions
//! that's 5 round-trips JS → Tauri → file read → IPC → JS before the
//! agent even sees the prompt.
//!
//! Now: one Tauri command. File reads fan out in parallel on the
//! tokio blocking pool, the wire string is assembled in Rust, the
//! frontend just ships `(prose, mentions[])` and awaits the composed
//! result. Net IPC roundtrips per send: 1 (was N+1).

use std::path::Path;

use serde::Deserialize;

/// Cap how much body content a single mention can dump into the
/// context block. Tuned for chat agents: ~32 KB is enough for a
/// medium source file.
const MENTION_BODY_BUDGET_BYTES: usize = 32 * 1024;

/// Discriminated mention spec — mirrors the TS `MentionData` union
/// in `src/features/chat/lib/mentions.ts`. `kind` is the tag; field
/// names use camelCase on the wire (TS source of truth). Fields the
/// Rust side doesn't need (e.g. branch metadata, paper authors that
/// only display) are still accepted but ignored where appropriate.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[allow(dead_code)]
pub enum MentionSpec {
    File {
        id: String,
        display_name: String,
        abs_path: String,
    },
    Folder {
        id: String,
        display_name: String,
        abs_path: String,
    },
    Symbol {
        id: String,
        display_name: String,
        signature: String,
        symbol_kind: String,
        file_path: String,
        line: u32,
    },
    Knowledge {
        id: String,
        display_name: String,
        file_path: String,
        /// The frontend already has the entry body in the knowledge
        /// store; passing it here avoids a redundant disk read. When
        /// absent we fall back to reading `file_path`.
        #[serde(default)]
        inline_body: Option<String>,
    },
    Repo {
        id: String,
        display_name: String,
        abs_path: String,
        has_readme: bool,
    },
    Paper {
        id: String,
        display_name: String,
        authors: Vec<String>,
        metadata_path: String,
    },
    Branch {
        id: String,
        display_name: String,
    },
    PastMessage {
        id: String,
        display_name: String,
        session_title: String,
        content: String,
    },
}

impl MentionSpec {
    fn id(&self) -> &str {
        match self {
            MentionSpec::File { id, .. }
            | MentionSpec::Folder { id, .. }
            | MentionSpec::Symbol { id, .. }
            | MentionSpec::Knowledge { id, .. }
            | MentionSpec::Repo { id, .. }
            | MentionSpec::Paper { id, .. }
            | MentionSpec::Branch { id, .. }
            | MentionSpec::PastMessage { id, .. } => id,
        }
    }

    fn short_form(&self) -> String {
        match self {
            MentionSpec::File { display_name, .. } => format!("@file:{display_name}"),
            MentionSpec::Folder { display_name, .. } => format!("@folder:{display_name}"),
            MentionSpec::Symbol { display_name, .. } => format!("@symbol:{display_name}"),
            MentionSpec::Knowledge { id, .. } => format!("@note:{id}"),
            MentionSpec::Repo { display_name, .. } => format!("@repo:{display_name}"),
            MentionSpec::Paper { display_name, .. } => format!("@paper:{display_name}"),
            MentionSpec::Branch { display_name, .. } => format!("@branch:{display_name}"),
            MentionSpec::PastMessage { id, .. } => format!("@msg:{id}"),
        }
    }
}

#[tauri::command]
pub async fn compose_prompt(
    prose: String,
    mentions: Vec<MentionSpec>,
) -> Result<String, String> {
    if mentions.is_empty() {
        return Ok(prose);
    }

    // Dedupe by id preserving first-seen order — a user can reference
    // the same file twice in one message but the context block should
    // only carry it once.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let uniq: Vec<MentionSpec> = mentions
        .into_iter()
        .filter(|m| seen.insert(m.id().to_string()))
        .collect();

    // Fan out body fetches in parallel. Each spawn_blocking is one
    // task on tokio's blocking pool; the join_all waits for all of
    // them. Branches have no body so they short-circuit without
    // spawning.
    let futures = uniq.into_iter().map(|m| async move {
        tokio::task::spawn_blocking(move || render_block(&m))
            .await
            .unwrap_or_else(|e| Some(format!("(spawn failed: {e})")))
    });
    let blocks: Vec<Option<String>> = futures::future::join_all(futures).await;
    let present: Vec<String> = blocks.into_iter().flatten().collect();
    if present.is_empty() {
        return Ok(prose);
    }

    Ok(format!(
        "{prose}\n\n---\n# Atlas context\n\n{joined}\n",
        joined = present.join("\n\n")
    ))
}

/// Synchronous body renderer for a single mention. Runs on the
/// blocking pool. Returns `None` for mentions that don't contribute
/// a body block (only branches today — the short form alone is the
/// payload).
fn render_block(m: &MentionSpec) -> Option<String> {
    match m {
        MentionSpec::File { abs_path, .. } => {
            let body = match std::fs::read_to_string(abs_path) {
                Ok(s) => clip_body(&s),
                Err(e) => format!("(failed to read: {e})"),
            };
            Some(format!("## {sf}\n\n```\n{body}\n```", sf = m.short_form()))
        }
        MentionSpec::Folder { abs_path, .. } => Some(format!(
            "## {sf}\n\nDirectory at `{abs_path}`. Use your filesystem tools to explore.",
            sf = m.short_form()
        )),
        MentionSpec::Repo {
            abs_path,
            display_name,
            has_readme,
            ..
        } => {
            let body = if *has_readme {
                read_repo_readme_body(abs_path, display_name)
                    .unwrap_or_else(|| "(README present but unreadable)".to_string())
            } else {
                "(no README in this repo)".to_string()
            };
            Some(format!(
                "## {sf}\n\nCloned at `{abs_path}`.\n\n{body}",
                sf = m.short_form(),
                body = clip_body(&body),
            ))
        }
        MentionSpec::Knowledge {
            file_path,
            inline_body,
            ..
        } => {
            let body = match inline_body.as_deref() {
                Some(b) if !b.is_empty() => b.to_string(),
                _ => std::fs::read_to_string(file_path)
                    .unwrap_or_else(|_| "(unable to read knowledge entry)".to_string()),
            };
            Some(format!(
                "## {sf}\n\n{body}",
                sf = m.short_form(),
                body = clip_body(&body),
            ))
        }
        MentionSpec::Paper {
            authors,
            metadata_path,
            ..
        } => {
            let body = std::fs::read_to_string(metadata_path)
                .unwrap_or_else(|_| "(unable to read paper metadata)".to_string());
            let authors_line = if authors.is_empty() {
                String::new()
            } else {
                format!("Authors: {}\n\n", authors.join(", "))
            };
            Some(format!(
                "## {sf}\n\n{authors_line}{body}",
                sf = m.short_form(),
                body = clip_body(&body),
            ))
        }
        MentionSpec::Symbol {
            signature,
            symbol_kind,
            file_path,
            line,
            ..
        } => Some(format!(
            "## {sf}\n\n{signature}\n\n_({symbol_kind} at {file_path}:{line})_",
            sf = m.short_form(),
        )),
        MentionSpec::PastMessage {
            session_title,
            content,
            ..
        } => Some(format!(
            "## {sf} _(from session {session_title})_\n\n{body}",
            sf = m.short_form(),
            body = clip_body(content),
        )),
        MentionSpec::Branch { .. } => None,
    }
}

fn clip_body(body: &str) -> String {
    if body.len() <= MENTION_BODY_BUDGET_BYTES {
        return body.to_string();
    }
    let head = &body[..MENTION_BODY_BUDGET_BYTES];
    let elided = body.len() - MENTION_BODY_BUDGET_BYTES;
    format!("{head}\n\n… (truncated, {elided} bytes elided)")
}

fn read_repo_readme_body(repo_abs: &str, _repo_name: &str) -> Option<String> {
    // Repos live at `<project>/.atlas/repos/<name>/` — the user
    // passes the abs path of the repo dir, so we look for README
    // variants directly under it. Order matches `github.rs::read_repo_readme`.
    let repo_dir = Path::new(repo_abs);
    for name in &[
        "README.md",
        "readme.md",
        "Readme.md",
        "README.rst",
        "README.txt",
        "README",
    ] {
        let path = repo_dir.join(name);
        if path.exists() {
            return std::fs::read_to_string(&path).ok();
        }
    }
    None
}
