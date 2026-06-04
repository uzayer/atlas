use atlas_terminal::TerminalManager;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};

pub struct TerminalState {
    pub manager: Arc<Mutex<TerminalManager>>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self {
            manager: Arc::new(Mutex::new(TerminalManager::new())),
        }
    }
}

#[tauri::command]
pub async fn terminal_create(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    let (tx, mut rx) = mpsc::unbounded_channel::<atlas_terminal::TerminalOutput>();

    let id = {
        let mut manager = state.manager.lock().await;
        manager
            .create_session(cols, rows, cwd.as_deref(), tx)
            .map_err(|e| e.to_string())?
    };

    // Spawn a task to forward PTY output, batching reads at ~16ms intervals (60fps)
    let app_handle = app.clone();
    let session_id = id.clone();
    tokio::spawn(async move {
        let mut buf: Vec<u8> = Vec::with_capacity(8192);
        loop {
            // Wait for first chunk
            match rx.recv().await {
                Some(output) => buf.extend_from_slice(&output.data),
                None => break,
            }
            // Drain any additional pending data without waiting
            while let Ok(output) = rx.try_recv() {
                buf.extend_from_slice(&output.data);
                // Cap batch size to avoid huge single events
                if buf.len() > 65536 { break; }
            }
            // Emit batched data
            let _ = app_handle.emit("terminal-output", &atlas_terminal::TerminalOutput {
                id: session_id.clone(),
                data: std::mem::take(&mut buf),
            });
        }
        let _ = app_handle.emit(
            "terminal-exit",
            serde_json::json!({ "id": session_id }),
        );
    });

    Ok(id)
}

/// The zsh shell-integration ZDOTDIR, so the frontend can relaunch an
/// interactive root shell (`sudo -s`/`-i`/`su`) with the same integration.
#[tauri::command]
pub fn terminal_zsh_dir() -> Option<String> {
    atlas_terminal::zsh_integration_dir().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, TerminalState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let manager = state.manager.lock().await;
    manager.write(&id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let manager = state.manager.lock().await;
    manager.resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_close(
    state: State<'_, TerminalState>,
    id: String,
) -> Result<(), String> {
    let mut manager = state.manager.lock().await;
    manager.close(&id);
    Ok(())
}

/// Resolve a path token clicked in the terminal to an existing absolute path,
/// or `None`. Strips a trailing `:line[:col]` suffix, expands `~`, resolves a
/// relative path against the shell's live cwd, and verifies the file exists
/// (so non-path matches in the link regex silently no-op). Blocking (lsof +
/// stat), so run off the main thread.
#[tauri::command]
pub async fn terminal_resolve_path(
    state: State<'_, TerminalState>,
    id: String,
    raw: String,
) -> Result<Option<String>, String> {
    let pid = {
        let manager = state.manager.lock().await;
        manager.pid(&id)
    };
    tokio::task::spawn_blocking(move || {
        let base = pid.and_then(atlas_terminal::cwd_of_pid);
        resolve_path_with_base(base.as_deref(), &raw)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Resolve a path token against an EXPLICIT base directory (e.g. a historical
/// command block's captured cwd), returning the existing absolute path or None.
#[tauri::command]
pub async fn resolve_path(base: String, raw: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || resolve_path_with_base(Some(&base), &raw))
        .await
        .map_err(|e| e.to_string())
}

fn resolve_path_with_base(base: Option<&str>, raw: &str) -> Option<String> {
    use std::path::PathBuf;

    let mut s = raw.trim().to_string();
    // Trim trailing punctuation that commonly abuts a path in prose/output.
    s = s
        .trim_end_matches(['.', ',', ';', ')', ']', '"', '\''])
        .to_string();
    // Strip up to two trailing `:NN` (line, col) segments.
    for _ in 0..2 {
        if let Some(idx) = s.rfind(':') {
            let tail = &s[idx + 1..];
            if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
                s.truncate(idx);
                continue;
            }
        }
        break;
    }
    if s.is_empty() {
        return None;
    }

    let path: PathBuf = if s == "~" {
        dirs::home_dir()?
    } else if let Some(rest) = s.strip_prefix("~/") {
        dirs::home_dir()?.join(rest)
    } else if s.starts_with('/') {
        PathBuf::from(&s)
    } else {
        // Relative — resolve against the provided base directory.
        let cwd = base?;
        PathBuf::from(cwd).join(s.strip_prefix("./").unwrap_or(&s))
    };

    let canon = std::fs::canonicalize(&path).ok()?;
    Some(canon.to_string_lossy().into_owned())
}
