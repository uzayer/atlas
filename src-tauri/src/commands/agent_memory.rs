//! `agent_memory_read` — surface what each ACP agent persists for the
//! current project, read-only.
//!
//! Claude Code keeps a per-project *markdown* memory folder at
//! `~/.claude/projects/<encoded-cwd>/memory/` (a `MEMORY.md` index plus one
//! `.md` file per fact with YAML frontmatter), alongside the classic
//! `CLAUDE.md` instruction files. Codex has no per-project markdown memory —
//! it keeps session state in SQLite (`~/.codex/state_*.sqlite`, `threads`
//! table keyed by `cwd`) plus repo `AGENTS.md`. So we render Claude as
//! markdown and Codex as a table of its prior threads in this project.
//!
//! Everything here is best-effort and read-only: missing files / DBs degrade
//! to empty sections rather than erroring the whole command.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::process::Command as AsyncCommand;

#[derive(Debug, Serialize)]
pub struct MemoryFile {
    /// Raw filename (e.g. `feedback_terminal.md`).
    name: String,
    /// Frontmatter `name:` if present, else the filename stem.
    title: String,
    /// Frontmatter `description:` (one-liner).
    description: String,
    /// Frontmatter `metadata.type` (user / feedback / project / reference).
    kind: String,
    /// Full file contents, frontmatter stripped — ready for markdown render.
    body: String,
    modified_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct ClaudeMemory {
    /// Absolute path of the `memory/` dir (shown in the UI, may not exist).
    memory_dir: String,
    /// `MEMORY.md` index contents, if present.
    index: Option<String>,
    /// Individual memory fact files (excludes `MEMORY.md`), title-sorted.
    entries: Vec<MemoryFile>,
    /// Repo-local `CLAUDE.md`.
    project_md: Option<String>,
    /// Global `~/.claude/CLAUDE.md`.
    global_md: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CodexThread {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    first_user_message: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    git_branch: Option<String>,
    #[serde(default)]
    approval_mode: String,
    #[serde(default)]
    tokens_used: i64,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct CodexMemory {
    /// The state DB we read, if one was found.
    db_path: Option<String>,
    /// Repo-local `AGENTS.md`.
    agents_md: Option<String>,
    /// Global `~/.codex/AGENTS.md`.
    global_agents_md: Option<String>,
    /// Prior Codex threads whose `cwd` matches this project, newest first.
    threads: Vec<CodexThread>,
}

#[derive(Debug, Serialize)]
pub struct AgentMemory {
    claude: ClaudeMemory,
    codex: CodexMemory,
}

#[tauri::command]
pub async fn agent_memory_read(project_path: String) -> Result<AgentMemory, String> {
    let project_path = project_path.trim_end_matches('/').to_string();

    // Claude side is pure filesystem — run it on the blocking pool.
    let pp = project_path.clone();
    let claude = tokio::task::spawn_blocking(move || read_claude(&pp))
        .await
        .map_err(|e| e.to_string())?;

    // Codex side needs an out-of-process sqlite read; keep it async.
    let codex = read_codex(&project_path).await;

    Ok(AgentMemory { claude, codex })
}

// ── Corpus collection (for the Graph / embeddings feature) ──────────────────

/// One embeddable memory document, flattened across the Claude + Codex sources.
/// Reused by `memory_graph` to embed + relate the whole memory system.
#[derive(Debug, Clone)]
pub struct MemoryDoc {
    /// Stable id, e.g. `claude:feedback_x.md`, `codex:<thread-id>`.
    pub id: String,
    pub title: String,
    pub kind: String,
    pub source: String, // "claude" | "codex"
    /// Absolute path of the editable file this doc came from (memory `.md`,
    /// `CLAUDE.md`, `AGENTS.md`). `None` for non-file sources (Codex threads).
    /// Used by the policy editor to rewrite the exact text in place.
    pub file_path: Option<String>,
    /// Unix ms when this memory came into being (file mtime / thread created_at).
    /// 0 when unknown. Drives the temporal influence graph.
    pub timestamp_ms: i64,
    /// Text to embed (title is prepended by the caller if desired).
    pub text: String,
    /// Names this doc can be referenced by in `[[wikilinks]]` (slug + stem).
    pub aliases: Vec<String>,
    /// `[[wikilink]]` targets found in this doc's body.
    pub links: Vec<String>,
}

/// Flatten Claude markdown memory + Codex threads into embeddable documents.
pub async fn collect_corpus(project_path: &str) -> Vec<MemoryDoc> {
    let project_path = project_path.trim_end_matches('/').to_string();

    let pp = project_path.clone();
    let claude = tokio::task::spawn_blocking(move || read_claude(&pp))
        .await
        .unwrap_or_else(|_| ClaudeMemory {
            memory_dir: String::new(),
            index: None,
            entries: Vec::new(),
            project_md: None,
            global_md: None,
        });
    let codex = read_codex(&project_path).await;

    let home = dirs::home_dir().unwrap_or_default();
    let mem_dir = std::path::Path::new(&claude.memory_dir);
    let mut docs: Vec<MemoryDoc> = Vec::new();

    if let Some(idx) = &claude.index {
        docs.push(MemoryDoc {
            id: "claude:MEMORY.md".into(),
            title: "Memory Index".into(),
            kind: "index".into(),
            source: "claude".into(),
            file_path: Some(mem_dir.join("MEMORY.md").to_string_lossy().to_string()),
            timestamp_ms: file_mtime_ms(&mem_dir.join("MEMORY.md")),
            text: idx.clone(),
            aliases: vec!["MEMORY".into(), "MEMORY.md".into()],
            links: extract_wikilinks(idx),
        });
    }
    for e in &claude.entries {
        let stem = e.name.trim_end_matches(".md").to_string();
        let title = if e.title.is_empty() { stem.clone() } else { e.title.clone() };
        let body = if e.description.is_empty() {
            e.body.clone()
        } else {
            format!("{}\n\n{}", e.description, e.body)
        };
        docs.push(MemoryDoc {
            id: format!("claude:{}", e.name),
            title,
            kind: if e.kind.is_empty() { "memory".into() } else { e.kind.clone() },
            source: "claude".into(),
            file_path: Some(mem_dir.join(&e.name).to_string_lossy().to_string()),
            timestamp_ms: e.modified_ms as i64,
            text: body,
            aliases: vec![e.title.clone(), stem],
            links: extract_wikilinks(&e.body),
        });
    }
    if let Some(md) = &claude.project_md {
        docs.push(MemoryDoc {
            id: "claude:CLAUDE.md".into(),
            title: "CLAUDE.md".into(),
            kind: "instruction".into(),
            source: "claude".into(),
            file_path: Some(
                std::path::Path::new(&project_path)
                    .join("CLAUDE.md")
                    .to_string_lossy()
                    .to_string(),
            ),
            timestamp_ms: file_mtime_ms(&std::path::Path::new(&project_path).join("CLAUDE.md")),
            text: md.clone(),
            aliases: vec![],
            links: vec![],
        });
    }
    if let Some(md) = &claude.global_md {
        docs.push(MemoryDoc {
            id: "claude:CLAUDE.md@global".into(),
            title: "CLAUDE.md (global)".into(),
            kind: "instruction".into(),
            source: "claude".into(),
            file_path: Some(home.join(".claude").join("CLAUDE.md").to_string_lossy().to_string()),
            timestamp_ms: file_mtime_ms(&home.join(".claude").join("CLAUDE.md")),
            text: md.clone(),
            aliases: vec![],
            links: vec![],
        });
    }

    if let Some(md) = &codex.agents_md {
        docs.push(MemoryDoc {
            id: "codex:AGENTS.md".into(),
            title: "AGENTS.md".into(),
            kind: "instruction".into(),
            source: "codex".into(),
            file_path: Some(
                std::path::Path::new(&project_path)
                    .join("AGENTS.md")
                    .to_string_lossy()
                    .to_string(),
            ),
            timestamp_ms: file_mtime_ms(&std::path::Path::new(&project_path).join("AGENTS.md")),
            text: md.clone(),
            aliases: vec![],
            links: vec![],
        });
    }
    for t in &codex.threads {
        let text = if t.first_user_message.trim().is_empty() {
            t.title.clone()
        } else {
            t.first_user_message.clone()
        };
        if text.trim().is_empty() {
            continue;
        }
        let raw_title = if t.title.trim().is_empty() { &t.first_user_message } else { &t.title };
        docs.push(MemoryDoc {
            id: format!("codex:{}", t.id),
            title: short_title(raw_title),
            kind: "thread".into(),
            source: "codex".into(),
            file_path: None, // Codex threads live in SQLite, not an editable file.
            timestamp_ms: t.created_at.saturating_mul(1000),
            text,
            aliases: vec![],
            links: vec![],
        });
    }

    docs
}

/// File mtime as unix ms, or 0 if unavailable.
fn file_mtime_ms(path: &std::path::Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Strip the appended Atlas-context block, collapse whitespace, truncate.
fn short_title(s: &str) -> String {
    let cut = s.split("\n---\n").next().unwrap_or(s);
    let collapsed: String = cut.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 80 {
        let head: String = collapsed.chars().take(80).collect();
        format!("{head}…")
    } else {
        collapsed
    }
}

/// Pull `[[name]]` (and `[[name|alias]]` → name) targets out of a body.
fn extract_wikilinks(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        if let Some(end) = rest.find("]]") {
            let inner = &rest[..end];
            let name = inner.split('|').next().unwrap_or(inner).trim();
            if !name.is_empty() {
                out.push(name.to_string());
            }
            rest = &rest[end + 2..];
        } else {
            break;
        }
    }
    out
}

/// `/Users/adib/Desktop/atlas` → `-Users-adib-Desktop-atlas` (Claude's
/// per-project dir naming: every `/` becomes `-`).
fn encode_project_dir(project_path: &str) -> String {
    project_path.replace('/', "-")
}

fn read_claude(project_path: &str) -> ClaudeMemory {
    let home = dirs::home_dir().unwrap_or_default();
    let mem_dir = home
        .join(".claude")
        .join("projects")
        .join(encode_project_dir(project_path))
        .join("memory");

    let index = std::fs::read_to_string(mem_dir.join("MEMORY.md")).ok();

    let mut entries: Vec<MemoryFile> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&mem_dir) {
        for ent in rd.flatten() {
            let path = ent.path();
            let fname = ent.file_name().to_string_lossy().to_string();
            if fname == "MEMORY.md" {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let modified_ms = ent
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let (meta, body) = parse_frontmatter(&raw);
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| fname.clone());
            entries.push(MemoryFile {
                name: fname,
                title: meta.name.unwrap_or(stem),
                description: meta.description.unwrap_or_default(),
                kind: meta.kind.unwrap_or_default(),
                body,
                modified_ms,
            });
        }
    }
    // Stable, human order: type then title.
    entries.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.title.cmp(&b.title)));

