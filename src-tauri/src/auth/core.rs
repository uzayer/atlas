//! The device grant, the poll loop, and the credential and identity lifecycle.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::Deserialize;

use super::backoff::{self, Backoff};
use super::store::{self, Role, StoredIdentity, StoredOrg, StoredSession};
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

/// Why an authenticated call produced no value (ATL-48).
///
/// This is the failure classification the whole module turns on, and the reason
/// it is an enum rather than a `String`: a caller that cannot see the class
/// cannot avoid the mistake this ticket exists to prevent, which is treating
/// "the server never answered" as "the server said no". **Only [`Rejected`] may
/// ever clear the credential.**
///
/// [`Rejected`]: AuthFailure::Rejected
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthFailure {
    /// Nothing stored to authenticate with. Not a failure — there was simply
    /// nothing to ask about, and no request was made.
    NoCredential,
    /// **AUTHORITATIVE (401).** The server looked at the credential and
    /// rejected it. The session is dead and no amount of retrying revives it.
    Rejected,
    /// **DENIED (403).** The credential is valid; this particular action is
    /// not permitted. Neither sign out nor retry.
    ///
    /// Every other unexpected 4xx joins this class rather than earning a fourth
    /// one: a 400 or a 404 is not a verdict on the credential either, and
    /// repeating the request will not change it — which is exactly how this
    /// class is handled.
    Denied,
    /// **INDETERMINATE.** Transport failure, timeout, DNS failure, 5xx, or 429.
    /// We learned *nothing* about the credential, so everything is preserved
    /// and the call is retried on the schedule in [`super::backoff`].
    Indeterminate {
        /// From the response's `Retry-After`, when the server supplied one.
        retry_after: Option<Duration>,
        /// For logs. Carries no URL and no token — see [`redact`].
        reason: String,
    },
}

impl AuthFailure {
    fn indeterminate(reason: impl Into<String>) -> Self {
        AuthFailure::Indeterminate {
            retry_after: None,
            reason: reason.into(),
        }
    }
}

/// An authenticated call: a value, or a classified failure.
pub type Authed<T> = Result<T, AuthFailure>;

/// What one validation of the stored credential settled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Validation {
    /// Nothing stored. Signed out, and no network call was made.
    NoCredential,
    /// The server accepted the credential; the identity snapshot was refreshed.
    Confirmed,
    /// **401.** The credential and its snapshot have been cleared.
    Rejected,
    /// **403.** Nothing was changed and nothing will be retried.
    Denied,
    /// We learned nothing. Everything is preserved; the caller retries.
    Indeterminate {
        /// Honoured by the backoff when present — see [`Backoff::next_after`].
        retry_after: Option<Duration>,
    },
}

/// The credential a completed sign-out has already cleared, kept just long
/// enough to tell the server about it (ATL-50).
///
/// The ordering the ticket exists for is written as a type rather than a
/// comment: the only way to obtain one is to have *already* cleared the local
/// state, so no caller can revoke first and clear second — the mistake that
/// makes sign-out fail exactly when someone closing a borrowed laptop most
/// needs it to work. [`AuthCore::revoke`] then consumes it, so "fired once and
/// forgotten" is not a discipline anyone has to keep either: there is no second
/// ticket to retry with.
pub struct RevocationTicket(String);

impl std::fmt::Debug for RevocationTicket {
    /// Hand-written because this is the one type here whose entire content is a
    /// credential; a derived `Debug` would put the user's session into any log
    /// line that ever formatted a struct holding one.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RevocationTicket(<redacted>)")
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
    /// First retry delay for [`Self::revalidate`]. A field only so tests can
    /// exercise the loop without sleeping through a real schedule; production
    /// always uses [`backoff::BASE`].
    backoff_base: Duration,
}

impl AuthCore {
    pub fn new(base: impl Into<String>, dir: impl Into<PathBuf>, http: reqwest::Client) -> Self {
        Self {
            base: super::config::normalize(&base.into()),
            dir: dir.into(),
            http,
            pending: Mutex::new(None),
            backoff_base: backoff::BASE,
        }
    }

