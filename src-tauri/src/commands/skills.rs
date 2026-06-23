//! Skills feature — Phase 1 backend (on-disk authoring + multi-agent enable).
//!
//! Atlas manages agent "skills" the same way the `skills` CLI does: a single
//! **canonical store** holds the authored `SKILL.md`, and each agent that should
//! "see" the skill gets a **symlink** into its own skills directory. Disk *is*
//! the state — there is no separate enable/disable file.
//!
//! ```text
//! canonical (= installed, managed by Atlas):
//!   <root>/.atlas/skills/<name>/SKILL.md
//! enablement (= symlink present, what the agent reads):
//!   <root>/.claude/skills/<name> -> ../../.atlas/skills/<name>
//! ```
//!
//! `<root>` is the home dir (global scope) or the project path (project scope).
//! The agent registry is a static table for v1 (Claude Code + Codex); detection
//! is "does the agent's config dir exist under `<root>`?".
//!
//! Discovery also surfaces **external** skills: real directories that live
//! directly in an agent's skills dir (e.g. `~/.claude/skills/<name>/SKILL.md`)
//! that Atlas did not author. These are `managed = false`; the "Make for all
//! agents" (adopt) command copies them into the canonical store and fans them
//! out to every detected agent via symlink.
//!
//! Security: skill names are sanitized and every resolved path is verified to
//! stay inside `<root>/.atlas/skills` so a crafted name can't escape via `..`.
//!
//! Mirrors conventions from `byok.rs` (`#[tauri::command]` + `Result<T,String>`),
//! `shared_memory.rs` (atomic tmp+rename writes), and `agent_memory.rs`
//! (minimal hand-rolled YAML frontmatter — no new YAML crate).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

// ── Data model ─────────────────────────────────────────────────────────────────

/// Non-secret metadata for one installed skill (what the list view renders).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    /// `"global"` | `"project"`.
    pub scope: String,
    /// Registry agent ids that currently have a symlink to this skill.
    pub enabled_agents: Vec<String>,
    /// Absolute path to the canonical `SKILL.md`.
    pub path: String,
    /// Capability tier from the registry (default `"native-dir"`).
    pub delivery: String,
    /// `true` when this skill exists in Atlas's canonical `.atlas/skills` store
    /// (Atlas authored/adopted it). `false` for external skills that only exist
    /// as a real directory inside one or more agent skills dirs.
    pub managed: bool,
}

/// Full skill contents for editing/preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillContent {
    pub name: String,
    pub description: String,
    /// Body with the frontmatter block stripped.
    pub body: String,
    /// The raw on-disk file, frontmatter included.
    pub raw: String,
}

/// A registry agent as a possible enable target for the current scope+root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTarget {
    pub id: String,
    pub display_name: String,
    /// Relative skills dir under `<root>` (e.g. `.claude/skills`).
    pub skills_dir: String,
    pub delivery: String,
    /// Whether the agent's config dir exists under `<root>`.
    pub detected: bool,
}

// ── Tool registry (CP.2) ─────────────────────────────────────────────────────────

/// A statically-known *tool* (agent) and where its skills/config live, relative
/// to `<root>`. Extends the old `AgentDef`: the single `skills_dir` is split into
/// `global_skills_dir` + `project_skills_dir` because Codex uses different paths
/// per scope (`~/.codex/skills` global, `<proj>/.agents/skills` project).
struct ToolDef {
    /// Stable key, e.g. `"codex"`.
    id: &'static str,
    display_name: &'static str,
    /// Skills dir relative to home for **global** scope (e.g. `.codex/skills`).
    global_skills_dir: &'static str,
    /// Skills dir relative to the project for **project** scope (e.g. `.agents/skills`).
    project_skills_dir: &'static str,
    /// Config dir relative to root whose existence == "detected".
    config_dir: &'static str,
    /// `false` ⇒ copy-only projection (never attempt a symlink).
    supports_symlink: bool,
    /// `"native-dir"` | `"copy-only"` | `"inject-only"`.
    delivery: &'static str,
    /// Env var that, when set, relocates this tool's **global** skills base to
    /// `$ENV/skills` (e.g. `CODEX_HOME`, `CLAUDE_CONFIG_DIR`).
    env_override: Option<&'static str>,
}

// v1 in-scope tools: Claude Code + Codex. The registry is trivially extensible —
// a future ACP agent is one more ToolDef row.
const TOOL_REGISTRY: &[ToolDef] = &[
    ToolDef {
        id: "claude-code",
        display_name: "Claude Code",
        global_skills_dir: ".claude/skills",
        project_skills_dir: ".claude/skills",
        config_dir: ".claude",
        supports_symlink: true,
        delivery: "native-dir",
        env_override: Some("CLAUDE_CONFIG_DIR"),
    },
    ToolDef {
        id: "codex",
        // Codex: ~/.codex/skills globally, <proj>/.agents/skills at project scope.
        display_name: "Codex",
        global_skills_dir: ".codex/skills",
        project_skills_dir: ".agents/skills",
        config_dir: ".codex",
        supports_symlink: true,
        delivery: "native-dir",
        env_override: Some("CODEX_HOME"),
    },
];

fn tool_def(id: &str) -> Option<&'static ToolDef> {
    TOOL_REGISTRY.iter().find(|t| t.id == id)
}

/// Select a tool's skills dir for a scope, honoring `env_override` at global
/// scope. `root` is the home dir (global) or project path (project).
///
/// At global scope with `env_override` set in the environment, the tool's global
/// skills base becomes `$ENV/skills` (an absolute path, ignoring `root`).
fn tool_skills_dir(tool: &ToolDef, scope: &str, root: &Path) -> PathBuf {
    match scope {
        "global" => {
            if let Some(var) = tool.env_override {
                if let Some(val) = std::env::var_os(var) {
                    let val = val.to_string_lossy();
                    let trimmed = val.trim();
                    if !trimmed.is_empty() {
                        return PathBuf::from(trimmed).join("skills");
                    }
                }
            }
            root.join(tool.global_skills_dir)
        }
        _ => root.join(tool.project_skills_dir),
    }
}

// ── Path resolution + security ─────────────────────────────────────────────────

/// Resolve `<root>` for a scope. Global → home dir; project → the given path.
fn root_for(scope: &str, project_path: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => home_dir().ok_or_else(|| "could not resolve home directory".to_string()),
        "project" => {
            let p = project_path
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| "project scope requires a projectPath".to_string())?;
            let path = PathBuf::from(p);
            // Lexically reject parent-dir traversal. The project root may not
            // exist yet, so we cannot canonicalize; instead refuse any `..`
            // segment so a crafted path can't escape `.atlas/skills` later.
            if path.components().any(|c| matches!(c, Component::ParentDir)) {
                return Err(
                    "invalid projectPath: parent-directory segments are not allowed".to_string(),
                );
            }
            Ok(path)
        }
        other => Err(format!("invalid scope: {other}")),
    }
}

