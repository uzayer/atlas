use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DayAggregate {
    pub date: String,
    #[serde(default)]
    pub today: Option<bool>,
    #[serde(default)]
    pub focus_min: u32,
    #[serde(default)]
    pub sessions: u32,
    #[serde(default)]
    pub distractions: u32,
    #[serde(default)]
    pub hours: Vec<u32>,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub id: String,
    pub start_min: u32,
    pub end_min: u32,
    #[serde(rename = "type")]
    pub block_type: String,
    pub title: String,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub cycle: Option<u32>,
    #[serde(default)]
    pub distractions: Option<u32>,
    #[serde(default)]
    pub current: Option<bool>,
    #[serde(default)]
    pub elapsed_min: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroFile {
    #[serde(default)]
    pub days: Vec<DayAggregate>,
    #[serde(default)]
    pub blocks: Vec<Block>,
    #[serde(default)]
    pub known_tags: Vec<String>,
}

#[tauri::command]
pub async fn pomodoro_load(project_path: String) -> Result<PomodoroFile, String> {
    tokio::task::spawn_blocking(move || -> Result<PomodoroFile, String> {
        let path = Path::new(&project_path)
            .join(".atlas")
            .join("pomodoro.json");
        if !path.exists() {
            return Ok(PomodoroFile::default());
        }
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str::<PomodoroFile>(&raw).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pomodoro_save(project_path: String, file: PomodoroFile) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dir = Path::new(&project_path).join(".atlas");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let final_path = dir.join("pomodoro.json");
        let tmp_path = dir.join("pomodoro.json.tmp");
        let payload = serde_json::to_string(&file).map_err(|e| e.to_string())?;
        fs::write(&tmp_path, &payload).map_err(|e| e.to_string())?;
        fs::rename(&tmp_path, &final_path).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
