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