/// Home dir, preferring the `dirs` crate (already a dependency) and falling
/// back to `$HOME`.
fn home_dir() -> Option<PathBuf> {
    dirs::home_dir().or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

/// `<root>/.atlas/skills` — the canonical (Atlas-managed) store base.
fn skills_base(root: &Path) -> PathBuf {
    root.join(".atlas").join("skills")
}

/// Sanitize a skill name into a safe single path segment.
///
/// - lowercase; `[^a-z0-9._]+` → `-`; collapse runs; strip leading/trailing
///   `.`/`-`; cap at 255 chars.
/// - reject empty results and anything that still looks like traversal.
fn sanitize_name(name: &str) -> Result<String, String> {
    let lowered = name.trim().to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut prev_dash = false;
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' {
            out.push(ch);
            prev_dash = false;
        } else {
            // collapse any run of disallowed chars into a single '-'
            if !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        }
    }
    let trimmed = out.trim_matches(['.', '-']).to_string();
    let capped: String = trimmed.chars().take(255).collect();
    let capped = capped.trim_matches(['.', '-']).to_string();

    if capped.is_empty() {
        return Err(format!("invalid skill name: {name:?}"));
    }
    // Defense in depth: no path separators, no `.`/`..` segment.
    if capped == "." || capped == ".." || capped.contains('/') || capped.contains('\\') {
        return Err(format!("unsafe skill name: {name:?}"));
    }
    Ok(capped)
}

/// Resolve the canonical skill directory for a sanitized name and verify it
/// stays inside `<root>/.atlas/skills` (no `..` escape).
fn canonical_skill_dir(base: &Path, safe_name: &str) -> Result<PathBuf, String> {
    let dir = base.join(safe_name);
    // The only non-base component must be exactly `safe_name`.
    let rel = dir
        .strip_prefix(base)
        .map_err(|_| "path escapes skills base".to_string())?;
    let mut comps = rel.components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(seg)), None) if seg == std::ffi::OsStr::new(safe_name) => Ok(dir),
        _ => Err(format!("unsafe resolved path for {safe_name:?}")),
    }
}

// ── Frontmatter (minimal, no YAML crate — mirrors agent_memory.rs) ──────────────

#[derive(Default)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
}

/// Parse the leading `---` frontmatter block for `name`/`description`. Returns
/// the parsed scalars plus the body with the block stripped.
fn parse_frontmatter(raw: &str) -> (Frontmatter, String) {
    let mut fm = Frontmatter::default();
    let trimmed = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let lines: Vec<&str> = trimmed.lines().collect();
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return (fm, raw.to_string());
    }
    let Some(close) = lines.iter().skip(1).position(|l| l.trim_end() == "---") else {
        return (fm, raw.to_string()); // unterminated → all body
    };
    let close = close + 1; // un-skip

    for line in &lines[1..close] {
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if let Some((k, v)) = line.trim().split_once(':') {
            let key = k.trim();
            let val = v.trim().trim_matches('"').trim_matches('\'').to_string();
            match key {
                "name" if !indented => fm.name = Some(val),
                "description" if !indented => fm.description = Some(val),
                _ => {}
            }
        }
    }

    let body = lines[close + 1..].join("\n");
    let body = body.trim_start_matches(['\n', '\r']).to_string();
    (fm, body)
}

/// Render a `SKILL.md` with frontmatter for the given fields.
fn render_skill_md(name: &str, description: &str, body: &str) -> String {
    // Keep values single-line; frontmatter is scalar-only here.
    let desc = description.replace(['\n', '\r'], " ");
    format!("---\nname: {name}\ndescription: {desc}\n---\n\n{}\n", body.trim_end())
}

// ── Disk helpers ───────────────────────────────────────────────────────────────

