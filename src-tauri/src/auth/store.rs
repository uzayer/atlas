//! On-disk credential storage.
//!
//! The session token lives in `atlas-session.json` in the app's private config
//! directory, mode `0600`, in **its own file** separate from `byok-keys.json`
//! so that signing out is a single unlink.
//!
//! ## Why not the OS keychain
//!
//! `docs/api/atlas-auth-api.md` §12.5 says to put this in the keychain. We
//! knowingly do not, for the same reason `commands::byok` does not: on macOS an
//! unsigned, frequently-rebuilt binary prompts for keychain permission on
//! *every* access. `tauri.conf.json` sets no signing identity, and the
//! auto-updater replaces the binary on every release — which invalidates the
//! keychain ACL and would re-prompt every user after every update. Keychain is
//! therefore *worse* in release than in development here.
//!
//! Revisit once a real Developer ID signing identity is configured; that also
//! fixes the auto-update ACL problem.
//!
//! The access JWT is never written here — it is minted on demand and held in
//! memory only.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// File name inside the app config directory.
const SESSION_FILE: &str = "atlas-session.json";

/// The persisted credential.
///
/// ATL-47 grows this with the identity snapshot (name, email, avatar, orgs) so
/// an offline launch can render a complete signed-in state rather than a
/// half-populated one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    /// Better Auth session token. The long-lived credential — 7-day rolling,
    /// and able to mint access tokens for every organisation the user is in.
    pub session_token: String,
    /// ISO-8601, for diagnostics only. Expiry is the server's business.
    pub saved_at: String,
}

pub(crate) fn session_path(dir: &Path) -> PathBuf {
    dir.join(SESSION_FILE)
}

/// Read the stored credential. `None` when absent or unreadable — a corrupt
/// file is treated as "signed out" rather than an error, since the recovery is
/// the same either way and there is nothing useful to tell the user.
pub(crate) fn load(dir: &Path) -> Option<StoredSession> {
    let raw = fs::read_to_string(session_path(dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Write the credential, owner-only.
pub(crate) fn save(dir: &Path, session: &StoredSession) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create config dir: {e}"))?;
    let path = session_path(dir);
    let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("write session: {e}"))?;
    restrict(&path);
    Ok(())
}

/// Remove the credential. Absent is success — sign-out must be idempotent and
/// must never fail on a machine that was already signed out.
pub(crate) fn clear(dir: &Path) -> Result<(), String> {
    match fs::remove_file(session_path(dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("clear session: {e}")),
    }
}

/// Best-effort owner-only permissions.
#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}
