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
}

impl Reply {
    fn ok(body: &str) -> Self {
        Self { status: 200, body: body.into() }
    }
    fn err(status: u16, body: &str) -> Self {
        Self { status, body: body.into() }
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

                    let out = format!(
                        "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        reply.status,
                        reply.body.len(),
                        reply.body
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
}

fn core(stub: &Stub, dir: &TempDir) -> AuthCore {
    AuthCore::new(stub.base(), dir.path(), reqwest::Client::new())
}

const TOKEN_OK: &str = r#"{"access_token":"session-tok","token_type":"Bearer"}"#;

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

    assert_eq!(auth.snapshot(), AuthSnapshot::SignedIn);

    // A fresh core over the same directory is what a relaunch looks like.
    let relaunched = AuthCore::new(stub.base(), dir.path(), reqwest::Client::new());
    assert_eq!(relaunched.snapshot(), AuthSnapshot::SignedIn);
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

    assert_eq!(auth.snapshot(), AuthSnapshot::SignedIn);
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
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedIn);
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
    assert_eq!(auth.snapshot(), AuthSnapshot::SignedIn);
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
    assert_eq!(auth.validate_stored().await, AuthSnapshot::SignedIn);
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
    assert_eq!(offline.validate_stored().await, AuthSnapshot::SignedIn);
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