/// Atomic write: tmp + rename (mirrors `shared_memory::atomic_write`).
fn atomic_write(path: &Path, payload: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// True if `<root>/<tool.config_dir>` exists.
fn tool_detected(root: &Path, def: &ToolDef) -> bool {
    root.join(def.config_dir).is_dir()
}

/// Path to a tool's projection entry for a skill at a scope:
/// `<tool_skills_dir>/<name>`.
fn tool_link_path(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> PathBuf {
    tool_skills_dir(def, scope, root).join(safe_name)
}

/// Whether any entry (symlink or copy) for this skill exists in the tool dir.
fn tool_has_entry(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> bool {
    tool_link_path(root, def, scope, safe_name)
        .symlink_metadata()
        .is_ok()
}

/// Whether the entry is specifically a symlink.
#[allow(dead_code)] // reserved for the reconcile-UI projection-mode probe
fn tool_entry_is_symlink(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> bool {
    tool_link_path(root, def, scope, safe_name)
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Compute the relative symlink target from a tool's skills dir up to the
/// canonical `<root>/.atlas/skills/<name>`. Used only for `<root>`-relative dirs
/// (the common case). For env-relocated absolute dirs we fall back to an absolute
/// target via [`canonical_symlink_target`].
fn relative_symlink_target(skills_dir_rel: &Path, safe_name: &str) -> PathBuf {
    let up = "../".repeat(skills_dir_rel.components().count());
    PathBuf::from(format!("{up}.atlas/skills/{safe_name}"))
}

/// Best symlink target for a projection: relative when the tool dir is under
/// `<root>` (keeps the link valid if the tree moves), absolute otherwise (env
/// override relocated the dir outside `<root>`).
fn canonical_symlink_target(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> PathBuf {
    let dir = tool_skills_dir(def, scope, root);
    if let Ok(rel) = dir.strip_prefix(root) {
        relative_symlink_target(rel, safe_name)
    } else {
        skills_base(root).join(safe_name)
    }
}

/// Wipe whatever entry sits at the projection path (symlink/file/dir), so we can
/// re-materialize cleanly. Only ever the `<name>` entry inside the tool dir.
fn clear_entry(link: &Path) -> Result<(), String> {
    if let Ok(meta) = link.symlink_metadata() {
        if !meta.file_type().is_symlink() && meta.is_dir() {
            fs::remove_dir_all(link).map_err(|e| e.to_string())?;
        } else {
            let _ = fs::remove_file(link);
        }
    }
    Ok(())
}

/// Create a relative symlink from the tool skills dir to the canonical skill.
/// Idempotent: a stale entry is removed first, then recreated.
fn create_symlink(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> Result<(), String> {
    let link = tool_link_path(root, def, scope, safe_name);
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    clear_entry(&link)?;
    let target = canonical_symlink_target(root, def, scope, safe_name);
    symlink(&target, &link).map_err(|e| format!("symlink failed: {e}"))
}

/// Materialize a copy projection: recursively copy canonical → tool dir.
fn create_copy(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> Result<(), String> {
    let canonical = canonical_skill_dir(&skills_base(root), safe_name)?;
    if !canonical.join("SKILL.md").is_file() {
        return Err(format!("canonical skill not found: {safe_name}"));
    }
    let link = tool_link_path(root, def, scope, safe_name);
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    clear_entry(&link)?;
    copy_dir_all(&canonical, &link)
}

/// Remove a tool's projection for a skill (symlink or copy). Best-effort.
fn remove_symlink(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> Result<(), String> {
    let link = tool_link_path(root, def, scope, safe_name);
    clear_entry(&link)
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlinks are only supported on unix in v1",
    ))
}

// ── Content hashing (CP.3) ───────────────────────────────────────────────────────

/// Stable content hash of a skill directory for **change detection** (not
/// security). Walks every file under `dir` sorted by relative path and folds
/// `(relpath_bytes, 0x00, file_bytes)` into a 64-bit FNV-1a, returned as hex.
/// Missing dir → empty string (treated as "no content").
fn hash_skill_dir(dir: &Path) -> String {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

    // Collect (relative-path, absolute-path) for every file, sorted by relpath.
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_files(dir, dir, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hash = FNV_OFFSET;
    let mut fold = |bytes: &[u8]| {
        for &b in bytes {
            hash ^= b as u64;
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    };
    for (rel, abs) in &files {
        fold(rel.as_bytes());
        fold(&[0x00]);
        if let Ok(bytes) = fs::read(abs) {
            fold(&bytes);
        }
    }
    format!("{hash:016x}")
}

/// Recursively gather files under `dir` as `(relative-to-base path, abs path)`.
/// Symlinks are not followed (only real files contribute to the hash).
fn collect_files(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = path.symlink_metadata() else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            collect_files(base, &path, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push((rel.to_string_lossy().replace('\\', "/"), path));
        }
    }
}

// ── Projection ledger (CP.3) ─────────────────────────────────────────────────────

/// One recorded projection of a skill into a tool: how it was materialized and
/// the canonical hash at push time (for drift detection on copies).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LedgerEntry {
    /// `"symlink"` | `"copy"`.
    mode: String,
    /// Canonical content hash at the moment of projection.
    hash: String,
}

/// `<root>/.atlas/skills/.projections.json` — one ledger per root (home for
/// global, project for project). Map: skill → toolId → entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Ledger {
    version: u32,
    projections: BTreeMap<String, BTreeMap<String, LedgerEntry>>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self {
            version: 1,
            projections: BTreeMap::new(),
        }
    }
}

fn ledger_path(root: &Path) -> PathBuf {
    skills_base(root).join(".projections.json")
}

/// Read the ledger, tolerating a missing or garbage file (→ default empty).
fn read_ledger(root: &Path) -> Ledger {
    let path = ledger_path(root);
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Ledger::default(),
    }
}

/// Atomically persist the ledger (reuses [`atomic_write`]).
fn write_ledger(root: &Path, ledger: &Ledger) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(ledger).map_err(|e| e.to_string())?;
    atomic_write(&ledger_path(root), &payload)
}

fn ledger_record(
    ledger: &mut Ledger,
    safe_name: &str,
    tool_id: &str,
    mode: &str,
    hash: &str,
) {
    ledger
        .projections
        .entry(safe_name.to_string())
        .or_default()
        .insert(
            tool_id.to_string(),
            LedgerEntry {
                mode: mode.to_string(),
                hash: hash.to_string(),
            },
        );
}

fn ledger_remove(ledger: &mut Ledger, safe_name: &str, tool_id: &str) {
    if let Some(tools) = ledger.projections.get_mut(safe_name) {
        tools.remove(tool_id);
        if tools.is_empty() {
            ledger.projections.remove(safe_name);
        }
    }
}

// ── Projection engine (CP.1 Job 3, CP.3) ─────────────────────────────────────────

/// Project a canonical skill into a tool at a scope. Symlink when the tool
/// `supports_symlink`, else copy fallback. Records mode + canonical hash in the
/// ledger. **Non-destructive**: refuses to clobber a `drifted` copy or an
/// `external` dir unless `force` is set.
fn project(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
    force: bool,
) -> Result<(), String> {
    if def.delivery == "inject-only" {
        return Err(format!(
            "tool {} is inject-only and cannot receive a file projection",
            def.id
        ));
    }
    let canonical = canonical_skill_dir(&skills_base(root), safe_name)?;
    let canonical_hash = hash_skill_dir(&canonical);
    if canonical_hash.is_empty() || !canonical.join("SKILL.md").is_file() {
        return Err(format!("canonical skill not found: {safe_name}"));
    }

    // Non-destructive guard: if a real (non-symlink) dir already sits at the
    // target, only overwrite when the caller forces it.
    let link = tool_link_path(root, def, scope, safe_name);
    if !force {
        if let Ok(meta) = link.symlink_metadata() {
            if !meta.file_type().is_symlink() && meta.is_dir() {
                let existing_hash = hash_skill_dir(&link);
                if existing_hash != canonical_hash {
                    return Err(format!(
                        "refusing to overwrite drifted/external '{safe_name}' in {} (use force)",
                        def.id
                    ));
                }
            }
        }
    }

    let mut ledger = read_ledger(root);
    if def.supports_symlink {
        match create_symlink(root, def, scope, safe_name) {
            Ok(()) => {
                ledger_record(&mut ledger, safe_name, def.id, "symlink", &canonical_hash);
            }
            Err(_) => {
                // Symlink syscall failed (e.g. non-Unix) → copy fallback.
                create_copy(root, def, scope, safe_name)?;
                ledger_record(&mut ledger, safe_name, def.id, "copy", &canonical_hash);
            }
        }
    } else {
        create_copy(root, def, scope, safe_name)?;
        ledger_record(&mut ledger, safe_name, def.id, "copy", &canonical_hash);
    }
    write_ledger(root, &ledger)
}

/// Remove a projection (symlink or copy) and drop its ledger entry.
fn unproject(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> Result<(), String> {
    remove_symlink(root, def, scope, safe_name)?;
    let mut ledger = read_ledger(root);
    ledger_remove(&mut ledger, safe_name, def.id);
    write_ledger(root, &ledger)
}

// ── Core (testable, no Tauri) ──────────────────────────────────────────────────

fn list_skills(root: &Path, scope: &str) -> Result<Vec<SkillMeta>, String> {
    // Keyed by the sanitized skill name so canonical + external entries dedupe.
    let mut by_name: BTreeMap<String, SkillMeta> = BTreeMap::new();

    // ── 1. Canonical (managed) skills under `<root>/.atlas/skills/*`. ──────────
    let base = skills_base(root);
    if let Ok(entries) = fs::read_dir(&base) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            // Sanitize the on-disk dir name before using it to build tool link
            // paths; skip entries whose name can't be made safe.
            let Ok(safe_name) = sanitize_name(&raw_name) else {
                continue;
            };
            let skill_md = entry.path().join("SKILL.md");
            let Ok(raw) = fs::read_to_string(&skill_md) else {
                continue; // dir without a SKILL.md isn't a skill
            };
            let (fm, _body) = parse_frontmatter(&raw);
            let enabled_agents: Vec<String> = TOOL_REGISTRY
                .iter()
                .filter(|def| tool_has_entry(root, def, scope, &safe_name))
                .map(|def| def.id.to_string())
                .collect();

            by_name.insert(
                safe_name.clone(),
                SkillMeta {
                    name: fm.name.unwrap_or_else(|| safe_name.clone()),
                    description: fm.description.unwrap_or_default(),
                    scope: scope.to_string(),
                    enabled_agents,
                    path: skill_md.to_string_lossy().to_string(),
                    delivery: "native-dir".to_string(),
                    managed: true,
                },
            );
        }
    }

    // ── 2. External (unmanaged) skills living directly in each tool dir. ───────
    // A top-level entry that is a *real directory* with its own `SKILL.md` and
    // is NOT one of our canonical skills is an external tool skill. Symlinks
    // resolving into the canonical store are already accounted for above, so we
    // skip them here. Container dirs without a top-level `SKILL.md` (e.g.
    // `~/.claude/skills/ecc/`) are skipped — no recursion (v1).
    for def in TOOL_REGISTRY {
        let dir = tool_skills_dir(def, scope, root);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            // Only real directories — skip symlinks (managed) and files.
            let Ok(meta) = entry.path().symlink_metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() || !meta.is_dir() {
                continue;
            }
            let skill_md = entry.path().join("SKILL.md");
            if !skill_md.is_file() {
                continue; // container dir without a top-level SKILL.md → skip
            }
            let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(safe_name) = sanitize_name(&raw_name) else {
                continue;
            };
            // A managed skill of the same name wins; don't downgrade it.
            if by_name.contains_key(&safe_name) {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&skill_md) else {
                continue;
            };
            let (fm, _body) = parse_frontmatter(&raw);

            let meta = by_name.entry(safe_name.clone()).or_insert_with(|| SkillMeta {
                name: fm.name.clone().unwrap_or_else(|| safe_name.clone()),
                description: fm.description.clone().unwrap_or_default(),
                scope: scope.to_string(),
                enabled_agents: Vec::new(),
                path: skill_md.to_string_lossy().to_string(),
                delivery: "native-dir".to_string(),
                managed: false,
            });
            if !meta.enabled_agents.iter().any(|a| a == def.id) {
                meta.enabled_agents.push(def.id.to_string());
            }
        }
    }

    let mut out: Vec<SkillMeta> = by_name.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn read_skill(root: &Path, name: &str) -> Result<SkillContent, String> {
    let safe = sanitize_name(name)?;
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    let skill_md = dir.join("SKILL.md");
    let raw = fs::read_to_string(&skill_md)
        .map_err(|e| format!("read {}: {e}", skill_md.display()))?;
    let (fm, body) = parse_frontmatter(&raw);
    Ok(SkillContent {
        name: fm.name.unwrap_or(safe),
        description: fm.description.unwrap_or_default(),
        body,
        raw,
    })
}

fn create_skill(
    root: &Path,
    scope: &str,
    name: &str,
    description: &str,
    body: &str,
    agents: &[String],
) -> Result<SkillMeta, String> {
    let safe = sanitize_name(name)?;
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    let skill_md = dir.join("SKILL.md");

    let existed = skill_md.is_file();
    let contents = render_skill_md(&safe, description, body);
    atomic_write(&skill_md, &contents)?;

    // Enable for each requested registry tool (symlink/copy via the engine).
    let mut enabled_agents = Vec::new();
    for agent in agents {
        if let Some(def) = tool_def(agent) {
            project(root, def, scope, &safe, false)?;
            enabled_agents.push(def.id.to_string());
        }
    }
    enabled_agents.sort();
    enabled_agents.dedup();

    // Edit-propagation: if this was an edit of an existing canonical skill,
    // re-push copy projections (symlinks read through the link for free). A copy
    // that is currently drifted is left untouched for explicit resolution.
    if existed {
        propagate_edit(root, scope, &safe)?;
    }

    Ok(SkillMeta {
        name: safe,
        description: description.replace(['\n', '\r'], " "),
        scope: scope.to_string(),
        enabled_agents,
        path: skill_md.to_string_lossy().to_string(),
        delivery: "native-dir".to_string(),
        managed: true,
    })
}

/// Recursively copy `src` → `dst` (dirs + files), creating parents as needed.
/// Used by `adopt_skill` to lift an external skill into the canonical store
/// without a new dependency. Symlinks inside the source are not followed into
/// new symlinks — their target contents are copied through `fs::copy`.
fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// "Make for all agents": adopt an external/single-agent skill into the
/// canonical store and fan it out to every detected tool as a projection.
fn adopt_skill(root: &Path, scope: &str, name: &str) -> Result<SkillMeta, String> {
    let safe = sanitize_name(name)?;
    let canonical = canonical_skill_dir(&skills_base(root), &safe)?;
    let canonical_md = canonical.join("SKILL.md");

    // 1. Locate the source. Prefer the canonical copy if it already exists;
    //    otherwise the first registry tool dir that holds a real skill dir.
    if !canonical_md.is_file() {
        let mut source: Option<PathBuf> = None;
        for def in TOOL_REGISTRY {
            let link = tool_link_path(root, def, scope, &safe);
            // Only adopt from a real directory with its own SKILL.md (an
            // external skill). A symlink would already point at canonical.
            let Ok(meta) = link.symlink_metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if link.is_dir() && link.join("SKILL.md").is_file() {
                source = Some(link);
                break;
            }
        }
        let source = source.ok_or_else(|| format!("skill not found to adopt: {safe}"))?;
        // 2. Copy the entire source dir into canonical (never delete the original).
        copy_dir_all(&source, &canonical)?;
    }

    // 3. For each DETECTED tool: project (symlink/copy) from canonical. The
    //    original external dir, if present, hashes equal to the just-copied
    //    canonical, so the non-destructive guard lets `project` replace it.
    let mut enabled_agents = Vec::new();
    for def in TOOL_REGISTRY {
        if !tool_detected(root, def) || def.delivery == "inject-only" {
            continue;
        }
        project(root, def, scope, &safe, false)?;
        enabled_agents.push(def.id.to_string());
    }
    enabled_agents.sort();
    enabled_agents.dedup();

    let raw = fs::read_to_string(&canonical_md).map_err(|e| e.to_string())?;
    let (fm, _body) = parse_frontmatter(&raw);
    Ok(SkillMeta {
        name: fm.name.unwrap_or_else(|| safe.clone()),
        description: fm.description.unwrap_or_default(),
        scope: scope.to_string(),
        enabled_agents,
        path: canonical_md.to_string_lossy().to_string(),
        delivery: "native-dir".to_string(),
        managed: true,
    })
}

fn set_enabled(
    root: &Path,
    scope: &str,
    name: &str,
    agent: &str,
    enabled: bool,
) -> Result<(), String> {
    let safe = sanitize_name(name)?;
    // Ensure the canonical skill exists before toggling a projection.
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    if !dir.join("SKILL.md").is_file() {
        return Err(format!("skill not found: {safe}"));
    }
    let def = tool_def(agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    if enabled {
        project(root, def, scope, &safe, false)
    } else {
        unproject(root, def, scope, &safe)
    }
}

fn delete_skill(root: &Path, scope: &str, name: &str) -> Result<(), String> {
    let safe = sanitize_name(name)?;
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    // Remove every registry tool's projection first, then the canonical dir.
    for def in TOOL_REGISTRY {
        remove_symlink(root, def, scope, &safe)?;
    }
    let mut ledger = read_ledger(root);
    ledger.projections.remove(&safe);
    write_ledger(root, &ledger).ok();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
}

fn skill_path(root: &Path, name: &str) -> Result<String, String> {
    let safe = sanitize_name(name)?;
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    let skill_md = dir.join("SKILL.md");
    if !skill_md.is_file() {
        return Err(format!("skill not found: {safe}"));
    }
    Ok(skill_md.to_string_lossy().to_string())
}

fn list_targets(root: &Path, scope: &str) -> Vec<AgentTarget> {
    TOOL_REGISTRY
        .iter()
        .map(|def| AgentTarget {
            id: def.id.to_string(),
            display_name: def.display_name.to_string(),
            skills_dir: tool_skills_dir(def, scope, root)
                .to_string_lossy()
                .to_string(),
            delivery: def.delivery.to_string(),
            detected: tool_detected(root, def),
        })
        .collect()
}

// ── Edit propagation (CP.3) ──────────────────────────────────────────────────────

/// Re-push copy projections after a canonical edit. Symlinks read through the
/// link, so nothing to do for them. A copy whose on-disk hash already differs
/// from its ledger-recorded hash is *drifted* (edited out-of-band) → leave it
/// for explicit resolution, never silently overwrite.
fn propagate_edit(root: &Path, scope: &str, safe_name: &str) -> Result<(), String> {
    let canonical = canonical_skill_dir(&skills_base(root), safe_name)?;
    let canonical_hash = hash_skill_dir(&canonical);
    let mut ledger = read_ledger(root);
    let Some(tools) = ledger.projections.get(safe_name).cloned() else {
        return Ok(());
    };
    for (tool_id, entry) in tools {
        if entry.mode != "copy" {
            continue;
        }
        let Some(def) = tool_def(&tool_id) else {
            continue;
        };
        let link = tool_link_path(root, def, scope, safe_name);
        let on_disk = hash_skill_dir(&link);
        // Drifted: the copy diverged from what we last pushed → block silent push.
        if !on_disk.is_empty() && on_disk != entry.hash {
            continue;
        }
        if on_disk == canonical_hash {
            continue; // already in sync
        }
        create_copy(root, def, scope, safe_name)?;
        ledger_record(&mut ledger, safe_name, &tool_id, "copy", &canonical_hash);
    }
    write_ledger(root, &ledger)
}

// ── Reconcile (CP.1 Job 2) ───────────────────────────────────────────────────────

/// A tool's registry facts for the reconciled view.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub id: String,
    pub display_name: String,
    pub detected_global: bool,
    pub detected_project: bool,
    pub supports_symlink: bool,
    pub delivery: String,
}

/// One cell of the skill × tool matrix.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionCell {
    pub tool: String,
    /// `"global"` | `"project"`.
    pub scope: String,
    /// `canonical` | `synced` | `drifted` | `external` | `conflict` | `absent`.
    pub status: String,
    /// `"symlink"` | `"copy"` | `null`.
    pub mode: Option<String>,
}

/// One reconciled skill row: its canonical facts plus the per-tool matrix.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciledSkill {
    pub name: String,
    pub description: String,
    /// The scope this row was reconciled at.
    pub scope: String,
    pub managed: bool,
    pub cells: Vec<ProjectionCell>,
}

