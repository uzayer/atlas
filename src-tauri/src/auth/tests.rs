//! Tests for the auth core.
//!
//! These drive [`AuthCore`] against a **stub HTTP server bound to loopback**,
//! with a temporary directory standing in for the app config dir. That works
//! because the auth base is injected rather than hardcoded, so the seam already
//! exists by design — no mock traits, no dependency-injection scaffolding, and
//! the real `reqwest` client, the real poll loop and the real file I/O are all
//! exercised.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

// ---------------------------------------------------------------- temp dir

/// A unique directory removed on drop. Avoids a `tempfile` dev-dependency for
/// what is fifteen lines.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let unique = format!(
            "atlas-auth-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ------------------------------------------------------------- stub server

/// One canned HTTP response.
#[derive(Clone)]
struct Reply {
    status: u16,
    body: String,
    content_type: &'static str,
    /// `None` omits the header entirely, so the client must read to EOF without
    /// knowing how much is coming. That is the only way to reach the avatar
    /// fetch's *streaming* size cap: with an honest length the cheap up-front
    /// check fires first, and an understated one just makes `reqwest` truncate.
    content_length: Option<usize>,
}

impl Reply {
    fn new(status: u16, body: &str, content_type: &'static str) -> Self {
        Self {
            status,
            body: body.into(),
            content_type,
            content_length: Some(body.len()),
        }
    }
    fn ok(body: &str) -> Self {
        Self::new(200, body, "application/json")
    }
    fn err(status: u16, body: &str) -> Self {
        Self::new(status, body, "application/json")
    }
    /// A 200 with an explicit content type — used for image bodies, and for
    /// proving what happens when the "photo" turns out not to be one. The bytes
    /// are never a real image: nothing in the Rust layer decodes them.
    fn with_content_type(content_type: &'static str, body: &str) -> Self {
        Self::new(200, body, content_type)
    }
    fn without_content_length(mut self) -> Self {
        self.content_length = None;
        self
    }
}

/// Scriptable auth server. Each path holds a queue of replies; the last one
/// repeats once the queue is drained, so a test only scripts what it cares
/// about.
#[derive(Default)]
struct Script {
    replies: HashMap<String, Vec<Reply>>,
    hits: HashMap<String, u32>,
}

struct Stub {
    addr: SocketAddr,
    script: Arc<Mutex<Script>>,
}

impl Stub {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let script = Arc::new(Mutex::new(Script::default()));
        let handle = Arc::clone(&script);

        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let handle = Arc::clone(&handle);
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let Ok(n) = sock.read(&mut buf).await else { return };
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("/")
                        .to_string();

                    let reply = {
                        let mut s = handle.lock().unwrap();
                        *s.hits.entry(path.clone()).or_insert(0) += 1;
                        let queue = s.replies.get_mut(&path);
                        match queue {
                            Some(q) if q.len() > 1 => q.remove(0),
                            Some(q) if q.len() == 1 => q[0].clone(),
                            _ => Reply::err(404, "{}"),
                        }
                    };

                    let length = match reply.content_length {
                        Some(n) => format!("Content-Length: {n}\r\n"),
                        None => String::new(),
                    };
                    let out = format!(
                        "HTTP/1.1 {} X\r\nContent-Type: {}\r\n{}Connection: close\r\n\r\n{}",
                        reply.status, reply.content_type, length, reply.body
                    );
                    let _ = sock.write_all(out.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });

        Self { addr, script }
    }

    fn base(&self) -> String {
        format!("http://{}", self.addr)
    }

    fn on(&self, path: &str, replies: Vec<Reply>) {
        self.script.lock().unwrap().replies.insert(path.into(), replies);
    }

    fn hits(&self, path: &str) -> u32 {
        self.script.lock().unwrap().hits.get(path).copied().unwrap_or(0)
    }

    /// A grant that is immediately pollable, with no artificial delay.
    fn grant_ready(&self, expires_in: u64) {
        self.on(
            "/device/code",
            vec![Reply::ok(&format!(
                r#"{{"device_code":"dev-secret","user_code":"ABCD-1234",
                     "verification_uri":"https://app.example/device",
                     "verification_uri_complete":"https://app.example/device?user_code=ABCD-1234",
                     "expires_in":{expires_in},"interval":0}}"#
            ))],
        );
    }

    /// A `/get-session` profile. `image` is the *absolute* URL the desktop will
    /// fetch, so tests point it back at this same stub.
    fn profile(&self, name: &str, image: Option<&str>) {
        let image = match image {
            Some(url) => format!(r#""{url}""#),
            None => "null".to_string(),
        };
        self.on(
            "/get-session",
            vec![Reply::ok(&format!(
                r#"{{"session":{{"id":"sess_1"}},
                     "user":{{"id":"user_1","name":"{name}",
                              "email":"ada@atlas.example","image":{image}}}}}"#
            ))],
        );
    }

    /// Absolute URL for a stub path, for use as a profile `image`.
    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base(), path)
    }
}