    let project_md = std::fs::read_to_string(Path::new(project_path).join("CLAUDE.md")).ok();
    let global_md = std::fs::read_to_string(home.join(".claude").join("CLAUDE.md")).ok();

    ClaudeMemory {
        memory_dir: mem_dir.to_string_lossy().to_string(),
        index,
        entries,
        project_md,
        global_md,
    }
}

#[derive(Default)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    kind: Option<String>,
}

/// Minimal YAML-frontmatter reader. We only need three scalar fields
/// (`name`, `description`, `metadata.type`), so a line scan beats pulling in
/// a YAML crate. Returns the parsed fields and the body with the frontmatter
/// block removed.
fn parse_frontmatter(raw: &str) -> (Frontmatter, String) {
    let mut fm = Frontmatter::default();
    let trimmed = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let lines: Vec<&str> = trimmed.lines().collect();
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return (fm, raw.to_string());
    }
    // Locate the closing fence (first "---" after line 0).
    let Some(close) = lines.iter().skip(1).position(|l| l.trim_end() == "---") else {
        return (fm, raw.to_string()); // unterminated → all body
    };
    let close = close + 1; // un-skip

    let mut in_metadata = false;
    for line in &lines[1..close] {
        let indented = line.starts_with(' ') || line.starts_with('\t');
        let kv = line.trim();
        if kv == "metadata:" {
            in_metadata = true;
            continue;
        }
        if let Some((k, v)) = kv.split_once(':') {
            let key = k.trim();
            let val = v.trim().trim_matches('"').trim_matches('\'').to_string();
            match key {
                "name" if !indented => fm.name = Some(val),
                "description" if !indented => fm.description = Some(val),
                "type" if in_metadata && indented => fm.kind = Some(val),
                _ => {}
            }
        }
    }

    let body = lines[close + 1..].join("\n");
    let body = body.trim_start_matches(['\n', '\r']).to_string();
    (fm, body)
}

