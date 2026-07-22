//! Atlas account authentication (ATL-35).
//!
//! The desktop is an untrusted OAuth client: it has no cookie and no redirect
//! URI, so it connects via the **OAuth 2.0 Device Authorization Grant**
//! (RFC 8628) — show a code, let the human approve it in a real browser, poll
//! for the result. See `docs/api/atlas-auth-api.md` §7 in the server repo.
//!
//! Everything here is deliberately free of Tauri types. The whole module is
//! driven through [`AuthCore`], constructed from an auth base URL, a config
//! directory, and an HTTP client — which is what lets the tests point it at a
//! stub server on loopback with a temporary directory and exercise the real
//! client, the real poll loop, and the real file I/O. The Tauri commands in
//! `commands::auth` are thin adapters that translate and emit events.
//!
//! **Token material never leaves this module.** The session token is the user's
//! whole account, and the renderer runs with no CSP while displaying
//! agent-authored markdown, so neither the session token nor the access JWT is
//! ever handed across the IPC boundary — the frontend receives [`AuthSnapshot`],
//! which carries no credentials. Nothing here logs a token or a device code.

mod config;
mod core;
mod store;

pub use config::auth_base;
pub use core::{AuthCore, GrantError};

use serde::Serialize;

/// What the frontend is allowed to know about the account.
///
/// Deliberately carries no credential. There is also no "verifying" variant:
/// whether the stored session has been revalidated against the server is an
/// implementation concern, and surfacing it would put a spinner in the title
/// bar every time a laptop lid opens, which only teaches people to ignore it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum AuthSnapshot {
    /// No credential stored.
    SignedOut,
    /// A device grant is in flight and awaiting approval in the browser.
    #[serde(rename_all = "camelCase")]
    Connecting {
        /// Shown only behind the dialog's "enter the code manually" disclosure.
        /// A display string, not a secret — the `device_code` is the secret and
        /// never leaves Rust.
        user_code: String,
        /// The *plain* approval URL, for the manual fallback. The pre-filled
        /// variant stays in Rust: the browser is opened from there, so the
        /// frontend never needs it.
        verification_uri: String,
        /// ISO-8601. The dialog uses this to stop offering a dead code.
        expires_at: String,
    },
    /// A credential is held. ATL-47 adds the user identity to this variant.
    SignedIn,
}

#[cfg(test)]
mod tests;
