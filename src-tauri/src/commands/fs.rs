use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub extension: Option<String>,
}

/// `#[tauri::command]` handlers WITHOUT `async` run on the NSApp main thread.
/// Any meaningful file I/O there freezes the whole app (beachball). All three
/// commands in this module therefore declare `async fn` + dispatch their
/// blocking work through `tokio::task::spawn_blocking`, which puts the syscall
/// on tokio's blocking worker pool and leaves the main thread responsive.

#[tauri::command]
pub async fn read_directory(path: String) -> Result<Vec<FileEntry>, String> {
    tokio::task::spawn_blocking(move || read_directory_sync(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_directory_sync(path: &str) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries = Vec::new();
    let read = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let file_path = entry.path().to_string_lossy().to_string();
        let ext = entry
            .path()
            .extension()
            .map(|e| e.to_string_lossy().to_string());

        entries.push(FileEntry {
            name,
            path: file_path,
            is_dir: metadata.is_dir(),
            is_symlink: metadata.is_symlink(),
            size: metadata.len(),
            extension: ext,
        });
    }

    // Sort: directories first, then alphabetical (case-insensitive)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        fs::write(&path, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Outcome of an `ensure_atlas_gitignore` run. Mostly for logging /
/// telemetry — the frontend doesn't act on the variant.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum EnsureAtlasGitignoreResult {
    /// `.git` directory wasn't present — we don't manage `.gitignore` for
    /// non-git projects (no value to the user).
    NotGitRepo,
    /// `.gitignore` already contained an entry that matches `.atlas/` —
    /// nothing changed.
    AlreadyPresent,
    /// `.gitignore` existed but didn't list `.atlas/`; we appended.
    Added,
    /// No `.gitignore` existed; we created one with just `.atlas/`.
    Created,
}

const ATLAS_GITIGNORE_PATTERN: &str = ".atlas/";

/// Idempotent: makes sure the project's `.gitignore` contains `.atlas/`
/// (Atlas's own state directory). Safe to call on every project open.
///
/// Logic per the user-facing setting:
///   1. No `.git` → nothing to do.
///   2. `.gitignore` missing → create it with just `.atlas/`.
///   3. `.gitignore` present, doesn't list `.atlas/` (in any common
///      form) → append.
///   4. `.gitignore` present and already lists it → no-op.
///
/// Off the main thread (it touches the filesystem).
#[tauri::command]
pub async fn ensure_atlas_gitignore(
    project_path: String,
) -> Result<EnsureAtlasGitignoreResult, String> {
    tokio::task::spawn_blocking(move || ensure_atlas_gitignore_sync(&project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn ensure_atlas_gitignore_sync(
    project_path: &str,
) -> Result<EnsureAtlasGitignoreResult, String> {
    let root = Path::new(project_path);
    if !root.join(".git").exists() {
        return Ok(EnsureAtlasGitignoreResult::NotGitRepo);
    }

    let gitignore = root.join(".gitignore");

    if !gitignore.exists() {
        fs::write(&gitignore, format!("{}\n", ATLAS_GITIGNORE_PATTERN))
            .map_err(|e| format!("could not create .gitignore: {e}"))?;
        tracing::info!(
            target: "atlas::gitignore",
            "created {} with {}",
            gitignore.display(),
            ATLAS_GITIGNORE_PATTERN
        );
        return Ok(EnsureAtlasGitignoreResult::Created);
    }

    let existing =
        fs::read_to_string(&gitignore).map_err(|e| format!("could not read .gitignore: {e}"))?;

    if atlas_pattern_present(&existing) {
        return Ok(EnsureAtlasGitignoreResult::AlreadyPresent);
    }

    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(ATLAS_GITIGNORE_PATTERN);
    next.push('\n');

    fs::write(&gitignore, next).map_err(|e| format!("could not write .gitignore: {e}"))?;
    tracing::info!(
        target: "atlas::gitignore",
        "appended {} to {}",
        ATLAS_GITIGNORE_PATTERN,
        gitignore.display()
    );
    Ok(EnsureAtlasGitignoreResult::Added)
}

/// True if any line in `.gitignore` already matches `.atlas/` in any of
/// the equivalent forms users commonly write. Comment lines (`#…`) and
/// blank lines are skipped; trailing whitespace is ignored.
fn atlas_pattern_present(contents: &str) -> bool {
    contents.lines().any(|raw| {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            return false;
        }
        matches!(line, ".atlas" | ".atlas/" | "/.atlas" | "/.atlas/")
    })
}
