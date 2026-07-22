//! Where the desktop talks to.
//!
//! Resolution order, highest priority first:
//!   1. env `ATLAS_AUTH_URL` — how a developer points at `wrangler dev`.
//!   2. compile-time `option_env!("ATLAS_AUTH_URL")` — staging builds.
//!   3. the production auth host.
//!
//! The telemetry module has a similar ladder with a `<config_dir>/*.json` rung
//! in the middle. That rung is **deliberately absent here**: a persistent
//! on-disk override of the *sign-in* host is a phishing foothold in a way an
//! analytics host is not — one stray file write and every future sign-in goes
//! to an attacker. An environment variable at least requires code execution in
//! the user's session at launch time.

/// Production auth worker. Desktop talks to it directly; the browser half of
/// the device grant happens on the web origin, whose URL the server hands back
/// in the grant response (never constructed here).
const DEFAULT_AUTH_BASE: &str = "https://auth.tryatlas.cc/api/auth";

/// Baked in at build time for staging/QA builds. `None` in ordinary builds.
const BUILD_AUTH_BASE: Option<&str> = option_env!("ATLAS_AUTH_URL");

/// The auth API base, with no trailing slash.
pub fn auth_base() -> String {
    let raw = std::env::var("ATLAS_AUTH_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| BUILD_AUTH_BASE.map(str::to_string))
        .unwrap_or_else(|| DEFAULT_AUTH_BASE.to_string());
    normalize(&raw)
}

/// Trim whitespace and any trailing slashes so callers can always append
/// `/device/code` and friends without doubling the separator.
pub(crate) fn normalize(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_string()
}
