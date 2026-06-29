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
    /// A reusable procedure invoked with `#skill:<name>`. The body is the
    /// `SKILL.md` minus its frontmatter — inlined as a context block so it
    /// rides the same delivery rail as every other mention and reaches any
    /// ACP agent (no native-skills folder required). Mirrors `Knowledge`:
    /// the frontend pre-fills `inline_body` via `skills_read` (already
    /// frontmatter-stripped); `file_path` is the read fallback.
    Skill {
        id: String,
        display_name: String,
        file_path: String,
        #[serde(default)]
        inline_body: Option<String>,
    },
    /// A pack-delivered component invoked with `#<kind>:<name>` — `command`,
    /// `agent`, or `rule`. Like `Skill`, its body (frontmatter stripped) is
    /// inlined as a context block so it reaches any ACP agent. The frontend
    /// pre-fills `inline_body`; `file_path` is the read fallback.
    Component {
        id: String,
        display_name: String,
        component_kind: String,
        file_path: String,
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
            | MentionSpec::Skill { id, .. }
            | MentionSpec::Component { id, .. }
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
            MentionSpec::Skill { display_name, .. } => format!("#skill:{display_name}"),
            MentionSpec::Component {
                component_kind,
                display_name,
                ..
            } => format!("#{component_kind}:{display_name}"),
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
            // Reference the file by path — let the agent read it via
            // its own filesystem tools instead of inlining the body.
            // Inlining a 5000-line file blows up the context for every
            // turn forever; pointing at the path is one line and the
            // agent can pull just what it needs.
            Some(format!(
                "## {sf}\n\nFile at `{abs_path}`. Use your filesystem tools to read it.",
                sf = m.short_form()
            ))
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
            // Lead with an explicit directive so the agent actually EXPLORES the
            // codebase (reads the tree + source), not just the README. The
            // absolute path is given so it can `ls`/read directly.
            let instruction = format!(
                "## {sf}\n\nA cloned repository is available locally at the absolute path:\n\
                 `{abs_path}`\n\n\
                 **Explore this codebase** using your filesystem tools — list its directory \
                 tree, open the key source files, and trace how the pieces fit together to \
                 understand what it does and how it works. Do NOT rely on the README alone; \
                 read the actual source. Apply this understanding to the rest of this request.",
                sf = m.short_form(),
            );
            let readme = if *has_readme {
                match read_repo_readme_body(abs_path, display_name) {
                    Some(b) => format!(
                        "\n\nIts README is included below as a starting point only — \
                         keep exploring the source beyond it:\n\n{}",
                        clip_body(&b)
                    ),
                    None => String::new(),
                }
            } else {
                String::new()
            };
            Some(format!("{instruction}{readme}"))
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
        MentionSpec::Skill {
            file_path,
            inline_body,
            ..
        } => {
            // The frontend pre-fills `inline_body` from `skills_read` (already
            // frontmatter-stripped). Fall back to reading the `SKILL.md` and
            // stripping its frontmatter so the agent sees only the procedure.
            let body = match inline_body.as_deref() {
                Some(b) if !b.is_empty() => b.to_string(),
                _ => read_skill_body(file_path),
            };
            Some(format!(
                "## {sf}\n\n{body}",
                sf = m.short_form(),
                body = clip_body(&body),
            ))
        }
        MentionSpec::Component {
            file_path,
            inline_body,
            ..
        } => {
            // Same rail as Skill: inline the component body (a command/agent/rule
            // markdown, frontmatter stripped) so any ACP agent receives it.
            let body = match inline_body.as_deref() {
                Some(b) if !b.is_empty() => b.to_string(),
                _ => read_skill_body(file_path),
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

/// Read a `SKILL.md` and return just the procedure body, stripping a leading
/// `---` frontmatter block. The frontend normally pre-fills the already-parsed
/// body, so this is only the fallback path; it intentionally mirrors the
/// minimal frontmatter handling in `commands::skills::parse_frontmatter`
/// without depending on it.
fn read_skill_body(path: &str) -> String {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return "(unable to read skill)".to_string();
    };
    strip_frontmatter(&raw)
}

fn strip_frontmatter(raw: &str) -> String {
    let trimmed = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let mut lines = trimmed.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return raw.to_string(); // no frontmatter → all body
    }
    let mut body_lines: Vec<&str> = Vec::new();
    let mut closed = false;
    for line in lines {
        if !closed {
            if line.trim_end() == "---" {
                closed = true;
            }
            continue;
        }
        body_lines.push(line);
    }
    if !closed {
        return raw.to_string(); // unterminated frontmatter → treat all as body
    }
    let body = body_lines.join("\n");
    body.trim_start_matches(['\n', '\r']).to_string()
}

fn clip_body(body: &str) -> String {
    if body.len() <= MENTION_BODY_BUDGET_BYTES {
        return body.to_string();
    }
    let head = &body[..MENTION_BODY_BUDGET_BYTES];
    let elided = body.len() - MENTION_BODY_BUDGET_BYTES;
    format!("{head}\n\n… (truncated, {elided} bytes elided)")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_leading_frontmatter_block() {
        let raw = "---\nname: review-rust-diff\ndescription: Review a diff.\n---\n\nStep 1. Check unwrap().";
        assert_eq!(strip_frontmatter(raw), "Step 1. Check unwrap().");
    }

    #[test]
    fn no_frontmatter_is_passed_through() {
        let raw = "Just a body, no frontmatter.\nSecond line.";
        assert_eq!(strip_frontmatter(raw), raw);
    }

    #[test]
    fn component_mention_inlines_body_with_kind_token() {
        let spec = MentionSpec::Component {
            id: "global:command:demo:ship".to_string(),
            display_name: "ship".to_string(),
            component_kind: "command".to_string(),
            file_path: String::new(),
            inline_body: Some("Do the ship steps.".to_string()),
        };
        let block = render_block(&spec).expect("component renders a block");
        assert!(block.contains("## #command:ship"), "got: {block}");
        assert!(block.contains("Do the ship steps."), "got: {block}");
    }

    #[test]
    fn unterminated_frontmatter_is_treated_as_body() {
        let raw = "---\nname: x\nbody but no close";
        assert_eq!(strip_frontmatter(raw), raw);
    }

    #[test]
    fn skill_short_form_and_block_use_hash_prefix() {
        let m = MentionSpec::Skill {
            id: "global:review-rust-diff".into(),
            display_name: "review-rust-diff".into(),
            file_path: "/nonexistent/SKILL.md".into(),
            inline_body: Some("Review the diff the way I like.".into()),
        };
        assert_eq!(m.short_form(), "#skill:review-rust-diff");
        let block = render_block(&m).expect("skill renders a block");
        assert_eq!(
            block,
            "## #skill:review-rust-diff\n\nReview the diff the way I like."
        );
    }
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
