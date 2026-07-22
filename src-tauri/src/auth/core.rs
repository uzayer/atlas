//! The device grant, the poll loop, and credential lifecycle.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::Deserialize;

use super::store::{self, StoredSession};
use super::AuthSnapshot;

/// RFC 8628 `client_id` for this app, matching the server's device plugin.
const CLIENT_ID: &str = "atlas-desktop";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Floor on the poll interval so a misbehaving or hostile server cannot make us
/// hammer it. The server normally says 5s.
const MIN_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// A grant awaiting approval in the browser.
#[derive(Debug, Clone)]
pub struct PendingGrant {
    /// The secret the desktop polls with. Never leaves Rust, never logged.
    pub device_code: String,
    /// The short human-readable code. A display string, not a secret.
    pub user_code: String,
    pub verification_uri: String,
    /// Pre-fills the code, so the happy path needs no typing at all.
    pub verification_uri_complete: String,
    pub expires_at: SystemTime,
    pub interval: Duration,
    /// Flipped by `cancel_grant`; the loop checks it between polls.
    cancel: Arc<AtomicBool>,
}

impl PendingGrant {
    fn expired(&self) -> bool {
        SystemTime::now() >= self.expires_at
    }
}

/// One poll of `/device/token`, classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    /// Approved. Carries the Better Auth session token.
    Token(String),
    /// Not approved yet — keep going at the current interval.
    Pending,
    /// Polled too fast; RFC 8628 says add 5 seconds.
    SlowDown,
    /// The human pressed Deny.
    Denied,
    /// The code aged out server-side.
    Expired,
    /// We learned nothing: network error, 5xx, or an unparseable body. NOT a
    /// reason to end the grant — see `run_grant`.
    Transient,
}

/// Why a grant ended without a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantError {
    Denied,
    Expired,
    Cancelled,
    /// Could not even start the grant.
    Start(String),
}

impl GrantError {
    /// Message for the connecting dialog.
    pub fn user_message(&self) -> String {
        match self {
            GrantError::Denied => "Connection denied in the browser.".into(),
            GrantError::Expired => "That code expired. Get a new one to try again.".into(),
            GrantError::Cancelled => "Sign-in cancelled.".into(),
            GrantError::Start(e) => format!("Could not reach Atlas: {e}"),
        }
    }
}

/// The auth module's whole public surface.
pub struct AuthCore {
    base: String,
    dir: PathBuf,
    http: reqwest::Client,
    /// At most one grant in flight. Guards against a double-click minting two
    /// competing codes, and is what makes a second click *resume* rather than
    /// restart — the recovery path for someone who got lost mid-flow.
    pending: Mutex<Option<PendingGrant>>,
}

