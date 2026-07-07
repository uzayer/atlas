//! Consent-gated, privacy-preserving product telemetry (PostHog).
//!
//! Atlas ships with **zero** analytics enabled by default. Nothing leaves the
//! machine until the user explicitly opts in (Settings → General → "Share
//! anonymous usage data" or the first-run consent prompt). When enabled, this
//! module emits coarse **usage / error metadata only** — never prompt or
//! response text, file contents or absolute paths, KB/chat content, API keys,
//! terminal I/O, or browser URLs. See `TELEMETRY.md` at the repo root for the
//! full event catalog and the never-collected list.
//!
//! Identity is a single persisted anonymous UUID (`telemetry_anon_id` in
//! `state.json`) used as the PostHog `distinct_id` by both this Rust emitter
//! and the frontend `posthog-js` (which handles client-side crashes only), so
//! one install maps to one anonymous person.
//!
//! Key/host resolution (highest priority wins):
//!   1. env `ATLAS_POSTHOG_KEY`/`POSTHOG_KEY` (+ `ATLAS_POSTHOG_HOST`/`POSTHOG_HOST`),
//!      also picked up from a `.env` loaded by `dotenvy` at `main()` start.
//!   2. `<app_config_dir>/telemetry.json` ({ "key": ..., "host": ... }).
//!   3. compile-time `option_env!("ATLAS_POSTHOG_KEY")` — official release builds.
//!   4. none → the client is permanently **inert** (no network, every call a no-op).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

/// PostHog US cloud ingest endpoint (used when no host override is given).
const DEFAULT_HOST: &str = "https://us.i.posthog.com";
/// Flush whenever this many events are queued…
const FLUSH_BATCH: usize = 20;
/// …or this often, whichever comes first.
const FLUSH_INTERVAL: Duration = Duration::from_secs(5);
/// Bounded queue. On overflow we drop events (telemetry must never apply
/// backpressure to the app).
const QUEUE_CAP: usize = 512;

/// Baked into official release builds via CI secrets. `None` in source / fork
/// builds unless the builder sets the env at compile time.
const BUILD_KEY: Option<&str> = option_env!("ATLAS_POSTHOG_KEY");
const BUILD_HOST: Option<&str> = option_env!("ATLAS_POSTHOG_HOST");

/// A single queued capture, serialized into the PostHog `/batch/` payload.
#[derive(Clone)]
pub(crate) struct QueuedEvent {
    event: String,
    properties: Value,
    timestamp: String,
}

/// Non-secret config the frontend reads to bootstrap `posthog-js`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryConfig {
    pub enabled: bool,
    pub host: String,
    pub anon_id: String,
    pub using_default_key: bool,
    /// PostHog *project* (write-only ingest) key — safe to expose client-side.
    /// `None` when inert; the frontend then skips `posthog-js` init entirely.
    pub key: Option<String>,
}

/// The two auto-update values pulled from PostHog remote config.
#[derive(Debug, Clone)]
pub struct RemoteUpdateConfig {
    /// Latest version, raw string (e.g. `"0.1.21"`).
    pub version: String,
    /// Direct download URL of the release DMG.
    pub uri: String,
}

/// Coerce a PostHog `featureFlagPayloads` value into a plain string. Payloads
/// may arrive already as a JSON string, or double-encoded (a string whose
/// contents are themselves a JSON-quoted string, e.g. `"\"0.1.21\""`).
fn payload_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => match serde_json::from_str::<Value>(s) {
            Ok(Value::String(inner)) => Some(inner),
            _ => Some(s.clone()),
        },
        _ => None,
    }
}

/// Managed Tauri state. Cheap to clone (`Arc`). Every public method is an
/// instant no-op when inert or disabled.
pub struct TelemetryClient {
    /// Runtime opt-in gate (flips live via `set_enabled`).
    enabled: AtomicBool,
    /// No key resolved → permanently dead. Distinct from `enabled` so toggling
    /// on a key-less build still does nothing.
    inert: bool,
    api_key: Option<String>,
    host: String,
    using_default_key: bool,
    distinct_id: String,
    app_version: &'static str,
    os: &'static str,
    arch: &'static str,
    tx: Option<mpsc::Sender<QueuedEvent>>,
    /// Latest cumulative usage seen per session, stamped onto `agent_turn_finished`.
    last_usage: DashMap<String, Value>,
}

struct Resolved {
    api_key: String,
    host: String,
    using_default_key: bool,
}

