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

/// Who the credential belongs to, as of the last successful profile fetch.
///
/// This is what makes an offline launch render a *complete* signed-in state —
/// a face and a name — rather than a half-populated one. Refreshed on every
/// successful validation, so a name or photo changed on the web reaches the
/// desktop on the next launch.
///
/// ATL-51 adds the organisation list and active organisation alongside it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredIdentity {
    pub id: String,
    pub name: String,
    pub email: String,
    /// The remote photo URL last seen on the profile. Kept **only** to decide
    /// whether the cache is stale: a URL that still matches means the bytes on
    /// disk are still the right bytes, so a launch costs no request to Google
    /// or GitHub. It is never handed to the frontend — that would put the
    /// per-launch request back, one `<img src>` away.
    pub avatar_url: Option<String>,
    /// Absolute path to the cached photo. `None` when the user has no photo or
    /// the fetch failed; the UI falls back to initials either way.
    pub avatar_path: Option<String>,
}

/// The persisted credential, plus who it belongs to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    /// Better Auth session token. The long-lived credential — 7-day rolling,
    /// and able to mint access tokens for every organisation the user is in.
    pub session_token: String,
    /// ISO-8601, for diagnostics only. Expiry is the server's business.
    pub saved_at: String,
    /// Absent until the first profile fetch succeeds. That window is real: a
    /// connectivity blip between approval and the profile call leaves a valid
    /// credential with nobody's name attached, and losing the credential over
    /// that would be far worse than showing a generic icon until the next
    /// launch refreshes it.
    #[serde(default)]
    pub identity: Option<StoredIdentity>,
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