    /// Shrink the retry schedule so a test can drive the loop through several
    /// failures in milliseconds. Absent from the shipped binary by
    /// construction, so no production path can reach for it.
    #[cfg(test)]
    pub fn with_backoff_base(mut self, base: Duration) -> Self {
        self.backoff_base = base;
        self
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
            Some(session) => {
                let identity = session.identity;
                AuthSnapshot::SignedIn {
                    orgs: identity.as_ref().and_then(|i| {
                        i.orgs
                            .as_ref()
                            .map(|orgs| orgs.iter().cloned().map(Into::into).collect())
                    }),
                    active_org_id: identity.as_ref().and_then(StoredIdentity::active_org),
                    user: identity.map(Into::into),
                }
            }
            None => AuthSnapshot::SignedOut,
        }
    }

    // ---- identity --------------------------------------------------------

    /// Read the signed-in user from the server.
    ///
    /// `Ok(None)` is the server saying nobody is signed in — note that
    /// `/get-session` expresses that as **200 with a `null` body**, not a 401
    /// (proven in ATL-44), so status alone would never see it. It is reported
    /// rather than classified: [`Self::validate_once`] takes its verdict from
    /// `/token` instead, and this call only ever decides a name, a photo, and
    /// which organisation was last made active.
    async fn fetch_profile(&self) -> Authed<Option<SessionResponse>> {
        let res = self.authed_get("/get-session").await?;

        let body = res
            .text()
            .await
            .map_err(|e| AuthFailure::indeterminate(redact(&e.to_string())))?;
        if body.trim().is_empty() || body.trim() == "null" {
            return Ok(None);
        }
        let session: SessionResponse = serde_json::from_str(&body)
            .map_err(|e| AuthFailure::indeterminate(format!("unreadable profile: {e}")))?;
        Ok(Some(session))
    }

    /// Every organisation the user belongs to, with the role they hold in each
    /// (ATL-51).
    ///
    /// Two calls, because neither answers alone: `/organization/list` has the
    /// names and no roles, and the access token's `orgs` claim has the roles
    /// and no names.
    ///
    /// **A failed list keeps the one already stored.** Same rule as the avatar
    /// cache and the credential itself: a call that never landed says nothing
    /// about the user's membership, and trading a known-good list for an empty
    /// one would empty the menu on every flaky launch — including the offline
    /// one this snapshot exists to serve.
    ///
    /// That includes a 401 here, which does **not** clear the credential:
    /// [`Self::validate_once`] takes its verdict from `/token` alone and has
    /// already confirmed it by the time this runs, so a rejection arriving on
    /// this call means the session died in between and the next validation is
    /// what acts on it. Only one call in this module may destroy a credential.
    ///
    /// A 403 is not surfaced to the user either, deviating from the spec's
    /// "DENIED → surface in context". There is no honest context to surface it
    /// in: this runs unprompted on the launch path, the endpoint is
    /// caller-scoped so a 403 on it indicates a server fault rather than
    /// anything the user can act on, and a toast on every launch would be
    /// noise. The section simply stays as it was, or absent — which is the
    /// truthful rendering of "we do not know".
    async fn resolve_orgs(
        &self,
        access_token: Option<String>,
        previous: Option<&StoredIdentity>,
    ) -> Option<Vec<StoredOrg>> {
        let Ok(listed) = self.fetch_orgs().await else {
            // `None` propagates when there was nothing stored either: still not
            // known, which the menu renders as no section rather than as "no
            // organisation".
            return previous.and_then(|p| p.orgs.clone());
        };

        // An empty list is a *verdict*, not a failure — a user who has joined
        // no organisation — so it is stored as-is and reaches the menu as the
        // empty state.
        let roles = match access_token {
            Some(jwt) => org_roles(&jwt),
            // Nothing minted one for us: this is the sign-in path, where the
            // credential is seconds old and no validation has run yet. A failure
            // costs the roles, never the names.
            None => self
                .mint_access_token()
                .await
                .ok()
                .and_then(|jwt| org_roles(&jwt)),
        };

        Some(
            listed
                .into_iter()
                .map(|org| StoredOrg {
                    role: match &roles {
                        // The claim was read. Absent from it means absent —
                        // membership per the server, not a failure to look.
                        Some(roles) => roles.get(&org.id).copied(),
                        // The claim was never read at all. Downgrading a label
                        // we already have would be the same mistake as trading
                        // a known-good photo for initials over one timeout.
                        None => previous.and_then(|p| p.role_of(&org.id)),
                    },
                    id: org.id,
                    name: org.name,
                })
                .collect(),
        )
    }

    /// `GET /organization/list` — the only source of organisation *names*.
    ///
    /// **One extra request per successful validation**, and one extra `/token`
    /// mint on the sign-in path. Re-checked against the auth worker's global
    /// ceiling of 100 requests per 60s, as the spec requires of anyone changing
    /// the request count: the retry path is untouched, because
    /// [`Self::validate_once`] only loops when `/token` itself fails and
    /// [`Self::refresh_identity`] never runs on the backoff schedule. A
    /// successful validation costs 3 requests and happens about once a launch.
    async fn fetch_orgs(&self) -> Authed<Vec<OrgEntry>> {
        let res = self.authed_get("/organization/list").await?;
        res.json::<Vec<OrgEntry>>()
            .await
            .map_err(|e| AuthFailure::indeterminate(format!("unreadable organisations: {e}")))
    }

    /// Pull the profile and organisations and write them onto the stored
    /// credential.
    ///
    /// Silent about every failure on purpose: this runs on the boot path behind
    /// an already-rendered signed-in title bar, and a photo, a stale display
    /// name, or a stale role is never worth a toast, let alone touching the
    /// credential.
    ///
    /// `previous` is the identity being replaced. It supplies the avatar cache
    /// key — what lets an unchanged photo cost zero requests — and is also what
    /// every fallback in [`Self::resolve_orgs`] falls back *to*.
    ///
    /// `access_token` is a JWT the caller has *already* minted, so the common
    /// path costs no second mint: [`Self::validate_once`] takes its verdict from
    /// one and would otherwise throw it away.
    async fn refresh_identity(
        &self,
        previous: Option<StoredIdentity>,
        access_token: Option<String>,
    ) {
        let Ok(Some(session)) = self.fetch_profile().await else {
            return;
        };
        let profile = session.user;
        let held = previous
            .as_ref()
            .map(|p| avatar::CachedAvatar::new(p.avatar_url.clone(), p.avatar_path.clone()))
            .unwrap_or_default();
        // Writes back the *pair* — a failed fetch returns the previous one
        // untouched, so a blip never trades a known-good photo for initials.
        let avatar =
            avatar::resolve(&self.http, &self.dir, profile.image.as_deref(), &held).await;

        let orgs = self.resolve_orgs(access_token, previous.as_ref()).await;

        // Re-read *after* the network work rather than reusing an earlier load,
        // and after the photo rather than before it: both calls above are round
        // trips, and a sign-out landing in either must not be undone by the
        // write below — a resurrected credential file would sign the user
        // straight back in on the next launch. A photo fetched into that gap
        // goes with it, since nothing will ever point at it again.
        let Some(current) = self.stored() else {
            avatar::discard(avatar.path.as_deref());
            return;
        };

        let _ = store::save(
            &self.dir,
            &StoredSession {
                identity: Some(StoredIdentity {
                    id: profile.id,
                    name: profile.name,
                    email: profile.email,
                    avatar_url: avatar.url,
                    avatar_path: avatar.path,
                    orgs,
                    active_org_id: session.session.active_organization_id,
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
                    //
                    // `None`: nothing has minted an access token yet on this
                    // path, so the roles cost one of their own.
                    self.refresh_identity(previous, None).await;
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
    /// **This is the only place a response is classified**, so the distinction
    /// the whole module turns on is written once rather than per endpoint:
    /// [`AuthFailure::Rejected`] is the server looking at the credential and
    /// refusing it, [`AuthFailure::Indeterminate`] is us never finding out.
    /// Conflating them is what signs people out for opening a laptop on a plane.
    async fn authed_get(&self, path: &str) -> Authed<reqwest::Response> {
        let Some(stored) = self.stored() else {
            return Err(AuthFailure::NoCredential);
        };

        let res = match self
            .http
            .get(self.url(path))
            .bearer_auth(&stored.session_token)
            .timeout(AUTHED_TIMEOUT)
            .send()
            .await
        {
            Ok(res) => res,
            // Refused, timed out, DNS gone, TLS failed — the request never got
            // an answer, so it says nothing whatsoever about the credential.
            // This branch is the entire reason the class exists.
            Err(e) => return Err(AuthFailure::indeterminate(redact(&e.to_string()))),
        };

        let status = res.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AuthFailure::Rejected);
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            return Err(AuthFailure::Indeterminate {
                retry_after: retry_after(res.headers()),
                // The path and the status, never the response body: an error
                // body from an auth server is the one place a token could
                // plausibly be echoed back.
                reason: format!("{path} failed: {status}"),
            });
        }
        if !status.is_success() {
            return Err(AuthFailure::Denied);
        }
        Ok(res)
    }

    /// Mint a short-TTL access JWT from the stored session token.
    pub async fn mint_access_token(&self) -> Authed<String> {
        let res = self.authed_get("/token").await?;

        #[derive(Deserialize)]
        struct TokenResponse {
            token: String,
        }
        // A 200 we cannot read is not a verdict on the credential either — the
        // server answered, but not with anything that proves or disproves it.
        let body: TokenResponse = res
            .json()
            .await
            .map_err(|e| AuthFailure::indeterminate(format!("unreadable token: {e}")))?;
        Ok(body.token)
    }

    /// Check the stored credential against the server, once.
    ///
    /// The verdict is taken from `/token`, not from `/get-session`. Both answer
    /// for a dead session, but `/get-session` expresses it as **200 with a
    /// `null` body** (ATL-44) — a far weaker signal than a status code, and one
    /// an unrelated serialisation change could start emitting by accident. A
    /// misread here destroys a valid credential, so the reading that carries
    /// that power is the unambiguous one.
    pub async fn validate_once(&self) -> Validation {
        let Some(current) = self.stored() else {
            return Validation::NoCredential;
        };

        match self.mint_access_token().await {
            Ok(jwt) => {
                // Every successful validation refreshes the snapshot, so a name,
                // photo, or role changed on the web reaches the desktop without
                // a re-sign-in. It runs only after the credential is confirmed —
                // there is no point fetching a profile we may be about to
                // discard, and a failure here must never reach the credential.
                //
                // The JWT is handed on rather than dropped: it is the only
                // source of per-organisation roles, and this call already paid
                // for it.
                self.refresh_identity(current.identity, Some(jwt)).await;
                Validation::Confirmed
            }
            Err(AuthFailure::NoCredential) => Validation::NoCredential,
            // The one branch permitted to destroy a credential.
            Err(AuthFailure::Rejected) => {
                let _ = self.clear_session();
                Validation::Rejected
            }
            Err(AuthFailure::Denied) => Validation::Denied,
            Err(AuthFailure::Indeterminate { retry_after, .. }) => {
                // Deliberately touches nothing. The stored snapshot is what
                // renders a complete signed-in title bar on a plane.
                Validation::Indeterminate { retry_after }
            }
        }
    }

    /// Validate at launch and keep trying until the answer means something.
    ///
    /// Indeterminate failures retry on the backoff schedule with **no attempt
    /// limit**, for as long as this task lives: someone offline for six hours
    /// is signed in the moment they reconnect, without restarting Atlas.
    ///
    /// `on_settled` fires exactly once, with the resulting snapshot. Nothing is
    /// emitted between attempts — by design. The signed-in state has no
    /// "verifying" variant, because a spinner or a warning in the title bar
    /// every time a laptop lid opens only teaches people to ignore it.
    pub async fn revalidate(&self, on_settled: impl FnOnce(AuthSnapshot)) -> Validation {
        let mut backoff = Backoff::new(self.backoff_base, backoff::CEILING);

        loop {
            match self.validate_once().await {
                Validation::Indeterminate { retry_after } => {
                    tokio::time::sleep(backoff.next_after(retry_after)).await;
                }
                settled => {
                    on_settled(self.snapshot());
                    return settled;
                }
            }
        }
    }

    // ---- sign-out --------------------------------------------------------

    /// Sign out of this device. Touches nothing but local state, and cannot
    /// fail (ATL-50).
    ///
    /// The credential, the identity snapshot, and the cached photo all go
    /// first and unconditionally — no network call gates any of it, which is
    /// what makes signing out work with the wifi off. The returned ticket is
    /// the only way to reach [`Self::revoke`], and it is `None` when there was
    /// nothing stored: already signed out is a success with nothing to tell the
    /// server about.
    ///
    /// If the unlink itself somehow fails — a read-only config dir — nothing
    /// here pretends otherwise: [`Self::snapshot`] is derived from the file, so
    /// the state the caller broadcasts next is whatever is really on disk.
    ///
    /// There is still no in-memory access token to clear. ATL-51 added none:
    /// the JWT it needs for the `orgs` claim is minted, read, and dropped inside
    /// a single call, and nothing else in the desktop consumes one. A cache
    /// would buy nothing and would be one more thing this function had to
    /// remember to clear.
    pub fn sign_out(&self) -> Option<RevocationTicket> {
        let stored = self.stored();
        // Before the credential, not after: the identity is where the path to
        // the cached photo is recorded, so clearing the file first would leave
        // a face on disk with nothing left pointing at it.
        if let Some(identity) = stored.as_ref().and_then(|s| s.identity.as_ref()) {
            avatar::discard(identity.avatar_path.as_deref());
        }
        let _ = self.clear_session();
        stored.map(|s| RevocationTicket(s.session_token))
    }

    /// Tell the server the session is over. Best-effort, fired **once**.
    ///
    /// Deliberately outside [`Self::authed_get`] and the retry policy it feeds:
    /// the credential arrives on the ticket because the store is already empty
    /// by the time this runs, and there is nothing left for a backoff schedule
    /// to protect. A failure costs a residual server session that expires on
    /// its own — which the user is told about, rather than retried at.
    ///
    /// `true` when the session is definitely gone server-side.
    pub async fn revoke(&self, ticket: RevocationTicket) -> bool {
        let res = self
            .http
            .post(self.url("/sign-out"))
            .bearer_auth(&ticket.0)
            .json(&serde_json::json!({}))
            .timeout(AUTHED_TIMEOUT)
            .send()
            .await;

        match res {
            // A 401 is the server saying it does not recognise this credential,
            // so there is no live session left to caveat. Every other refusal
            // is counted as a failure: we cannot tell whether it ended.
            Ok(res) => {
                res.status().is_success() || res.status() == reqwest::StatusCode::UNAUTHORIZED
            }
            Err(_) => false,
        }
    }
}

/// `Retry-After` as delta-seconds.
///
/// The HTTP-date form is not parsed: the auth worker sends seconds, and a date
/// read against a skewed local clock is worse than the backoff we already have
/// waiting behind it.
fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let raw = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    Some(Duration::from_secs(raw.trim().parse().ok()?))
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

/// `GET /get-session`.
#[derive(Deserialize)]
struct SessionResponse {
    /// `default` so a body without one still yields a profile. Expiry is
    /// deliberately still ignored — it is the server's business, and nothing
    /// here is improved by a second opinion on it.
    #[serde(default)]
    session: SessionMeta,
    user: Profile,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    /// Which organisation the user last made active, or `None` — which is the
    /// normal state for a device-granted session, since only the web ever calls
    /// `/organization/set-active`. [`active_org`] is what copes with that.
    #[serde(default)]
    active_organization_id: Option<String>,
}

/// One entry of `GET /organization/list`. Slug, logo, and timestamps are
/// deliberately not read: the menu renders a name, and ATL-36 owns the rest.
#[derive(Deserialize)]
struct OrgEntry {
    id: String,
    name: String,
}

/// The `orgs` claim — `{ organisationId: role }` — off an access token.
///
/// **The signature is deliberately not verified.** We minted this token
/// ourselves, over TLS, from the issuer, seconds ago; JWKS verification exists
/// for parties receiving tokens from untrusted sources, and checking our own
/// proves nothing it did not already know. The claims are used only to label a
/// row in a menu — nothing here authorises anything (spec, "Deviations from the
/// API doc", §5.2).
///
/// `None` for a token that could not be read at all — the same "we learned
/// nothing" the rest of the module turns on, kept distinct from `Some({})`,
/// which is the server genuinely placing the user in no organisation (API doc
/// §5.1: "`orgs` is `{}` until the user belongs to an Organisation"). Only the
/// caller can tell what to do with the difference, and it does: an unread claim
/// keeps the roles already known, an empty one clears them.
///
/// Never an error, and never a reason to doubt the credential — nothing here
/// authorises anything.
fn org_roles(jwt: &str) -> Option<HashMap<String, Role>> {
    use base64::Engine;

    #[derive(Deserialize)]
    struct Claims {
        #[serde(default)]
        orgs: HashMap<String, String>,
    }

    let payload = jwt.split('.').nth(1)?;
    // JWTs are base64**url** with the padding stripped, which the standard
    // alphabet decodes into garbage rather than rejecting.
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let claims = serde_json::from_slice::<Claims>(&bytes).ok()?;

    Some(
        claims
            .orgs
            .into_iter()
            // A role this build does not know is dropped, leaving its
            // organisation role-less rather than absent.
            .filter_map(|(id, role)| Role::from_claim(&role).map(|role| (id, role)))
            .collect(),
    )
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
