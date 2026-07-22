//! The device grant, the poll loop, and the credential and identity lifecycle.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::Deserialize;

use super::store::{self, StoredIdentity, StoredSession};
use super::{avatar, AuthSnapshot};

/// RFC 8628 `client_id` for this app, matching the server's device plugin.
const CLIENT_ID: &str = "atlas-desktop";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Floor on the poll interval so a misbehaving or hostile server cannot make us
/// hammer it. The server normally says 5s.
const MIN_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Ceiling on an authenticated call. The shared `reqwest::Client` carries no
/// default, and one of these sits on the sign-in path between approval and the
/// dialog closing: a server that accepts the connection and then never answers
/// would otherwise leave "Continue in your browser…" on screen forever, long
/// after the credential was safely written.
const AUTHED_TIMEOUT: Duration = Duration::from_secs(10);

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

    /// Write a freshly granted credential, deliberately with **no identity**.
    ///
    /// A new grant can be a different person, so carrying the old snapshot over
    /// would show one user another user's name until the profile call returned.
    /// [`Self::refresh_identity`] fills it in a moment later.
    fn persist(&self, session_token: &str) -> Result<(), String> {
        store::save(
            &self.dir,
            &StoredSession {
                session_token: session_token.to_string(),
                saved_at: chrono::Utc::now().to_rfc3339(),
                identity: None,
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
        match self.stored() {
            Some(session) => AuthSnapshot::SignedIn {
                user: session.identity.map(Into::into),
            },
            None => AuthSnapshot::SignedOut,
        }
    }

    // ---- identity --------------------------------------------------------

    /// Read the signed-in user from the server.
    ///
    /// `Ok(None)` is the server saying nobody is signed in — note that
    /// `/get-session` expresses that as **200 with a `null` body**, not a 401
    /// (proven in ATL-44), so status alone would never see it.
    async fn fetch_profile(&self) -> Result<Option<Profile>, String> {
        let Some(res) = self.authed_get("/get-session").await? else {
            return Ok(None);
        };

        let body = res.text().await.map_err(|e| redact(&e.to_string()))?;
        if body.trim().is_empty() || body.trim() == "null" {
            return Ok(None);
        }
        let session: SessionResponse = serde_json::from_str(&body)
            .map_err(|e| format!("unreadable profile: {e}"))?;
        Ok(Some(session.user))
    }

    /// Pull the profile and write it onto the stored credential.
    ///
    /// Silent about every failure on purpose: this runs on the boot path behind
    /// an already-rendered signed-in title bar, and a photo or a stale display
    /// name is never worth a toast, let alone touching the credential.
    ///
    /// `previous` is the identity being replaced — it supplies the avatar cache
    /// key, and is what lets an unchanged photo cost zero requests.
    async fn refresh_identity(&self, previous: Option<StoredIdentity>) {
        let Ok(Some(profile)) = self.fetch_profile().await else {
            return;
        };
        // Re-read rather than reusing an earlier load: the profile call is a
        // network round trip, and a sign-out during it must not be undone here.
        let Some(current) = self.stored() else {
            return;
        };

        let held = previous
            .map(|p| avatar::CachedAvatar::new(p.avatar_url, p.avatar_path))
            .unwrap_or_default();
        // Writes back the *pair* — a failed fetch returns the previous one
        // untouched, so a blip never trades a known-good photo for initials.
        let avatar =
            avatar::resolve(&self.http, &self.dir, profile.image.as_deref(), &held).await;

        let _ = store::save(
            &self.dir,
            &StoredSession {
                identity: Some(StoredIdentity {
                    id: profile.id,
                    name: profile.name,
                    email: profile.email,
                    avatar_url: avatar.url,
                    avatar_path: avatar.path,
                }),
                ..current
            },
        );
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
                    // Captured before the write: a new grant may be a different
                    // person, and this is what lets the avatar cache prune the
                    // previous user's photo and skip a re-fetch for the same.
                    let previous = self.stored().and_then(|s| s.identity);
                    self.persist(&token).map_err(GrantError::Start)?;
                    self.finish();
                    // Inline rather than spawned, so the single state broadcast
                    // the caller emits already carries the user's name and face.
                    // The alternative flashes a nameless signed-in title bar on
                    // every sign-in to save a few hundred milliseconds behind a
                    // spinner the user is already watching.
                    self.refresh_identity(previous).await;
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

    /// A GET carrying the stored session token as a Bearer.
    ///
    /// Every authenticated call goes through here so the distinction the whole
    /// module turns on is written **once**: `Ok(None)` is the server looking at
    /// the credential and rejecting it, `Err` is us never finding out. Conflating
    /// them is what signs people out for opening a laptop on a plane, and ATL-48
    /// builds its retry policy directly on the split.
    async fn authed_get(&self, path: &str) -> Result<Option<reqwest::Response>, String> {
        let Some(stored) = self.stored() else {
            return Ok(None);
        };

        let res = self
            .http
            .get(self.url(path))
            .bearer_auth(&stored.session_token)
            .timeout(AUTHED_TIMEOUT)
            .send()
            .await
            .map_err(|e| redact(&e.to_string()))?;

        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Ok(None);
        }
        if !res.status().is_success() {
            // The path, never the response body: an error body from an auth
            // server is the one place a token could plausibly be echoed back.
            return Err(format!("{path} failed: {}", res.status()));
        }
        Ok(Some(res))
    }

    /// Mint a short-TTL access JWT from the stored session token.
    pub async fn mint_access_token(&self) -> Result<Option<String>, String> {
        let Some(res) = self.authed_get("/token").await? else {
            return Ok(None);
        };

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
        let Some(current) = self.stored() else {
            return AuthSnapshot::SignedOut;
        };
        let _ = self.mint_access_token().await;
        // Every successful validation refreshes the snapshot, so a name or photo
        // changed on the web reaches the desktop without a re-sign-in. A failed
        // one leaves the last-known identity in place — which is the whole point
        // of persisting it, and is what makes an offline launch render a
        // complete title bar rather than a nameless one.
        self.refresh_identity(current.identity).await;
        self.snapshot()
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

/// `GET /get-session`. The session half is ignored — expiry is the server's
/// business, and nothing here is improved by a second opinion on it.
#[derive(Deserialize)]
struct SessionResponse {
    user: Profile,
}

#[derive(Deserialize)]
struct Profile {
    id: String,
    name: String,
    email: String,
    /// The provider photo URL. Absent for a user who set none.
    image: Option<String>,
}

#[derive(Deserialize)]
struct DeviceTokenError {
    error: String,
}
