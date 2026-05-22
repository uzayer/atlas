//! Tauri command surface for the Rust-owned `AppState`.

use tauri::{AppHandle, State};

use crate::state::{AppState, AppStateHandle};

/// One-shot bootstrap: returns the full `AppState` snapshot. Called by the
/// frontend exactly once on app mount, before any UI that depends on
/// `currentProject` / `recentProjects` renders.
#[tauri::command]
pub fn bootstrap_app_state(state: State<'_, AppStateHandle>) -> AppState {
    state.lock().clone()
}

/// Replace the in-memory snapshot and persist it to disk. The disk write runs
/// on a background thread so the IPC reply isn't blocked on fsync — this
/// command resolves as soon as the in-memory state is updated. For the
/// frontend's purposes, that's "saved" — the on-disk copy converges within
/// milliseconds and is only needed on the next app launch.
#[tauri::command]
pub fn save_app_state(
    payload: AppState,
    state: State<'_, AppStateHandle>,
    app: AppHandle,
) -> Result<(), String> {
    {
        let mut guard = state.lock();
        *guard = payload;
    }
    let snapshot = state.lock().clone();
    std::thread::spawn(move || {
        if let Err(e) = AppState::save(&app, &snapshot) {
            tracing::warn!(target: "atlas::app_state", "save failed: {e}");
        }
    });
    Ok(())
}