fn core(stub: &Stub, dir: &TempDir) -> AuthCore {
    AuthCore::new(stub.base(), dir.path(), reqwest::Client::new())
}

/// Signed in, whoever it turns out to be — for the tests that are about the
/// grant rather than the user.
fn signed_in(snapshot: &AuthSnapshot) -> bool {
    matches!(snapshot, AuthSnapshot::SignedIn { .. })
}

/// The identity on a signed-in snapshot, or a panic naming what we got instead.
fn user_of(snapshot: &AuthSnapshot) -> AccountUser {
    match snapshot {
        AuthSnapshot::SignedIn { user: Some(user) } => user.clone(),
        other => panic!("expected a signed-in snapshot with an identity, got {other:?}"),
    }
}

/// Drive a grant to completion against an already-scripted stub.
async fn sign_in(auth: &AuthCore) {
    let grant = auth.start_grant().await.expect("start grant");
    auth.run_grant(&grant).await.expect("complete grant");
}

const TOKEN_OK: &str = r#"{"access_token":"session-tok","token_type":"Bearer"}"#;
/// Stands in for image bytes. Content is irrelevant — nothing decodes it.
const PIXELS: &str = "not-really-a-png-but-nothing-here-decodes-it";

// ------------------------------------------------------------------ config

#[test]
fn auth_base_prefers_the_environment_and_trims_slashes() {
    // Serialised implicitly: this is the only test touching the process env.
    std::env::set_var("ATLAS_AUTH_URL", "http://localhost:8787/api/auth/");
    assert_eq!(auth_base(), "http://localhost:8787/api/auth");

    std::env::set_var("ATLAS_AUTH_URL", "   ");
    assert!(
        auth_base().starts_with("https://"),
        "a blank override must fall through to the built-in default"
    );

    std::env::remove_var("ATLAS_AUTH_URL");
    assert_eq!(auth_base(), "https://auth.tryatlas.cc/api/auth");
}

// ----------------------------------------------------------------- storage

#[tokio::test]
async fn a_granted_token_is_persisted_and_survives_a_restart() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::ok(TOKEN_OK)]);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.expect("start");
    auth.run_grant(&grant).await.expect("grant");

    assert!(signed_in(&auth.snapshot()));

    // A fresh core over the same directory is what a relaunch looks like.
    let relaunched = AuthCore::new(stub.base(), dir.path(), reqwest::Client::new());
    assert!(signed_in(&relaunched.snapshot()));
    assert_eq!(relaunched.stored().unwrap().session_token, "session-tok");
}

#[cfg(unix)]
#[tokio::test]
async fn the_credential_file_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::ok(TOKEN_OK)]);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    auth.run_grant(&grant).await.unwrap();

    let mode = std::fs::metadata(dir.path().join("atlas-session.json"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600, "credential must not be group/world readable");
}

#[tokio::test]
async fn clearing_is_idempotent_and_returns_to_signed_out() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    let auth = core(&stub, &dir);

    assert!(auth.clear_session().is_ok(), "clearing when absent must succeed");
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::ok(TOKEN_OK)]);
    let grant = auth.start_grant().await.unwrap();
    auth.run_grant(&grant).await.unwrap();

    auth.clear_session().unwrap();
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
    assert!(auth.clear_session().is_ok());
}

// ------------------------------------------------------------- grant matrix