impl AuthCore {
    pub fn new(base: impl Into<String>, dir: impl Into<PathBuf>, http: reqwest::Client) -> Self {
        Self {
            base: super::config::normalize(&base.into()),
            dir: dir.into(),
            http,
            pending: Mutex::new(None),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    // ---- credential ----------------------------------------------------

    pub fn stored(&self) -> Option<StoredSession> {
        store::load(&self.dir)
    }

    pub fn clear_session(&self) -> Result<(), String> {
        store::clear(&self.dir)
    }

    fn persist(&self, session_token: &str) -> Result<(), String> {
        store::save(
            &self.dir,
            &StoredSession {
                session_token: session_token.to_string(),
                saved_at: chrono::Utc::now().to_rfc3339(),
            },
        )
    }

    /// What the frontend may see.
    pub fn snapshot(&self) -> AuthSnapshot {
        if let Some(p) = self.pending.lock().ok().and_then(|g| g.clone()) {
            if !p.expired() {
                return AuthSnapshot::Connecting {
                    user_code: p.user_code,
                    verification_uri: p.verification_uri,
                    expires_at: chrono::DateTime::<chrono::Utc>::from(p.expires_at).to_rfc3339(),
                };
            }
        }
        if self.stored().is_some() {
            AuthSnapshot::SignedIn
        } else {
            AuthSnapshot::SignedOut
        }
    }

    // ---- device grant --------------------------------------------------

    /// Begin a grant, or hand back the one already in flight.
    ///
    /// Reuse is load-bearing rather than an optimisation: a first-run user who
    /// has to sign in on the web often loses their way back, and clicking the
    /// account button again must return them to the *same* approval page —
    /// now with a browser session in hand — instead of stranding a fresh code.
    pub async fn start_grant(&self) -> Result<PendingGrant, GrantError> {
        if let Some(existing) = self.pending.lock().ok().and_then(|g| g.clone()) {
            if !existing.expired() && !existing.cancel.load(Ordering::SeqCst) {
                return Ok(existing);
            }
        }

        let res = self
            .http
            .post(self.url("/device/code"))
            .json(&serde_json::json!({ "client_id": CLIENT_ID }))
            .send()
            .await
            .map_err(|e| GrantError::Start(redact(&e.to_string())))?;

        if !res.status().is_success() {
            return Err(GrantError::Start(format!("server said {}", res.status())));
        }

        let body: DeviceCodeResponse = res
            .json()
            .await
            .map_err(|e| GrantError::Start(format!("unreadable response: {e}")))?;

        let grant = PendingGrant {
            device_code: body.device_code,
            user_code: body.user_code,
            verification_uri: body.verification_uri,
            verification_uri_complete: body.verification_uri_complete,
            expires_at: SystemTime::now() + Duration::from_secs(body.expires_in.max(1)),
            interval: Duration::from_secs(body.interval).max(MIN_POLL_INTERVAL),
            cancel: Arc::new(AtomicBool::new(false)),
        };

        if let Ok(mut slot) = self.pending.lock() {
            *slot = Some(grant.clone());
        }
        Ok(grant)
    }

    /// Abandon the in-flight grant, if any. Idempotent.
    pub fn cancel_grant(&self) {
        if let Ok(mut slot) = self.pending.lock() {
            if let Some(p) = slot.as_ref() {
                p.cancel.store(true, Ordering::SeqCst);
            }
            *slot = None;
        }
    }

    /// One poll, classified. Anything we cannot interpret is `Transient` —
    /// "we do not know" is never the same as "no".
    pub async fn poll_once(&self, device_code: &str) -> PollOutcome {
        let res = self
            .http
            .post(self.url("/device/token"))
            .json(&serde_json::json!({
                "grant_type": DEVICE_GRANT,
                "device_code": device_code,
                "client_id": CLIENT_ID,
            }))
            .send()
            .await;

        let Ok(res) = res else {
            return PollOutcome::Transient;
        };

        if res.status().is_server_error() {
            return PollOutcome::Transient;
        }

        if res.status().is_success() {
            return match res.json::<DeviceTokenSuccess>().await {
                Ok(b) if !b.access_token.is_empty() => PollOutcome::Token(b.access_token),
                _ => PollOutcome::Transient,
            };
        }

        match res.json::<DeviceTokenError>().await {
            Ok(b) => match b.error.as_str() {
                "authorization_pending" => PollOutcome::Pending,
                "slow_down" => PollOutcome::SlowDown,
                "access_denied" => PollOutcome::Denied,
                "expired_token" => PollOutcome::Expired,
                _ => PollOutcome::Transient,
            },
            Err(_) => PollOutcome::Transient,
        }
    }

    /// Drive the grant to a conclusion, persisting the token on success.
    ///
    /// Transient failures deliberately do **not** end the grant: a two-second
    /// wifi blip must not discard an approval the human has already given in
    /// the browser. They simply cost one poll, and the 10-minute server-side
    /// deadline still bounds the whole thing.
    pub async fn run_grant(&self, grant: &PendingGrant) -> Result<(), GrantError> {
        let mut interval = grant.interval;

        loop {
            if grant.cancel.load(Ordering::SeqCst) {
                return Err(GrantError::Cancelled);
            }
            if grant.expired() {
                self.finish();
                return Err(GrantError::Expired);
            }

            tokio::time::sleep(interval).await;

            if grant.cancel.load(Ordering::SeqCst) {
                return Err(GrantError::Cancelled);
            }

            match self.poll_once(&grant.device_code).await {
                PollOutcome::Token(token) => {
                    self.persist(&token).map_err(GrantError::Start)?;
                    self.finish();
                    return Ok(());
                }
                PollOutcome::Pending | PollOutcome::Transient => continue,
                PollOutcome::SlowDown => {
                    interval += Duration::from_secs(5);
                    continue;
                }
                PollOutcome::Denied => {
                    self.finish();
                    return Err(GrantError::Denied);
                }
                PollOutcome::Expired => {
                    self.finish();
                    return Err(GrantError::Expired);
                }
            }
        }
    }

    /// Clear the pending slot without signalling cancellation (the grant is
    /// over on its own terms).
    fn finish(&self) {
        if let Ok(mut slot) = self.pending.lock() {
            *slot = None;
        }
    }

    // ---- token ----------------------------------------------------------

    /// Mint a short-TTL access JWT from the stored session token.
    ///
    /// `Ok(None)` means the server authoritatively rejected the credential
    /// (401). `Err` means we could not find out — the caller must treat those
    /// completely differently, which is what ATL-48 formalises.
    pub async fn mint_access_token(&self) -> Result<Option<String>, String> {
        let Some(stored) = self.stored() else {
            return Ok(None);
        };

        let res = self
            .http
            .get(self.url("/token"))
            .bearer_auth(&stored.session_token)
            .send()
            .await
            .map_err(|e| redact(&e.to_string()))?;

        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Ok(None);
        }
        if !res.status().is_success() {
            return Err(format!("token mint failed: {}", res.status()));
        }

        #[derive(Deserialize)]
        struct TokenResponse {
            token: String,
        }
        let body: TokenResponse = res.json().await.map_err(|e| e.to_string())?;
        Ok(Some(body.token))
    }

    /// Boot check.
    ///
    /// **Preserves the credential on every failure, including 401.** ATL-48
    /// introduces the authoritative-401-signs-you-out rule; until it lands the
    /// safe default is to keep a credential we are unsure about. The worst case
    /// here is a stale signed-in state, never a destroyed valid session — which
    /// is the right way round if that ticket slips.
    pub async fn validate_stored(&self) -> AuthSnapshot {
        if self.stored().is_none() {
            return AuthSnapshot::SignedOut;
        }
        let _ = self.mint_access_token().await;
        AuthSnapshot::SignedIn
    }
}

/// Strip anything that could carry a credential out of an error string before
/// it reaches a log or the UI. `reqwest` puts the request URL in its errors,
/// and a URL is the one place a token could plausibly appear.
fn redact(message: &str) -> String {
    match message.find(" for url") {
        Some(i) => message[..i].to_string(),
        None => message.to_string(),
    }
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct DeviceTokenSuccess {
    access_token: String,
}

#[derive(Deserialize)]
struct DeviceTokenError {
    error: String,
}