/// Resolve the PostHog key + host by priority. `None` → inert.
fn resolve_keys(app: &AppHandle) -> Option<Resolved> {
    // 1. Environment (also populated from `.env` via dotenvy in main()).
    let env_key = std::env::var("ATLAS_POSTHOG_KEY")
        .ok()
        .or_else(|| std::env::var("POSTHOG_KEY").ok())
        .filter(|k| !k.trim().is_empty());
    if let Some(key) = env_key {
        let host = std::env::var("ATLAS_POSTHOG_HOST")
            .ok()
            .or_else(|| std::env::var("POSTHOG_HOST").ok())
            .filter(|h| !h.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_HOST.to_string());
        return Some(Resolved {
            api_key: key.trim().to_string(),
            host,
            using_default_key: false,
        });
    }

    // 2. User config file `<app_config_dir>/telemetry.json`.
    if let Some(r) = read_config_file(app) {
        return Some(r);
    }

    // 3. Compile-time default (official builds only).
    if let Some(key) = BUILD_KEY.filter(|k| !k.trim().is_empty()) {
        return Some(Resolved {
            api_key: key.trim().to_string(),
            host: BUILD_HOST
                .filter(|h| !h.trim().is_empty())
                .unwrap_or(DEFAULT_HOST)
                .to_string(),
            using_default_key: true,
        });
    }

    // 4. Nothing → inert.
    None
}

/// Shape of the optional `<app_config_dir>/telemetry.json` self-host config.
#[derive(Deserialize)]
struct FileConfig {
    key: Option<String>,
    host: Option<String>,
}