/// The full reconciled view for one scope+root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileView {
    pub tools: Vec<ToolInfo>,
    pub skills: Vec<ReconciledSkill>,
}

/// Build the reconciled matrix for `scope`. `home` is always needed for global
/// detection facts even when reconciling a project scope.
fn reconcile(root: &Path, scope: &str, home: &Path) -> Result<ReconcileView, String> {
    let tools: Vec<ToolInfo> = TOOL_REGISTRY
        .iter()
        .map(|def| ToolInfo {
            id: def.id.to_string(),
            display_name: def.display_name.to_string(),
            detected_global: tool_detected(home, def),
            detected_project: scope == "project" && tool_detected(root, def),
            supports_symlink: def.supports_symlink,
            delivery: def.delivery.to_string(),
        })
        .collect();

    let ledger = read_ledger(root);
    let base = skills_base(root);

    // Names: canonical dirs ∪ external dirs across all tools at this scope.
    let mut names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut canonical_meta: BTreeMap<String, (String, String)> = BTreeMap::new(); // name → (display, desc)
    let mut canonical_hash: BTreeMap<String, String> = BTreeMap::new();

    if let Ok(entries) = fs::read_dir(&base) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(safe) = sanitize_name(&raw_name) else {
                continue;
            };
            let skill_md = entry.path().join("SKILL.md");
            let Ok(raw) = fs::read_to_string(&skill_md) else {
                continue;
            };
            let (fm, _b) = parse_frontmatter(&raw);
            canonical_meta.insert(
                safe.clone(),
                (
                    fm.name.unwrap_or_else(|| safe.clone()),
                    fm.description.unwrap_or_default(),
                ),
            );
            canonical_hash.insert(safe.clone(), hash_skill_dir(&entry.path()));
            names.insert(safe);
        }
    }

    // Pre-scan external/real dirs per tool (name → (display, desc, hash)).
    let mut external: BTreeMap<String, BTreeMap<String, (String, String, String)>> =
        BTreeMap::new();
    for def in TOOL_REGISTRY {
        let dir = tool_skills_dir(def, scope, root);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.path().symlink_metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() || !meta.is_dir() {
                continue;
            }
            if !entry.path().join("SKILL.md").is_file() {
                continue;
            }
            let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(safe) = sanitize_name(&raw_name) else {
                continue;
            };
            let raw = fs::read_to_string(entry.path().join("SKILL.md")).unwrap_or_default();
            let (fm, _b) = parse_frontmatter(&raw);
            external.entry(safe.clone()).or_default().insert(
                def.id.to_string(),
                (
                    fm.name.unwrap_or_else(|| safe.clone()),
                    fm.description.unwrap_or_default(),
                    hash_skill_dir(&entry.path()),
                ),
            );
            names.insert(safe);
        }
    }

    let mut skills: Vec<ReconciledSkill> = Vec::new();
    for name in &names {
        let managed = canonical_meta.contains_key(name);
        let (display, desc) = if let Some((d, e)) = canonical_meta.get(name) {
            (d.clone(), e.clone())
        } else {
            // Fall back to any external tool's metadata.
            external
                .get(name)
                .and_then(|m| m.values().next())
                .map(|(d, e, _)| (d.clone(), e.clone()))
                .unwrap_or_else(|| (name.clone(), String::new()))
        };
        let canon_hash = canonical_hash.get(name).cloned();

        let mut cells: Vec<ProjectionCell> = Vec::new();
        for def in TOOL_REGISTRY {
            let detected = tool_detected(root, def);
            let link = tool_link_path(root, def, scope, name);
            let entry_meta = link.symlink_metadata().ok();
            let is_symlink = entry_meta
                .as_ref()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);
            let is_real_dir = entry_meta
                .as_ref()
                .map(|m| !m.file_type().is_symlink() && m.is_dir())
                .unwrap_or(false);
            let ledger_entry = ledger
                .projections
                .get(name)
                .and_then(|t| t.get(def.id));

            let (status, mode) = if is_symlink {
                // A symlink projection always reflects canonical (it IS the file).
                ("synced".to_string(), Some("symlink".to_string()))
            } else if is_real_dir {
                let on_disk = hash_skill_dir(&link);
                if managed {
                    // Copy of a canonical skill → synced/drifted by hash.
                    match &canon_hash {
                        Some(h) if &on_disk == h => {
                            ("synced".to_string(), Some("copy".to_string()))
                        }
                        Some(_) => ("drifted".to_string(), Some("copy".to_string())),
                        None => ("drifted".to_string(), Some("copy".to_string())),
                    }
                } else {
                    // No canonical twin → external (or external-conflict).
                    ("external".to_string(), None)
                }
            } else if !entry_meta.is_some() {
                // Nothing on disk for this tool.
                if !detected {
                    ("absent".to_string(), None)
                } else if managed {
                    ("absent".to_string(), None)
                } else {
                    ("absent".to_string(), None)
                }
            } else {
                ("absent".to_string(), None)
            };

            // Conflict refinement: an external dir whose name collides with a
            // canonical skill but whose content differs is the dangerous case.
            let status = if status == "external" {
                if let (Some(ext_for_tool), Some(h)) =
                    (external.get(name).and_then(|m| m.get(def.id)), &canon_hash)
                {
                    if &ext_for_tool.2 != h {
                        "conflict".to_string()
                    } else {
                        status
                    }
                } else {
                    status
                }
            } else {
                status
            };

            // Mark the canonical owner cell on a synced-symlink when this tool
            // is the source? No — canonical lives in .atlas, not a tool dir. The
            // `canonical` status belongs to the library row itself, surfaced via
            // `managed`. Leave tool cells as projection statuses.
            let _ = mode; // (mode already set above)
            cells.push(ProjectionCell {
                tool: def.id.to_string(),
                scope: scope.to_string(),
                status,
                mode: match (is_symlink, is_real_dir, ledger_entry) {
                    (true, _, _) => Some("symlink".to_string()),
                    (_, true, _) => Some("copy".to_string()),
                    _ => None,
                },
            });
        }

        skills.push(ReconciledSkill {
            name: display,
            description: desc,
            scope: scope.to_string(),
            managed,
            cells,
        });
    }

    Ok(ReconcileView { tools, skills })
}

