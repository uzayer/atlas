//! MCP server configuration for the native Atlas agent.
//!
//! The native agent connects to the MCP servers listed in
//! `<app_config_dir>/mcp-servers.json` (a JSON array of `cersei::mcp`'s
//! `McpServerConfig`: `{ name, command, args, env, url, type }`). These
//! commands let the UI read + write that list; the agent picks up changes on
//! its next app launch (servers are connected once + cached per session — see
//! `atlas_cersei`'s MCP bridge).

use serde_json::Value;
use tauri::{AppHandle, Manager};

fn config_path(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("mcp-servers.json")
}

/// The configured MCP servers (raw config objects). Empty if unset/unreadable.
#[tauri::command]
pub fn mcp_list(app: AppHandle) -> Vec<Value> {
    let Ok(raw) = std::fs::read_to_string(config_path(&app)) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Overwrite the MCP server list. The UI manages add/remove and saves the whole
/// array. Takes effect on the next app launch.
#[tauri::command]
pub fn mcp_save(app: AppHandle, servers: Vec<Value>) -> Result<(), String> {
    let path = config_path(&app);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&servers).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}
