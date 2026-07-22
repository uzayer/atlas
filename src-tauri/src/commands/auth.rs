//! Tauri adapters over [`crate::auth::AuthCore`].
//!
//! Thin by design: translate arguments, spawn the poll task, emit events. Every
//! decision worth testing lives in `crate::auth`, which is why there are no
//! tests here — this layer holds no logic of its own.
//!
//! Events emitted to the frontend:
//!   `atlas:auth-changed` — the full [`AuthSnapshot`], on every transition
//!   `atlas:auth-error`   — `{ message }` when a grant ends without a token
//!
//! Both go out via `app.emit`, which broadcasts to **every** window, so a
//! multi-window install always agrees about who is signed in.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::auth::{auth_base, AuthCore, AuthSnapshot, GrantError};

/// Managed handle to the auth core.
pub struct AuthState {
    core: Arc<AuthCore>,
}

impl AuthState {
    pub fn new(config_dir: std::path::PathBuf) -> Self {
        Self {
            core: Arc::new(AuthCore::new(
                auth_base(),
                config_dir,
                reqwest::Client::new(),
            )),
        }
    }

    pub fn core(&self) -> Arc<AuthCore> {
        Arc::clone(&self.core)
    }
}

fn broadcast(app: &AppHandle, snapshot: AuthSnapshot) {
    let _ = app.emit("atlas:auth-changed", snapshot);
}

/// Current account state. Carries no credential — see [`AuthSnapshot`].
#[tauri::command]
pub fn auth_snapshot(state: State<'_, AuthState>) -> AuthSnapshot {
    state.core().snapshot()
}

/// Begin (or resume) sign-in.
///
/// Opens the approval page in the system browser and polls in the background.
/// Returns immediately with the `connecting` snapshot so the dialog can render
/// while the human is still in the browser.
#[tauri::command]
pub async fn auth_sign_in(
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<AuthSnapshot, String> {
    let core = state.core();

    let grant = core
        .start_grant()
        .await
        .map_err(|e| e.user_message())?;

    // The verification URI comes off the wire — never constructed here, so the
    // desktop stays ignorant of the web app's routing.
    let _ = app
        .opener()
        .open_url(grant.verification_uri_complete.clone(), None::<&str>);

    let snapshot = core.snapshot();
    broadcast(&app, snapshot.clone());

    // Poll off the command so the frontend is not blocked for up to 10 minutes.
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        match core.run_grant(&grant).await {
            Ok(()) => {
                broadcast(&task_app, core.snapshot());
                raise(&task_app);
            }
            // Cancellation is a deliberate user action; it needs no error toast.
            Err(GrantError::Cancelled) => broadcast(&task_app, core.snapshot()),
            Err(err) => {
                broadcast(&task_app, core.snapshot());
                let _ = task_app.emit(
                    "atlas:auth-error",
                    serde_json::json!({ "message": err.user_message() }),
                );
            }
        }
    });

    Ok(snapshot)
}

/// Abandon an in-flight grant. Idempotent.
#[tauri::command]
pub fn auth_cancel_sign_in(app: AppHandle, state: State<'_, AuthState>) -> AuthSnapshot {
    let core = state.core();
    core.cancel_grant();
    let snapshot = core.snapshot();
    broadcast(&app, snapshot.clone());
    snapshot
}

/// Bring Atlas forward once approval lands, so the human does not have to hunt
/// for the window they left behind in the browser.
fn raise(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Validate any stored credential at startup, then broadcast the result.
///
/// Preserves the credential on every failure for now — see
/// [`AuthCore::validate_stored`].
pub fn restore_on_launch(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let core = app.state::<AuthState>().core();
        let snapshot = core.validate_stored().await;
        broadcast(&app, snapshot);
    });
}