fn read_config_file(app: &AppHandle) -> Option<Resolved> {
    let dir = app.path().app_config_dir().ok()?;
    let raw = std::fs::read_to_string(dir.join("telemetry.json")).ok()?;
    let cfg: FileConfig = serde_json::from_str(&raw).ok()?;
    let key = cfg.key.filter(|k| !k.trim().is_empty())?;
    Some(Resolved {
        api_key: key.trim().to_string(),
        host: cfg
            .host
            .filter(|h| !h.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_HOST.to_string()),
        using_default_key: false,
    })
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Strip obvious PII (path-like / URL-like tokens) and truncate. Applied to any
/// free-text we forward (agent/panic error summaries) as a defensive backstop —
/// callers should already pass only metadata.
pub fn redact_message(msg: &str, max_chars: usize) -> String {
    let cleaned = msg
        .split_whitespace()
        .filter(|t| {
            !t.starts_with('/')
                && !t.starts_with('~')
                && !t.contains('\\')
                && !t.contains("://")
                && !t.contains('@')
        })
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.chars().count() > max_chars {
        let head: String = cleaned.chars().take(max_chars).collect();
        format!("{head}…")
    } else {
        cleaned
    }
}

impl TelemetryClient {
    /// Construct the client (resolving key/host) and, unless inert, the
    /// background flush channel receiver the caller must hand to a spawned
    /// `run_flush_loop`. `enabled` is the persisted opt-in setting.
    pub(crate) fn new(
        app: &AppHandle,
        distinct_id: String,
        enabled: bool,
    ) -> (Arc<Self>, Option<mpsc::Receiver<QueuedEvent>>) {
        let resolved = resolve_keys(app);
        let inert = resolved.is_none();
        let (tx, rx) = if inert {
            (None, None)
        } else {
            let (t, r) = mpsc::channel(QUEUE_CAP);
            (Some(t), Some(r))
        };
        let (api_key, host, using_default_key) = match resolved {
            Some(r) => (Some(r.api_key), r.host, r.using_default_key),
            None => (None, DEFAULT_HOST.to_string(), false),
        };
        let client = Arc::new(Self {
            enabled: AtomicBool::new(enabled && !inert),
            inert,
            api_key,
            host,
            using_default_key,
            distinct_id,
            app_version: env!("CARGO_PKG_VERSION"),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            tx,
            last_usage: DashMap::new(),
        });
        (client, rx)
    }

    pub fn is_enabled(&self) -> bool {
        !self.inert && self.enabled.load(Ordering::Relaxed)
    }

    pub fn config(&self) -> TelemetryConfig {
        TelemetryConfig {
            enabled: self.is_enabled(),
            host: self.host.clone(),
            anon_id: self.distinct_id.clone(),
            using_default_key: self.using_default_key,
            key: if self.inert {
                None
            } else {
                self.api_key.clone()
            },
        }
    }

    /// Fetch the two auto-update remote-config values (`version`, `uri`) from
    /// PostHog using the official `posthog-rs` SDK's feature-flag evaluation
    /// (`evaluate_flags` → `/flags/?v=2`), keyed on the project token + anon
    /// distinct id. Both values are stored as PostHog **remote-config flag
    /// payloads** (JSON-encoded strings, so `get_flag_payload` returns e.g.
    /// `"\"0.1.20\""` — decoded via [`payload_string`]). Deliberately
    /// **independent of the telemetry opt-in** (app updates are not analytics) —
    /// it only requires a resolved project key (i.e. not inert). Returns `None`
    /// when inert or on any error.
    pub async fn fetch_remote_config(&self) -> Option<RemoteUpdateConfig> {
        let key = self.api_key.clone()?; // inert build → no key → skip
        let host = self.host.clone();
        let client = posthog_rs::client((key.as_str(), host.as_str())).await;
        let flags = client
            .evaluate_flags(
                self.distinct_id.as_str(),
                posthog_rs::EvaluateFlagsOptions::default(),
            )
            .await
            .ok()?;
        let version = flags.get_flag_payload("version").as_ref().and_then(payload_string)?;
        let uri = flags.get_flag_payload("uri").as_ref().and_then(payload_string)?;
        if version.trim().is_empty() || uri.trim().is_empty() {
            return None;
        }
        Some(RemoteUpdateConfig { version, uri })
    }

    /// Flip the live opt-in gate. Records a single `telemetry_opt_in` on enable
    /// and `telemetry_opt_out` on disable (the latter sent while still enabled,
    /// so nothing is transmitted after the user has opted out).
    pub fn set_enabled(&self, on: bool) {
        if self.inert {
            return;
        }
        let was = self.enabled.load(Ordering::Relaxed);
        if on && !was {
            self.enabled.store(true, Ordering::Relaxed);
            self.capture("telemetry_opt_in", json!({}));
        } else if !on && was {
            self.capture("telemetry_opt_out", json!({}));
            self.enabled.store(false, Ordering::Relaxed);
        }
    }

    /// Fire-and-forget capture. Instant no-op when inert/disabled; never blocks
    /// (drops on a full queue).
    pub fn capture(&self, event: &str, mut properties: Value) {
        if !self.is_enabled() {
            return;
        }
        let Some(tx) = self.tx.as_ref() else {
            return;
        };
        self.inject_common(&mut properties);
        let _ = tx.try_send(QueuedEvent {
            event: event.to_string(),
            properties,
            timestamp: now_iso(),
        });
    }

    /// Remember the latest cumulative usage for a session (stamped onto the
    /// next `agent_turn_finished`). No-op when inert.
    pub fn note_usage(&self, session_id: &str, usage: Value) {
        if self.inert {
            return;
        }
        self.last_usage.insert(session_id.to_string(), usage);
    }

    /// Take (and clear) the last recorded usage for a session.
    pub fn take_usage(&self, session_id: &str) -> Value {
        self.last_usage
            .remove(session_id)
            .map(|(_, v)| v)
            .unwrap_or(Value::Null)
    }

    /// Best-effort **synchronous** capture for the panic hook. Because the build
    /// is `panic = "abort"` the process dies right after the hook, so we can't
    /// rely on the async flush task. Runs the POST on a fresh OS thread (so a
    /// panic on a tokio worker can still spin up a tiny runtime) with a short
    /// timeout, and blocks until it finishes or times out.
    pub fn capture_panic_blocking(&self, mut properties: Value) {
        if !self.is_enabled() {
            return;
        }
        let Some(key) = self.api_key.clone() else {
            return;
        };
        self.inject_common(&mut properties);
        let url = format!("{}/capture/", self.host.trim_end_matches('/'));
        let body = json!({
            "api_key": key,
            "event": "rust_panic",
            "distinct_id": self.distinct_id,
            "properties": properties,
            "timestamp": now_iso(),
        });
        let handle = std::thread::spawn(move || {
            if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                rt.block_on(async move {
                    if let Ok(client) = reqwest::Client::builder()
                        .timeout(Duration::from_secs(2))
                        .build()
                    {
                        let _ = client.post(&url).json(&body).send().await;
                    }
                });
            }
        });
        let _ = handle.join();
    }

    fn inject_common(&self, properties: &mut Value) {
        if let Value::Object(map) = properties {
            map.entry("$lib")
                .or_insert_with(|| json!("atlas-rust"));
            map.entry("app_version")
                .or_insert_with(|| json!(self.app_version));
            map.entry("os").or_insert_with(|| json!(self.os));
            map.entry("arch").or_insert_with(|| json!(self.arch));
        }
    }
}

/// Drain the queue and POST batches to `{host}/batch/`. Owns the receiver; ends
/// when every sender is dropped.
pub(crate) async fn run_flush_loop(
    client: Arc<TelemetryClient>,
    mut rx: mpsc::Receiver<QueuedEvent>,
) {
    let Some(api_key) = client.api_key.clone() else {
        return;
    };
    let url = format!("{}/batch/", client.host.trim_end_matches('/'));
    let http = reqwest::Client::builder()
        .user_agent(concat!("Atlas/", env!("CARGO_PKG_VERSION"), " (telemetry)"))
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let mut buf: Vec<QueuedEvent> = Vec::new();
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            maybe = rx.recv() => {
                match maybe {
                    Some(ev) => {
                        buf.push(ev);
                        if buf.len() >= FLUSH_BATCH {
                            send_batch(&http, &url, &api_key, &client.distinct_id, &mut buf).await;
                        }
                    }
                    None => {
                        // All senders dropped — final flush then exit.
                        send_batch(&http, &url, &api_key, &client.distinct_id, &mut buf).await;
                        break;
                    }
                }
            }
            _ = ticker.tick() => {
                if !buf.is_empty() {
                    send_batch(&http, &url, &api_key, &client.distinct_id, &mut buf).await;
                }
            }
        }
    }
}