#[tokio::test]
async fn pending_polls_continue_until_approval() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on(
        "/device/token",
        vec![
            Reply::err(400, r#"{"error":"authorization_pending"}"#),
            Reply::err(400, r#"{"error":"authorization_pending"}"#),
            Reply::ok(TOKEN_OK),
        ],
    );

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    auth.run_grant(&grant).await.expect("should end signed in");

    assert!(signed_in(&auth.snapshot()));
    assert_eq!(stub.hits("/device/token"), 3);
}

#[tokio::test]
async fn a_transient_failure_does_not_discard_an_approval() {
    // The point of the whole classification: a 500 and a dropped connection
    // tell us nothing about whether the human approved, so the grant must
    // survive them. Ending here would throw away an approval already given.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on(
        "/device/token",
        vec![
            Reply::err(500, "boom"),
            Reply::err(502, "still boom"),
            Reply::ok(TOKEN_OK),
        ],
    );

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    auth.run_grant(&grant).await.expect("transient errors must not end the grant");
    assert!(signed_in(&auth.snapshot()));
}

#[tokio::test]
async fn slow_down_backs_off_and_keeps_going() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on(
        "/device/token",
        vec![Reply::err(400, r#"{"error":"slow_down"}"#), Reply::ok(TOKEN_OK)],
    );

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    let started = std::time::Instant::now();
    auth.run_grant(&grant).await.expect("slow_down is not terminal");

    assert!(
        started.elapsed() >= Duration::from_secs(5),
        "slow_down must add 5s to the interval before the next poll"
    );
    assert!(signed_in(&auth.snapshot()));
}

#[tokio::test]
async fn denial_is_terminal_and_stores_nothing() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::err(400, r#"{"error":"access_denied"}"#)]);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    assert_eq!(auth.run_grant(&grant).await, Err(GrantError::Denied));
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
}

#[tokio::test]
async fn a_server_expired_code_is_terminal() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::err(400, r#"{"error":"expired_token"}"#)]);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    assert_eq!(auth.run_grant(&grant).await, Err(GrantError::Expired));
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
}

#[tokio::test]
async fn the_local_deadline_ends_a_grant_the_server_never_finishes() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(1); // expires almost immediately
    stub.on("/device/token", vec![Reply::err(400, r#"{"error":"authorization_pending"}"#)]);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    assert_eq!(auth.run_grant(&grant).await, Err(GrantError::Expired));
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
}

#[tokio::test]
async fn cancelling_ends_the_grant_and_stops_polling() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::err(400, r#"{"error":"authorization_pending"}"#)]);

    let auth = Arc::new(core(&stub, &dir));
    let grant = auth.start_grant().await.unwrap();

    let runner = {
        let auth = Arc::clone(&auth);
        let grant = grant.clone();
        tokio::spawn(async move { auth.run_grant(&grant).await })
    };

    tokio::time::sleep(Duration::from_millis(120)).await;
    auth.cancel_grant();

    assert_eq!(runner.await.unwrap(), Err(GrantError::Cancelled));
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);

    // Nothing keeps polling after cancellation.
    let after = stub.hits("/device/token");
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(stub.hits("/device/token"), after, "poll loop must be stopped");
}

#[tokio::test]
async fn a_second_start_resumes_the_same_grant_instead_of_minting_another() {
    // The recovery path: someone who got lost signing in on the web clicks the
    // account button again and must land back on the SAME approval page.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::err(400, r#"{"error":"authorization_pending"}"#)]);

    let auth = core(&stub, &dir);
    let first = auth.start_grant().await.unwrap();
    let second = auth.start_grant().await.unwrap();

    assert_eq!(first.user_code, second.user_code);
    assert_eq!(first.device_code, second.device_code);
    assert_eq!(stub.hits("/device/code"), 1, "must not mint a competing code");
}

#[tokio::test]
async fn the_connecting_snapshot_exposes_the_code_but_never_the_secret() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();

    match auth.snapshot() {
        AuthSnapshot::Connecting { user_code, verification_uri, .. } => {
            assert_eq!(user_code, "ABCD-1234");
            // The PLAIN url, for manual entry. The pre-filled variant is used
            // to open the browser from Rust and never needs to cross over.
            assert_eq!(verification_uri, "https://app.example/device");
            let json = serde_json::to_string(&auth.snapshot()).unwrap();
            assert!(
                !json.contains(&grant.device_code),
                "the device_code is the secret and must never cross to the frontend"
            );
        }
        other => panic!("expected Connecting, got {other:?}"),
    }
}

#[tokio::test]
async fn an_unreachable_server_fails_to_start_without_leaking_the_url() {
    let dir = TempDir::new();
    // Port 1 on loopback: nothing listens, so the connection is refused.
    let auth = AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new());

    match auth.start_grant().await {
        Err(GrantError::Start(msg)) => {
            assert!(!msg.contains("127.0.0.1:1"), "error text must not carry the URL");
        }
        other => panic!("expected a start failure, got {other:?}"),
    }
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedOut);
}

