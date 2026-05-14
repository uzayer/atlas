use std::fs;
use std::path::Path;

const DEFAULT_EMPTY: &str = r#"{"version":1,"viewport":{"x":0,"y":0,"zoom":1},"nodes":[],"edges":[]}"#;

#[tauri::command]
pub async fn load_canvas(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let path = Path::new(&project_path).join(".atlas").join("canvas.json");
        if !path.exists() {
            return Ok(DEFAULT_EMPTY.to_string());
        }
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_canvas(project_path: String, payload: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dir = Path::new(&project_path).join(".atlas");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let final_path = dir.join("canvas.json");
        let tmp_path = dir.join("canvas.json.tmp");
        fs::write(&tmp_path, &payload).map_err(|e| e.to_string())?;
        // Atomic rename — avoids partial writes on crash.
        fs::rename(&tmp_path, &final_path).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