async fn send_batch(
    http: &reqwest::Client,
    url: &str,
    api_key: &str,
    distinct_id: &str,
    buf: &mut Vec<QueuedEvent>,
) {
    if buf.is_empty() {
        return;
    }
    let batch: Vec<Value> = buf
        .iter()
        .map(|e| {
            json!({
                "event": e.event,
                "distinct_id": distinct_id,
                "properties": e.properties,
                "timestamp": e.timestamp,
            })
        })
        .collect();
    let payload = json!({ "api_key": api_key, "batch": batch });
    // Fire-and-forget: a failed flush drops this batch rather than retrying
    // forever. Telemetry is best-effort by design.
    if let Err(e) = http.post(url).json(&payload).send().await {
        tracing::debug!(target: "atlas::telemetry", "batch flush failed: {e}");
    }
    buf.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_strips_paths_urls_and_truncates() {
        let r = redact_message("failed to read /Users/adib/secret.rs at line 4", 200);
        assert!(!r.contains("/Users"));
        assert!(r.contains("failed to read"));

        let r2 = redact_message("connect https://internal.example.com/x denied", 200);
        assert!(!r2.contains("https://"));
        assert!(r2.contains("denied"));

        let long = "x ".repeat(100);
        let r3 = redact_message(&long, 10);
        assert!(r3.chars().count() <= 11); // 10 + ellipsis
        assert!(r3.ends_with('…'));
    }

    #[test]
    fn redact_drops_home_and_email_tokens() {
        let r = redact_message("error for ~/Library/x and user@host.com here", 200);
        assert!(!r.contains('~'));
        assert!(!r.contains('@'));
        assert!(r.contains("error for"));
        assert!(r.contains("here"));
    }

    #[test]
    fn inert_client_is_a_total_no_op() {
        // No key, no channel → inert. Build the struct directly (resolve_keys
        // needs an AppHandle we don't have in a unit test).
        let c = TelemetryClient {
            enabled: AtomicBool::new(true),
            inert: true,
            api_key: None,
            host: DEFAULT_HOST.to_string(),
            using_default_key: false,
            distinct_id: "anon".into(),
            app_version: "0.0.0",
            os: "test",
            arch: "test",
            tx: None,
            last_usage: DashMap::new(),
        };
        assert!(!c.is_enabled());
        assert!(c.inert);
        // None of these may panic or transmit.
        c.capture("agent_turn_finished", json!({ "x": 1 }));
        c.set_enabled(true);
        c.set_enabled(false);
        c.note_usage("s1", json!({ "input_tokens": 5 }));
        assert_eq!(c.take_usage("s1"), Value::Null); // note_usage was a no-op
        let cfg = c.config();
        assert!(!cfg.enabled);
        assert!(cfg.key.is_none());
    }

    #[test]
    fn disabled_client_drops_events_but_records_nothing() {
        let (tx, mut rx) = mpsc::channel(8);
        let c = TelemetryClient {
            enabled: AtomicBool::new(false),
            inert: false,
            api_key: Some("phc_test".into()),
            host: DEFAULT_HOST.to_string(),
            using_default_key: true,
            distinct_id: "anon".into(),
            app_version: "0.0.0",
            os: "test",
            arch: "test",
            tx: Some(tx),
            last_usage: DashMap::new(),
        };
        c.capture("agent_turn_started", json!({}));
        assert!(rx.try_recv().is_err(), "disabled client must not enqueue");

        // Opt in → an opt-in event is queued and common props injected.
        c.set_enabled(true);
        let ev = rx.try_recv().expect("opt-in event");
        assert_eq!(ev.event, "telemetry_opt_in");
        assert_eq!(ev.properties["$lib"], json!("atlas-rust"));
        assert_eq!(ev.properties["app_version"], json!("0.0.0"));

        // Now a real capture flows through with usage round-trip.
        c.note_usage("s1", json!({ "input_tokens": 12 }));
        assert_eq!(c.take_usage("s1")["input_tokens"], json!(12));
        c.capture("agent_turn_finished", json!({ "agent_kind": "atlas" }));
        let ev2 = rx.try_recv().expect("finished event");
        assert_eq!(ev2.event, "agent_turn_finished");
        assert_eq!(ev2.properties["agent_kind"], json!("atlas"));
    }
}
