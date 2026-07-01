//! Tauri command surface for telemetry. The heavy lifting lives in
//! `crate::telemetry`; these just expose the managed `TelemetryClient` to the
//! renderer so it can (a) bootstrap `posthog-js` with the same anonymous id and
//! resolved key/host, (b) flip the live opt-in gate when the user toggles the
//! setting, and (c) optionally route an event through Rust.

use std::sync::Arc;

use serde_json::Value;
use tauri::State;

use crate::telemetry::{TelemetryClient, TelemetryConfig};

/// Non-secret config for the frontend's `posthog-js` bootstrap (enabled flag,
/// host, anonymous distinct id, and the write-only project key).
#[tauri::command]
pub fn telemetry_config(client: State<'_, Arc<TelemetryClient>>) -> TelemetryConfig {
    client.config()
}

/// Flip the live opt-in gate (mirrors the persisted `share_telemetry` setting,
/// which the frontend saves via `save_app_state`). Records a single
/// opt-in/opt-out event at the boundary.
#[tauri::command]
pub fn telemetry_set_enabled(enabled: bool, client: State<'_, Arc<TelemetryClient>>) {
    client.set_enabled(enabled);
}

/// Escape hatch so the frontend can route a metadata-only event through the
/// Rust emitter (primary frontend path is `posthog-js` direct). No-op unless
/// telemetry is enabled. Callers must pass **metadata only** — this is the same
/// contract as every Rust call site.
#[tauri::command]
pub fn telemetry_capture(
    event: String,
    properties: Option<Value>,
    client: State<'_, Arc<TelemetryClient>>,
) {
    client.capture(&event, properties.unwrap_or_else(|| serde_json::json!({})));
}
