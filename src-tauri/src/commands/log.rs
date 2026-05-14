use std::fs;
use std::io::Write;
use std::path::PathBuf;

fn log_file_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home.join(".atlas").join("log").join("pinned.jsonl"))
}

fn ensure_dir(path: &PathBuf) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn load_pinned_log() -> Result<String, String> {
    tokio::task::spawn_blocking(|| -> Result<String, String> {
        let path = log_file_path()?;
        if !path.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn append_pinned_log(entry_json: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = log_file_path()?;
        ensure_dir(&path)?;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        // Strip any newlines in the entry so each line is one entry.
        let single = entry_json.replace('\n', " ");
        writeln!(f, "{}", single).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_pinned_log() -> Result<(), String> {
    tokio::task::spawn_blocking(|| -> Result<(), String> {
        let path = log_file_path()?;
        if path.exists() {
            fs::write(&path, "").map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rewrite_pinned_log(entries_json: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = log_file_path()?;
        ensure_dir(&path)?;
        // Caller passes the full body (each line one entry, newline separated).
        fs::write(&path, &entries_json).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