// ── Freeze (CP.3 uninstall safety) ───────────────────────────────────────────────

/// Convert every Atlas-authored *symlink* projection in the ledger into a real
/// copy, so removing `~/.atlas/skills` leaves each tool with a working,
/// self-contained skill dir. Idempotent (copies are left as-is).
fn freeze(root: &Path, scope: &str) -> Result<(), String> {
    let mut ledger = read_ledger(root);
    let snapshot = ledger.projections.clone();
    for (safe_name, tools) in snapshot {
        for (tool_id, entry) in tools {
            if entry.mode != "symlink" {
                continue;
            }
            let Some(def) = tool_def(&tool_id) else {
                continue;
            };
            let canonical = canonical_skill_dir(&skills_base(root), &safe_name)?;
            if !canonical.join("SKILL.md").is_file() {
                continue; // canonical gone — nothing to freeze from
            }
            let hash = hash_skill_dir(&canonical);
            // Replace the symlink with a real copy of canonical.
            create_copy(root, def, scope, &safe_name)?;
            ledger_record(&mut ledger, &safe_name, &tool_id, "copy", &hash);
        }
    }
    write_ledger(root, &ledger)
}

// ── Promote (CP.4 scenario 4) ────────────────────────────────────────────────────

/// Promote a project skill to global: copy `<proj>/.atlas/skills/<name>` →
/// `~/.atlas/skills/<name>`, then re-project into every detected tool at global
/// scope. The project copy is kept (the repo still travels with it).
fn promote(project_root: &Path, home: &Path, name: &str) -> Result<SkillMeta, String> {
    let safe = sanitize_name(name)?;
    let src = canonical_skill_dir(&skills_base(project_root), &safe)?;
    if !src.join("SKILL.md").is_file() {
        return Err(format!("project skill not found: {safe}"));
    }
    let dst = canonical_skill_dir(&skills_base(home), &safe)?;
    // Copy project canonical → global canonical (overwrite global copy).
    if dst.exists() {
        fs::remove_dir_all(&dst).map_err(|e| e.to_string())?;
    }
    copy_dir_all(&src, &dst)?;

    let mut enabled_agents = Vec::new();
    for def in TOOL_REGISTRY {
        if !tool_detected(home, def) || def.delivery == "inject-only" {
            continue;
        }
        project(home, def, "global", &safe, false)?;
        enabled_agents.push(def.id.to_string());
    }
    enabled_agents.sort();
    enabled_agents.dedup();

    let raw = fs::read_to_string(dst.join("SKILL.md")).map_err(|e| e.to_string())?;
    let (fm, _b) = parse_frontmatter(&raw);
    Ok(SkillMeta {
        name: fm.name.unwrap_or_else(|| safe.clone()),
        description: fm.description.unwrap_or_default(),
        scope: "global".to_string(),
        enabled_agents,
        path: dst.join("SKILL.md").to_string_lossy().to_string(),
        delivery: "native-dir".to_string(),
        managed: true,
    })
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

/// List installed skills for a scope (canonical store scan + per-agent enable).
#[tauri::command]
pub async fn skills_list(
    scope: String,
    project_path: Option<String>,
) -> Result<Vec<SkillMeta>, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || list_skills(&root, &scope))
        .await
        .map_err(|e| e.to_string())?
}