// -------------------------------------------------------------------- boot

#[tokio::test]
async fn boot_with_no_credential_makes_no_network_call() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    let auth = core(&stub, &dir);

    assert_eq!(auth.validate_stored().await, AuthSnapshot::SignedOut);
    assert_eq!(stub.hits("/token"), 0, "a signed-out launch must be silent");
}

#[tokio::test]
async fn boot_preserves_the_credential_even_when_the_server_rejects_it() {
    // Safe-by-default until ATL-48 lands the authoritative-401 rule. The worst
    // outcome here is a stale signed-in state; the alternative would destroy a
    // valid session, which is much harder to undo.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::ok(TOKEN_OK)]);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    auth.run_grant(&grant).await.unwrap();

    stub.on("/token", vec![Reply::err(401, "unauthorized")]);
    assert!(signed_in(&auth.validate_stored().await));
    assert!(auth.stored().is_some(), "a 401 must not clear the credential yet");
}

#[tokio::test]
async fn boot_preserves_the_credential_when_the_server_is_unreachable() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::ok(TOKEN_OK)]);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    auth.run_grant(&grant).await.unwrap();

    // Point a fresh core at a dead port — the offline launch case.
    let offline = AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new());
    assert!(signed_in(&offline.validate_stored().await));
    assert!(offline.stored().is_some());
}

#[tokio::test]
async fn minting_reports_rejection_and_unreachability_differently() {
    // The distinction ATL-48 is built on: Ok(None) is "the server said no",
    // Err is "we never found out". Conflating them is what signs people out
    // for opening a laptop on a plane.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::ok(TOKEN_OK)]);

    let auth = core(&stub, &dir);
    let grant = auth.start_grant().await.unwrap();
    auth.run_grant(&grant).await.unwrap();

    stub.on("/token", vec![Reply::err(401, "unauthorized")]);
    assert_eq!(auth.mint_access_token().await, Ok(None), "401 is authoritative");

    stub.on("/token", vec![Reply::ok(r#"{"token":"jwt-here"}"#)]);
    assert_eq!(auth.mint_access_token().await, Ok(Some("jwt-here".into())));

    let offline = AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new());
    assert!(offline.mint_access_token().await.is_err(), "unreachable is not a rejection");
}

// ---------------------------------------------------------------- identity

/// How many avatar files the cache is holding. Growth here would mean every
/// photo change leaks a file into the config directory forever.
fn cached_avatars(dir: &TempDir) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir.path())
        .expect("read config dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("avatar-"))
        })
        .collect();
    found.sort();
    found
}

fn scripted_grant(stub: &Stub) {
    stub.grant_ready(600);
    stub.on("/device/token", vec![Reply::ok(TOKEN_OK)]);
}

#[tokio::test]
async fn the_identity_snapshot_is_written_on_sign_in_and_survives_a_restart() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    let user = user_of(&auth.snapshot());
    assert_eq!(user.name, "Ada Lovelace");
    assert_eq!(user.email, "ada@atlas.example");
    let path = user.avatar_path.clone().expect("a photo was fetched");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        PIXELS,
        "the cached file must hold the bytes the server served"
    );

    // A fresh core over the same directory is what a relaunch looks like — and
    // it must render a complete title bar with no network involved at all.
    let relaunched = AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new());
    let offline = user_of(&relaunched.snapshot());
    assert_eq!(offline, user, "the snapshot must survive a restart intact");
}