async fn read_codex(project_path: &str) -> CodexMemory {
    let home = dirs::home_dir().unwrap_or_default();
    let codex_dir = home.join(".codex");

    let agents_md = std::fs::read_to_string(Path::new(project_path).join("AGENTS.md")).ok();
    let global_agents_md = std::fs::read_to_string(codex_dir.join("AGENTS.md")).ok();

    let db = newest_state_db(&codex_dir);
    let threads = match &db {
        Some(p) => query_codex_threads(p, project_path).await,
        None => Vec::new(),
    };

    CodexMemory {
        db_path: db.map(|p| p.to_string_lossy().to_string()),
        agents_md,
        global_agents_md,
        threads,
    }
}

/// Pick the highest-versioned `state_<n>.sqlite` in `~/.codex` (the schema is
/// versioned; the newest is the live one). Skips `-wal`/`-shm` sidecars.
fn newest_state_db(codex_dir: &Path) -> Option<PathBuf> {
    let rd = std::fs::read_dir(codex_dir).ok()?;
    let mut best: Option<(u64, PathBuf)> = None;
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix("state_") else {
            continue;
        };
        let Some(num) = rest.strip_suffix(".sqlite") else {
            continue;
        };
        let ver: u64 = num.parse().unwrap_or(0);
        if best.as_ref().map(|(b, _)| ver > *b).unwrap_or(true) {
            best = Some((ver, ent.path()));
        }
    }
    best.map(|(_, p)| p)
}

async fn query_codex_threads(db: &Path, project_path: &str) -> Vec<CodexThread> {
    // CLI params aren't bindable in `-json` mode, so inline the cwd with the
    // standard SQL single-quote escape (double it). A filesystem path won't
    // normally contain quotes, but be safe.
    let escaped = project_path.replace('\'', "''");
    let sql = format!(
        "SELECT id, title, first_user_message, model, git_branch, approval_mode, \
         tokens_used, created_at, updated_at FROM threads \
         WHERE cwd = '{escaped}' AND archived = 0 \
         ORDER BY updated_at DESC LIMIT 300;"
    );

    let out = AsyncCommand::new("sqlite3")
        .arg("-readonly")
        .arg("-json")
        .arg(db)
        .arg(&sql)
        .output()
        .await;

    let Ok(out) = out else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stdout = stdout.trim();
    if stdout.is_empty() {
        // sqlite3 emits nothing for an empty result set.
        return Vec::new();
    }
    serde_json::from_str::<Vec<CodexThread>>(stdout).unwrap_or_default()
}