/// Read one skill's frontmatter + body (for editing/preview).
#[tauri::command]
pub async fn skills_read(
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<SkillContent, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || read_skill(&root, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// Create a skill in the canonical store and symlink it into the given agents.
#[tauri::command]
pub async fn skills_create(
    scope: String,
    name: String,
    description: String,
    body: String,
    agents: Vec<String>,
    project_path: Option<String>,
) -> Result<SkillMeta, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || {
        create_skill(&root, &scope, &name, &description, &body, &agents)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Enable/disable a single agent for a skill (create/remove its symlink).
#[tauri::command]
pub async fn skills_set_enabled(
    scope: String,
    name: String,
    agent: String,
    enabled: bool,
    project_path: Option<String>,
) -> Result<(), String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || set_enabled(&root, &scope, &name, &agent, enabled))
        .await
        .map_err(|e| e.to_string())?
}

/// Delete a skill: remove every agent symlink, then the canonical dir.
#[tauri::command]
pub async fn skills_delete(
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || delete_skill(&root, &scope, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// Absolute path to a skill's `SKILL.md` (for opening in the editor).
#[tauri::command]
pub async fn skills_path(
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<String, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || skill_path(&root, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// Adopt an external/single-agent skill: copy it into the canonical store (if
/// not already there) and symlink it into every detected agent ("Make for all
/// agents"). Returns the now-managed skill.
#[tauri::command]
pub async fn skills_adopt(
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<SkillMeta, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || adopt_skill(&root, &scope, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// List registry agents as enable targets for the current scope+root.
#[tauri::command]
pub async fn agents_list_skill_targets(
    scope: String,
    project_path: Option<String>,
) -> Result<Vec<AgentTarget>, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    Ok(
        tokio::task::spawn_blocking(move || list_targets(&root, &scope))
            .await
            .map_err(|e| e.to_string())?,
    )
}

// ── Tauri commands (Control Plane) ───────────────────────────────────────────────

/// List the tool registry with per-scope detection facts.
#[tauri::command]
pub async fn tools_list(
    scope: String,
    project_path: Option<String>,
) -> Result<Vec<AgentTarget>, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    Ok(
        tokio::task::spawn_blocking(move || list_targets(&root, &scope))
            .await
            .map_err(|e| e.to_string())?,
    )
}

/// Build the reconciled skill × tool matrix for a scope.
#[tauri::command]
pub async fn skills_reconcile(
    scope: String,
    project_path: Option<String>,
) -> Result<ReconcileView, String> {
    let root = root_for(&scope, project_path.as_deref())?;
    let home = home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    tokio::task::spawn_blocking(move || reconcile(&root, &scope, &home))
        .await
        .map_err(|e| e.to_string())?
}

/// Project a canonical skill into one tool at a scope (symlink/copy + ledger).
#[tauri::command]
pub async fn skills_project(
    scope: String,
    name: String,
    tool: String,
    force: Option<bool>,
    project_path: Option<String>,
) -> Result<(), String> {
    let root = root_for(&scope, project_path.as_deref())?;
    let force = force.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        let safe = sanitize_name(&name)?;
        let def = tool_def(&tool).ok_or_else(|| format!("unknown tool: {tool}"))?;
        project(&root, def, &scope, &safe, force)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove a projection (symlink/copy) of a skill from one tool + drop its ledger.
#[tauri::command]
pub async fn skills_unproject(
    scope: String,
    name: String,
    tool: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || {
        let safe = sanitize_name(&name)?;
        let def = tool_def(&tool).ok_or_else(|| format!("unknown tool: {tool}"))?;
        unproject(&root, def, &scope, &safe)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Promote a project skill to the global library + re-project at global scope.
#[tauri::command]
pub async fn skills_promote(
    name: String,
    project_path: String,
) -> Result<SkillMeta, String> {
    let project_root = root_for("project", Some(&project_path))?;
    let home = home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    tokio::task::spawn_blocking(move || promote(&project_root, &home, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// Freeze every Atlas symlink projection into a real copy (uninstall safety).
#[tauri::command]
pub async fn skills_freeze(
    scope: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let root = root_for(&scope, project_path.as_deref())?;
    tokio::task::spawn_blocking(move || freeze(&root, &scope))
        .await
        .map_err(|e| e.to_string())?
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let mut p = std::env::temp_dir();
        let uniq = format!(
            "atlas-skills-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        p.push(uniq);
        fs::create_dir_all(&p).unwrap();
        // Make both v1 tools "detected".
        fs::create_dir_all(p.join(".claude")).unwrap();
        fs::create_dir_all(p.join(".codex")).unwrap();
        p
    }

    #[test]
    fn sanitize_lowercases_and_replaces_spaces() {
        assert_eq!(sanitize_name("My Cool Skill").unwrap(), "my-cool-skill");
        assert_eq!(sanitize_name("PDF Extract").unwrap(), "pdf-extract");
        assert_eq!(sanitize_name("a   b").unwrap(), "a-b"); // collapse runs
    }

    #[test]
    fn sanitize_rejects_traversal() {
        // "../evil" → disallowed chars become '-', leading dashes stripped → "evil".
        let safe = sanitize_name("../evil").unwrap();
        assert_eq!(safe, "evil");
        assert!(!safe.contains('/'));
        assert!(!safe.contains(".."));
    }

    #[test]
    fn sanitize_rejects_empty() {
        assert!(sanitize_name("   ").is_err());
        assert!(sanitize_name("///").is_err());
        assert!(sanitize_name("...").is_err());
    }

    #[test]
    fn canonical_dir_stays_in_base() {
        let root = tmp_root();
        let base = skills_base(&root);
        let dir = canonical_skill_dir(&base, "pdf-extract").unwrap();
        assert!(dir.starts_with(&base));
        assert_eq!(dir.file_name().unwrap(), "pdf-extract");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn create_then_list_round_trip() {
        let root = tmp_root();
        let meta = create_skill(
            &root,
            "project",
            "PDF Extract",
            "Pull text out of PDFs",
            "Use pdftotext.",
            &["claude-code".to_string()],
        )
        .unwrap();
        assert_eq!(meta.name, "pdf-extract");
        assert_eq!(meta.enabled_agents, vec!["claude-code".to_string()]);

        let listed = list_skills(&root, "project").unwrap();
        assert_eq!(listed.len(), 1);
        let s = &listed[0];
        assert_eq!(s.name, "pdf-extract");
        assert_eq!(s.description, "Pull text out of PDFs");
        assert_eq!(s.enabled_agents, vec!["claude-code".to_string()]);

        // Canonical SKILL.md exists, symlink exists for claude-code only.
        assert!(root.join(".atlas/skills/pdf-extract/SKILL.md").is_file());
        assert!(root.join(".claude/skills/pdf-extract").symlink_metadata().is_ok());
        assert!(root
            .join(".agents/skills/pdf-extract")
            .symlink_metadata()
            .is_err());

        // Round-trip the body via read_skill.
        let content = read_skill(&root, "pdf-extract").unwrap();
        assert_eq!(content.description, "Pull text out of PDFs");
        assert_eq!(content.body.trim(), "Use pdftotext.");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn symlink_target_resolves_to_canonical() {
        let root = tmp_root();
        create_skill(&root, "project", "demo", "d", "body", &["claude-code".to_string()]).unwrap();
        let link = root.join(".claude/skills/demo");
        // Following the link reaches the canonical SKILL.md.
        let resolved = fs::canonicalize(link.join("SKILL.md")).unwrap();
        let expected = fs::canonicalize(root.join(".atlas/skills/demo/SKILL.md")).unwrap();
        assert_eq!(resolved, expected);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn set_enabled_toggles_symlink() {
        let root = tmp_root();
        create_skill(&root, "project", "demo", "d", "b", &[]).unwrap();
        let link = root.join(".agents/skills/demo");
        assert!(link.symlink_metadata().is_err());

        set_enabled(&root, "project", "demo", "codex", true).unwrap();
        assert!(link.symlink_metadata().is_ok());

        set_enabled(&root, "project", "demo", "codex", false).unwrap();
        assert!(link.symlink_metadata().is_err());

        // Toggling for an unknown agent errors.
        assert!(set_enabled(&root, "project", "demo", "nope", true).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_removes_canonical_and_symlinks() {
        let root = tmp_root();
        create_skill(
            &root,
            "project",
            "demo",
            "d",
            "b",
            &["claude-code".to_string(), "codex".to_string()],
        )
        .unwrap();
        assert!(root.join(".atlas/skills/demo").is_dir());
        assert!(root.join(".claude/skills/demo").symlink_metadata().is_ok());
        assert!(root.join(".agents/skills/demo").symlink_metadata().is_ok());

        delete_skill(&root, "project", "demo").unwrap();
        assert!(!root.join(".atlas/skills/demo").exists());
        assert!(root.join(".claude/skills/demo").symlink_metadata().is_err());
        assert!(root.join(".agents/skills/demo").symlink_metadata().is_err());

        // Listing is now empty.
        assert!(list_skills(&root, "project").unwrap().is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_targets_reports_detection() {
        let root = tmp_root();
        // Registry is claude-code + codex. tmp_root creates .claude and .codex,
        // so both are detected.
        let targets = list_targets(&root, "global");
        assert_eq!(targets.len(), 2);
        assert!(targets.iter().any(|t| t.id == "claude-code" && t.detected));
        assert!(targets.iter().any(|t| t.id == "codex" && t.detected));

        // Remove codex's config dir → not detected.
        fs::remove_dir_all(root.join(".codex")).unwrap();
        let targets = list_targets(&root, "global");
        let codex = targets.iter().find(|t| t.id == "codex").unwrap();
        assert!(!codex.detected);
        fs::remove_dir_all(&root).ok();
    }

    // ── Control Plane (CP) ────────────────────────────────────────────────────

    #[test]
    fn hash_is_stable_and_detects_change() {
        let root = tmp_root();
        create_skill(&root, "project", "h", "d", "body one", &[]).unwrap();
        let dir = root.join(".atlas/skills/h");
        let a = hash_skill_dir(&dir);
        assert_eq!(a, hash_skill_dir(&dir), "hash must be stable");
        create_skill(&root, "project", "h", "d", "body two", &[]).unwrap();
        assert_ne!(a, hash_skill_dir(&dir), "hash must change with content");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn project_symlinks_records_ledger_then_unproject_clears() {
        let root = tmp_root();
        create_skill(&root, "project", "p", "d", "b", &[]).unwrap();
        let def = tool_def("claude-code").unwrap();

        project(&root, def, "project", "p", false).unwrap();
        let link = root.join(".claude/skills/p");
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(read_ledger(&root).projections["p"]["claude-code"].mode, "symlink");

        unproject(&root, def, "project", "p").unwrap();
        assert!(link.symlink_metadata().is_err());
        assert!(!read_ledger(&root).projections.contains_key("p"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reconcile_reports_synced_external_and_absent() {
        let root = tmp_root();
        // Canonical skill projected into claude-code → synced; codex → absent.
        create_skill(&root, "project", "owned", "d", "b", &[]).unwrap();
        project(&root, tool_def("claude-code").unwrap(), "project", "owned", false).unwrap();
        // A hand-authored skill living only in codex's project dir → external.
        plant_external(&root, ".agents/skills", "wild", "External wild");

        let view = reconcile(&root, "project", &root).unwrap();
        assert_eq!(view.tools.len(), 2);

        let owned = view.skills.iter().find(|s| s.name == "owned").unwrap();
        assert!(owned.managed);
        assert_eq!(
            owned.cells.iter().find(|c| c.tool == "claude-code").unwrap().status,
            "synced"
        );
        assert_eq!(
            owned.cells.iter().find(|c| c.tool == "codex").unwrap().status,
            "absent"
        );

        let wild = view.skills.iter().find(|s| s.name == "wild").unwrap();
        assert!(!wild.managed);
        assert_eq!(
            wild.cells.iter().find(|c| c.tool == "codex").unwrap().status,
            "external"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn freeze_converts_symlink_projection_to_real_copy() {
        let root = tmp_root();
        create_skill(&root, "project", "f", "d", "b", &[]).unwrap();
        project(&root, tool_def("claude-code").unwrap(), "project", "f", false).unwrap();
        let link = root.join(".claude/skills/f");
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());

        freeze(&root, "project").unwrap();
        let meta = link.symlink_metadata().unwrap();
        assert!(!meta.file_type().is_symlink(), "freeze must replace the symlink");
        assert!(link.join("SKILL.md").is_file(), "frozen copy keeps the skill file");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn promote_copies_project_skill_to_global() {
        let home = tmp_root();
        let proj = tmp_root();
        create_skill(&proj, "project", "pr", "Promote me", "b", &[]).unwrap();

        let meta = promote(&proj, &home, "pr").unwrap();
        assert_eq!(meta.name, "pr");
        assert!(home.join(".atlas/skills/pr/SKILL.md").is_file());
        fs::remove_dir_all(&home).ok();
        fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn skill_path_errors_when_missing() {
        let root = tmp_root();
        assert!(skill_path(&root, "ghost").is_err());
        create_skill(&root, "project", "ghost", "d", "b", &[]).unwrap();
        assert!(skill_path(&root, "ghost").unwrap().ends_with("ghost/SKILL.md"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn canonical_base_is_under_dot_atlas() {
        let root = tmp_root();
        assert_eq!(skills_base(&root), root.join(".atlas/skills"));
        let meta = create_skill(&root, "project", "demo", "d", "b", &[]).unwrap();
        assert!(meta.path.contains("/.atlas/skills/demo/"));
        assert!(meta.managed);
        assert!(root.join(".atlas/skills/demo/SKILL.md").is_file());
        fs::remove_dir_all(&root).ok();
    }

    /// Plant a real (unmanaged) skill dir directly in an agent's skills dir.
    fn plant_external(root: &Path, agent_skills_dir: &str, name: &str, description: &str) {
        let dir = root.join(agent_skills_dir).join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n\nbody\n"),
        )
        .unwrap();
    }

    #[test]
    fn external_skill_is_listed_as_unmanaged() {
        let root = tmp_root();
        plant_external(&root, ".claude/skills", "foo", "External foo");

        let listed = list_skills(&root, "global").unwrap();
        assert_eq!(listed.len(), 1);
        let s = &listed[0];
        assert_eq!(s.name, "foo");
        assert!(!s.managed);
        assert_eq!(s.description, "External foo");
        assert_eq!(s.enabled_agents, vec!["claude-code".to_string()]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn container_dir_without_skill_md_is_not_listed() {
        let root = tmp_root();
        // `~/.claude/skills/ecc/` nests skills one level deeper → no top-level
        // SKILL.md. Must be skipped (no recursion in v1).
        fs::create_dir_all(root.join(".claude/skills/ecc/nested")).unwrap();
        fs::write(
            root.join(".claude/skills/ecc/nested/SKILL.md"),
            "---\nname: nested\n---\nbody\n",
        )
        .unwrap();

        let listed = list_skills(&root, "global").unwrap();
        assert!(listed.is_empty(), "container dir must not be listed: {listed:?}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn adopt_external_skill_makes_it_managed_for_all_agents() {
        let root = tmp_root(); // both .claude and .codex detected
        plant_external(&root, ".claude/skills", "foo", "External foo");
        // Sanity: pre-adopt it's unmanaged and claude-only.
        let pre = list_skills(&root, "global").unwrap();
        assert_eq!(pre.len(), 1);
        assert!(!pre[0].managed);

        let meta = adopt_skill(&root, "global", "foo").unwrap();
        assert!(meta.managed);
        assert_eq!(meta.description, "External foo");
        assert_eq!(
            meta.enabled_agents,
            vec!["claude-code".to_string(), "codex".to_string()]
        );

        // Canonical copy now exists.
        assert!(root.join(".atlas/skills/foo/SKILL.md").is_file());
        // The original real dir was replaced by a symlink into canonical.
        let claude_link = root.join(".claude/skills/foo");
        assert!(claude_link.symlink_metadata().unwrap().file_type().is_symlink());
        // And the other detected tool (codex, global dir) got a symlink too.
        let codex_link = root.join(".codex/skills/foo");
        assert!(codex_link.symlink_metadata().unwrap().file_type().is_symlink());
        // Both resolve to the canonical SKILL.md.
        let expected = fs::canonicalize(root.join(".atlas/skills/foo/SKILL.md")).unwrap();
        assert_eq!(
            fs::canonicalize(claude_link.join("SKILL.md")).unwrap(),
            expected
        );
        assert_eq!(
            fs::canonicalize(codex_link.join("SKILL.md")).unwrap(),
            expected
        );

        // Now listed once, managed=true.
        let post = list_skills(&root, "global").unwrap();
        assert_eq!(post.len(), 1);
        assert!(post[0].managed);
        assert_eq!(
            post[0].enabled_agents,
            vec!["claude-code".to_string(), "codex".to_string()]
        );
        fs::remove_dir_all(&root).ok();
    }
}