#[tokio::test]
async fn a_photo_that_has_not_changed_is_never_fetched_again() {
    // The privacy claim, made testable: a launch must not tell Google or GitHub
    // that this user opened their editor, for a picture already on disk.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    assert_eq!(stub.hits("/photo.png"), 1, "fetched once on sign-in");
    let first = user_of(&auth.snapshot()).avatar_path;

    let relaunched = core(&stub, &dir);
    let snapshot = relaunched.validate_stored().await;

    assert_eq!(stub.hits("/photo.png"), 1, "a relaunch must reuse the cache");
    assert_eq!(user_of(&snapshot).avatar_path, first);
    assert!(
        stub.hits("/get-session") >= 2,
        "the profile itself is still refreshed — it is the photo that is cached"
    );
}

#[tokio::test]
async fn a_changed_photo_url_re_fetches_and_drops_the_old_file() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    let old = user_of(&auth.snapshot()).avatar_path.expect("first photo");

    // The user changed their photo; the provider hands back a new URL.
    stub.profile("Ada Lovelace", Some(&stub.url("/photo-v2.png")));
    stub.on("/photo-v2.png", vec![Reply::with_content_type("image/png", "new-pixels")]);

    let snapshot = core(&stub, &dir).validate_stored().await;
    let new = user_of(&snapshot).avatar_path.expect("second photo");

    assert_eq!(stub.hits("/photo-v2.png"), 1, "a changed URL must re-fetch");
    assert_ne!(new, old, "a new photo must land at a new path, or the webview caches the old face");
    assert_eq!(std::fs::read_to_string(&new).unwrap(), "new-pixels");
    assert_eq!(cached_avatars(&dir).len(), 1, "the superseded file must not linger");
}

#[tokio::test]
async fn a_failed_re_fetch_keeps_the_photo_it_already_had() {
    // The rule the whole failure classification turns on, applied to the cache:
    // a timeout tells us nothing about the new photo, so it must not cost the
    // known-good old one. Deleting it would mean a five-second blip during one
    // launch leaves the title bar blank on every offline launch afterwards.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    let known_good = user_of(&auth.snapshot()).avatar_path.expect("first photo");

    // The photo changes, but the CDN is having a bad minute.
    stub.profile("Ada Lovelace", Some(&stub.url("/photo-v2.png")));
    stub.on("/photo-v2.png", vec![Reply::err(503, "unavailable")]);

    let snapshot = core(&stub, &dir).validate_stored().await;
    assert_eq!(
        user_of(&snapshot).avatar_path.as_deref(),
        Some(known_good.as_str()),
        "an indeterminate failure must not trade a good photo for initials"
    );
    assert!(
        std::path::Path::new(&known_good).exists(),
        "nor delete the bytes behind it"
    );

    // And the next launch must still notice the photo changed, rather than
    // filing the new URL against the old file and never trying again.
    stub.on(
        "/photo-v2.png",
        vec![Reply::with_content_type("image/png", "new-pixels")],
    );
    let recovered = core(&stub, &dir).validate_stored().await;
    let new = user_of(&recovered).avatar_path.expect("second photo");
    assert_ne!(new, known_good, "the retry must land the new photo");
    assert_eq!(std::fs::read_to_string(&new).unwrap(), "new-pixels");
    assert_eq!(cached_avatars(&dir).len(), 1, "and only then drop the old one");
}

#[tokio::test]
async fn a_photo_that_fails_to_fetch_falls_back_without_blocking_sign_in() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/gone.png")));
    stub.on("/gone.png", vec![Reply::err(404, "nope")]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    let user = user_of(&auth.snapshot());
    assert_eq!(user.avatar_path, None, "a failed fetch renders as initials");
    assert_eq!(user.name, "Ada Lovelace", "and must not cost the rest of the identity");
    assert!(auth.stored().is_some(), "least of all the credential");
    assert!(cached_avatars(&dir).is_empty(), "nothing half-written on disk");

    // Self-healing: the recorded URL matches but no file exists, so the next
    // launch tries again rather than treating the failure as permanent.
    stub.on("/gone.png", vec![Reply::with_content_type("image/png", PIXELS)]);
    let snapshot = core(&stub, &dir).validate_stored().await;
    assert!(
        user_of(&snapshot).avatar_path.is_some(),
        "a failed fetch must be retried on the next launch, not cached as a no"
    );
}

