//! BYOK (bring-your-own-key) storage for AI provider API keys.
//!
//! Keys are stored in a single JSON file in the app's private config dir
//! (`byok-keys.json`, `0600` on unix). We deliberately do NOT use the OS
//! keychain: on macOS an unsigned / frequently-rebuilt binary triggers a
//! Keychain permission prompt on *every* access, which is unusable. The config
//! dir is already app-private; this keeps key access prompt-free.
//!
//! The frontend only ever receives metadata via `byok_list` (provider + last-4
//! + added-at); the raw key is returned solely by `byok_get`, which the
//! Model-Chat runtime calls to configure the AI SDK provider.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Stored record for one provider (key + display metadata).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredKey {
    key: String,
    last4: String,
    added_at: String,
}

type Store = BTreeMap<String, StoredKey>;

/// Non-secret per-provider metadata the UI reads (no key material).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeyMeta {
    pub provider: String,
    pub last4: String,
    pub added_at: String,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    Ok(dir.join("byok-keys.json"))
}

fn read_store(app: &AppHandle) -> Store {
    store_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_store(app: &AppHandle, store: &Store) -> Result<(), String> {
    let path = store_path(app)?;
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    // Best-effort lock down to owner-only on unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// List configured providers (metadata only — no secrets).
#[tauri::command]
pub fn byok_list(app: AppHandle) -> Vec<ProviderKeyMeta> {
    read_store(&app)
        .into_iter()
        .map(|(provider, v)| ProviderKeyMeta {
            provider,
            last4: v.last4,
            added_at: v.added_at,
        })
        .collect()
}

/// Store/replace a provider's API key + metadata. `last4` is computed by the
/// frontend so we never have to slice the key here.
#[tauri::command]
pub fn byok_set(
    app: AppHandle,
    provider: String,
    key: String,
    last4: String,
    added_at: String,
) -> Result<(), String> {
    let mut store = read_store(&app);
    store.insert(provider, StoredKey { key, last4, added_at });
    write_store(&app, &store)
}

/// Remove a provider's key.
#[tauri::command]
pub fn byok_delete(app: AppHandle, provider: String) -> Result<(), String> {
    let mut store = read_store(&app);
    store.remove(&provider);
    write_store(&app, &store)
}

/// Read a provider's actual key (for the Model-Chat runtime). `None` if unset.
#[tauri::command]
pub fn byok_get(app: AppHandle, provider: String) -> Result<Option<String>, String> {
    Ok(read_store(&app).get(&provider).map(|v| v.key.clone()))
}
