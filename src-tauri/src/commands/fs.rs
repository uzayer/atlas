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