#[tokio::test]
async fn an_oversized_photo_is_refused_however_the_length_is_declared() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    let huge = "x".repeat(2 * 1024 * 1024 + 1);

    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/huge.png")));
    stub.on("/huge.png", vec![Reply::with_content_type("image/png", &huge)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    assert_eq!(
        user_of(&auth.snapshot()).avatar_path,
        None,
        "a declared length over the cap must be refused before downloading it"
    );

    // No Content-Length at all: the cap has to hold while streaming, which is
    // the case a host that wants to fill the disk would actually use.
    let dir2 = TempDir::new();
    stub.on(
        "/huge.png",
        vec![Reply::with_content_type("image/png", &huge).without_content_length()],
    );
    let auth2 = core(&stub, &dir2);
    sign_in(&auth2).await;
    assert_eq!(
        user_of(&auth2.snapshot()).avatar_path,
        None,
        "an undeclared length must be capped while streaming"
    );
    assert!(cached_avatars(&dir2).is_empty());
}

#[tokio::test]
async fn a_response_that_is_not_an_image_is_never_written_to_disk() {
    // The avatar cache lives in a directory the asset protocol serves, so what
    // gets written there is worth being narrow about.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/login.html")));
    stub.on(
        "/login.html",
        vec![Reply::with_content_type("text/html", "<h1>sign in</h1>")],
    );

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    assert_eq!(user_of(&auth.snapshot()).avatar_path, None);
    assert!(cached_avatars(&dir).is_empty(), "only image types reach the disk");
}

#[tokio::test]
async fn a_user_with_no_photo_is_still_fully_identified() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Grace Hopper", None);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    let user = user_of(&auth.snapshot());
    assert_eq!(user.name, "Grace Hopper");
    assert_eq!(user.avatar_path, None, "the UI draws an initial for this");
}

#[tokio::test]
async fn a_successful_validation_refreshes_a_stale_snapshot() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", None);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    assert_eq!(user_of(&auth.snapshot()).name, "Ada Lovelace");

    // Renamed on the web. The desktop must pick it up without a re-sign-in.
    stub.profile("Ada Byron", None);
    let snapshot = core(&stub, &dir).validate_stored().await;
    assert_eq!(user_of(&snapshot).name, "Ada Byron");
}

#[tokio::test]
async fn a_validation_that_fails_keeps_the_last_known_identity() {
    // The offline launch. The snapshot exists precisely so this renders a
    // complete title bar rather than a nameless one.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;
    let known = user_of(&auth.snapshot());

    let offline = AuthCore::new("http://127.0.0.1:1", dir.path(), reqwest::Client::new());
    assert_eq!(user_of(&offline.validate_stored().await), known);
    assert!(offline.stored().is_some());
}

#[tokio::test]
async fn the_signed_in_snapshot_identifies_the_user_and_carries_no_credential() {
    let stub = Stub::start().await;
    let dir = TempDir::new();
    scripted_grant(&stub);
    stub.profile("Ada Lovelace", Some(&stub.url("/photo.png")));
    stub.on("/photo.png", vec![Reply::with_content_type("image/png", PIXELS)]);

    let auth = core(&stub, &dir);
    sign_in(&auth).await;

    let json = serde_json::to_string(&auth.snapshot()).unwrap();
    assert!(json.contains("ada@atlas.example"), "identity is what the frontend is for");
    assert!(
        !json.contains("session-tok"),
        "the session token must never cross to the frontend"
    );
    assert!(
        !json.contains("/photo.png"),
        "nor the remote photo URL — an <img> pointed at it would put the \
         per-launch request to the provider straight back"
    );
}

#[tokio::test]
async fn a_credential_stored_before_identities_existed_still_loads() {
    // Anyone who signed in on an ATL-46 build has a file with no `identity`
    // key. Treating that as corrupt would sign them out on upgrade.
    let stub = Stub::start().await;
    let dir = TempDir::new();
    std::fs::write(
        dir.path().join("atlas-session.json"),
        r#"{"sessionToken":"session-tok","savedAt":"2026-07-22T00:00:00Z"}"#,
    )
    .unwrap();

    let auth = core(&stub, &dir);
    assert_eq!(
        auth.snapshot(),
        AuthSnapshot::SignedIn { user: None },
        "signed in, just not yet identified"
    );

    stub.profile("Ada Lovelace", None);
    assert_eq!(
        user_of(&auth.validate_stored().await).name,
        "Ada Lovelace",
        "the first validation after upgrade fills the identity in"
    );
}
