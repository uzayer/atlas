//! In-app auto-updater (macOS DMG).
//!
//! Atlas ships as an Apple-signed + notarized + stapled `.dmg`. There is no
//! Tauri-updater `.app.tar.gz`/minisign artifact, so we do **not** use the Tauri
//! updater plugin — instead this module checks PostHog remote config for the
//! latest version + DMG URL, and, on the user's choice, downloads the DMG,
//! verifies its Apple code signature (the trust anchor), and swaps the running
//! `Atlas.app` bundle in place.
//!
//! - `version` / `uri` come from PostHog remote config via
//!   [`TelemetryClient::fetch_remote_config`] (works even when telemetry is
//!   opted out — updates are not analytics).
//! - The check runs non-blocking on every startup ([`check_in_background`]),
//!   gated on the `auto_update` preference and the "ignored version".
//! - The frontend renders the prompt and drives install via commands.
//!
//! Events emitted to the frontend:
//!   `atlas:update-available` `{ version, currentVersion }`
//!   `atlas:update-progress`  `{ downloaded, total }`
//!   `atlas:update-error`     `{ message, dmgOpened }`

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use futures::StreamExt;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{AppState, AppStateHandle};
use crate::telemetry::{RemoteUpdateConfig, TelemetryClient};

/// The running app's version (compile-time). Compared against the remote value.
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Apple Team ID the downloaded DMG's app MUST be signed by, or we refuse to
/// install it — the security anchor for the whole update, since the DMG is
/// fetched over an attacker-controllable remote-config URL.
const EXPECTED_TEAM_ID: &str = "PLKDA3WBJJ";

/// Holds the latest `{version, uri}` seen by a check, so `update_install` can
/// act on it without re-fetching remote config.
#[derive(Default)]
pub struct UpdaterState {
    pending: Mutex<Option<RemoteUpdateConfig>>,
}

impl UpdaterState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub available: bool,
    pub version: Option<String>,
    pub current_version: String,
}

/// Semver "is `remote` strictly newer than `current`?". Returns false if either
/// side fails to parse (never prompt on garbage).
fn is_newer(remote: &str, current: &str) -> bool {
    match (
        semver::Version::parse(remote.trim()),
        semver::Version::parse(current.trim()),
    ) {
        (Ok(r), Ok(c)) => r > c,
        _ => false,
    }
}

/// Read a snapshot of the two updater-relevant settings.
fn read_settings(app: &AppHandle) -> (bool, Option<String>) {
    let state = app.state::<AppStateHandle>();
    let guard = state.lock();
    (
        guard.settings.auto_update,
        guard.settings.updater_ignored_version.clone(),
    )
}

/// Fetch remote config via the shared telemetry client (key/host reuse).
async fn fetch_remote(app: &AppHandle) -> Option<RemoteUpdateConfig> {
    let tel = app.state::<Arc<TelemetryClient>>().inner().clone();
    tel.fetch_remote_config().await
}

/// Emit the "backend is / isn't checking for updates" signal (drives the
/// titlebar loading indicator).
fn emit_checking(app: &AppHandle, checking: bool) {
    let _ = app.emit("atlas:update-checking", serde_json::json!({ "checking": checking }));
}

/// Non-blocking startup check. Honors the `auto_update` toggle + ignored
/// version; emits `atlas:update-available` when a newer version exists.
pub fn check_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (auto, ignored) = read_settings(&app);
        if !auto {
            return;
        }
        emit_checking(&app, true);
        let cfg = fetch_remote(&app).await;
        emit_checking(&app, false);
        let Some(cfg) = cfg else {
            return;
        };
        if !is_newer(&cfg.version, CURRENT_VERSION) {
            return;
        }
        if ignored.as_deref() == Some(cfg.version.as_str()) {
            return;
        }
        *app.state::<UpdaterState>().pending.lock() = Some(cfg.clone());
        let _ = app.emit(
            "atlas:update-available",
            serde_json::json!({
                "version": cfg.version,
                "currentVersion": CURRENT_VERSION,
            }),
        );
    });
}

/// Manual "Check for updates" (Settings). Ignores the auto_update / ignored-
/// version gates — an explicit user action always re-checks. Emits
/// `atlas:update-available` (so the same modal shows) when newer.
#[tauri::command]
pub async fn update_check_now(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<UpdateStatus, String> {
    emit_checking(&app, true);
    let cfg = fetch_remote(&app).await;
    emit_checking(&app, false);
    let available = cfg
        .as_ref()
        .map(|c| is_newer(&c.version, CURRENT_VERSION))
        .unwrap_or(false);
    let version = cfg.as_ref().map(|c| c.version.clone());
    if available {
        let cfg = cfg.unwrap();
        *state.pending.lock() = Some(cfg.clone());
        let _ = app.emit(
            "atlas:update-available",
            serde_json::json!({
                "version": cfg.version,
                "currentVersion": CURRENT_VERSION,
            }),
        );
    }
    Ok(UpdateStatus {
        available,
        version,
        current_version: CURRENT_VERSION.to_string(),
    })
}

/// Persist a "don't prompt for this version again" choice.
#[tauri::command]
pub fn update_ignore(
    version: String,
    app: AppHandle,
    state: State<'_, AppStateHandle>,
) -> Result<(), String> {
    let snapshot = {
        let mut guard = state.lock();
        guard.settings.updater_ignored_version = Some(version);
        guard.clone()
    };
    let app2 = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = AppState::save(&app2, &snapshot) {
            tracing::warn!(target: "atlas::updater", "save ignored version failed: {e}");
        }
    });
    Ok(())
}

/// Download + install the pending update's DMG. `relaunch=true` restarts into
/// the new version immediately ("Install now"); `false` swaps the bundle and
/// returns, so the *next* launch is the new version ("Install on next launch").
#[tauri::command]
pub async fn update_install(
    relaunch: bool,
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<(), String> {
    // Resolve the DMG URL — prefer the cached pending config, else re-fetch.
    // Scope the guard so it isn't held across the await (keeps the future Send).
    let pending = { state.pending.lock().clone() };
    let cfg = match pending {
        Some(c) => c,
        None => fetch_remote(&app)
            .await
            .ok_or_else(|| "no update information available".to_string())?,
    };

    let app_bg = app.clone();
    let install = tauri::async_runtime::spawn_blocking(move || install_dmg(&app_bg, &cfg.uri))
        .await
        .map_err(|e| format!("install task join: {e}"))?;

    match install {
        Ok(()) => {
            if relaunch {
                app.restart();
            }
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(
                "atlas:update-error",
                serde_json::json!({ "message": e, "dmgOpened": false }),
            );
            Err(e)
        }
    }
}

/// The blocking DMG install pipeline: download → mount → verify Apple signature
/// → swap the app bundle → detach. On a swap failure, opens the DMG for a manual
/// drag-install and reports it.
fn install_dmg(app: &AppHandle, uri: &str) -> Result<(), String> {
    let tmp_dir = std::env::temp_dir().join(format!("atlas-update-{}", std::process::id()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("temp dir: {e}"))?;
    let dmg_path = tmp_dir.join("Atlas-update.dmg");

    // 1. Download (streamed, with progress). A tiny current-thread runtime keeps
    //    this whole routine synchronous/blocking-friendly.
    download_blocking(app, uri, &dmg_path).map_err(|e| {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        e
    })?;

    // 2. Mount read-only, no Finder window.
    let mount_point = tmp_dir.join("mnt");
    std::fs::create_dir_all(&mount_point).map_err(|e| format!("mount dir: {e}"))?;
    let out = Command::new("hdiutil")
        .args(["attach", "-nobrowse", "-readonly", "-mountpoint"])
        .arg(&mount_point)
        .arg(&dmg_path)
        .output()
        .map_err(|e| format!("hdiutil attach: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(format!(
            "failed to mount update DMG: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    // Everything past mount must detach before returning.
    let result = install_from_mount(app, &mount_point, &dmg_path);

    let _ = Command::new("hdiutil")
        .args(["detach", "-quiet"])
        .arg(&mount_point)
        .output();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// Verify + swap, given a mounted DMG volume.
fn install_from_mount(app: &AppHandle, mount_point: &Path, dmg_path: &Path) -> Result<(), String> {
    // Find `*.app` at the volume root.
    let src_app = std::fs::read_dir(mount_point)
        .map_err(|e| format!("read mount: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.extension().map(|x| x == "app").unwrap_or(false))
        .ok_or_else(|| "no .app found in the update DMG".to_string())?;

    // 3. Verify the Apple signature + team id BEFORE trusting the payload.
    verify_signature(&src_app)?;

    // 4. Resolve the running install location (…/Atlas.app).
    let dest_app = current_app_bundle()?;

    // 5. Swap: back up the current bundle, ditto the new one into place. On any
    //    failure, restore from backup and fall back to opening the DMG.
    let backup = dest_app.with_extension("app.bak");
    let _ = std::fs::remove_dir_all(&backup);
    if dest_app.exists() {
        std::fs::rename(&dest_app, &backup)
            .map_err(|e| swap_fallback(app, dmg_path, format!("back up current app: {e}")))?;
    }
    let out = Command::new("ditto")
        .arg(&src_app)
        .arg(&dest_app)
        .output()
        .map_err(|e| format!("ditto: {e}"));
    match out {
        Ok(o) if o.status.success() => {
            let _ = std::fs::remove_dir_all(&backup);
            Ok(())
        }
        other => {
            // Restore the original bundle, then fall back.
            if backup.exists() {
                let _ = std::fs::remove_dir_all(&dest_app);
                let _ = std::fs::rename(&backup, &dest_app);
            }
            let detail = match other {
                Ok(o) => String::from_utf8_lossy(&o.stderr).trim().to_string(),
                Err(e) => e,
            };
            Err(swap_fallback(app, dmg_path, format!("install failed: {detail}")))
        }
    }
}

/// Open the downloaded DMG in Finder so the user can drag-install manually, and
/// return an error string that says so. Used when the in-place swap can't run
/// (e.g. the app dir isn't user-writable).
fn swap_fallback(app: &AppHandle, dmg_path: &Path, reason: String) -> String {
    use tauri_plugin_opener::OpenerExt;
    let opened = app
        .opener()
        .open_path(dmg_path.to_string_lossy(), None::<&str>)
        .is_ok();
    let _ = app.emit(
        "atlas:update-error",
        serde_json::json!({ "message": reason, "dmgOpened": opened }),
    );
    if opened {
        format!("{reason} — opened the installer so you can update manually")
    } else {
        reason
    }
}

/// `codesign --verify --deep --strict` + Team ID match + `spctl` Gatekeeper
/// assessment. All three must pass.
fn verify_signature(app_path: &Path) -> Result<(), String> {
    let verify = Command::new("codesign")
        .args(["--verify", "--deep", "--strict", "--verbose=2"])
        .arg(app_path)
        .output()
        .map_err(|e| format!("codesign: {e}"))?;
    if !verify.status.success() {
        return Err("update rejected: code signature invalid".into());
    }

    // Team ID gate — the update must be signed by Atlas's Apple team.
    let info = Command::new("codesign")
        .args(["-dvvv"])
        .arg(app_path)
        .output()
        .map_err(|e| format!("codesign -dvvv: {e}"))?;
    // codesign writes the signing info to stderr.
    let meta = String::from_utf8_lossy(&info.stderr);
    let team_ok = meta
        .lines()
        .any(|l| l.trim() == format!("TeamIdentifier={EXPECTED_TEAM_ID}"));
    if !team_ok {
        return Err("update rejected: unexpected signing team".into());
    }

    let spctl = Command::new("spctl")
        .args(["--assess", "--type", "execute", "--verbose=2"])
        .arg(app_path)
        .output()
        .map_err(|e| format!("spctl: {e}"))?;
    if !spctl.status.success() {
        return Err("update rejected: notarization check failed".into());
    }
    Ok(())
}

/// Resolve the running `Atlas.app` bundle root from the executable path
/// (`…/Atlas.app/Contents/MacOS/atlas` → `…/Atlas.app`).
fn current_app_bundle() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    // Strip MacOS/<bin>, Contents, then we're at the .app.
    let app = exe
        .parent() // MacOS
        .and_then(|p| p.parent()) // Contents
        .and_then(|p| p.parent()) // Atlas.app
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "could not resolve app bundle path".to_string())?;
    if app.extension().map(|x| x == "app").unwrap_or(false) {
        Ok(app)
    } else {
        Err(format!(
            "running from a non-.app location ({}); update via the DMG",
            app.display()
        ))
    }
}

/// Streamed download with `atlas:update-progress` events, on a small runtime so
/// the caller stays a plain blocking fn.
fn download_blocking(app: &AppHandle, uri: &str, dest: &Path) -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("runtime: {e}"))?;
    rt.block_on(async move {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let resp = client
            .get(uri)
            .send()
            .await
            .map_err(|e| format!("download: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("download failed: HTTP {}", resp.status()));
        }
        let total = resp.content_length().unwrap_or(0);
        let mut file = std::fs::File::create(dest).map_err(|e| format!("create dmg: {e}"))?;
        let mut downloaded: u64 = 0;
        let mut stream = resp.bytes_stream();
        let mut last_emit: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("download chunk: {e}"))?;
            use std::io::Write;
            file.write_all(&chunk).map_err(|e| format!("write dmg: {e}"))?;
            downloaded += chunk.len() as u64;
            // Throttle emits to ~every 1 MB to avoid flooding the event bus.
            if downloaded - last_emit >= 1_048_576 || downloaded == total {
                last_emit = downloaded;
                let _ = app.emit(
                    "atlas:update-progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            }
        }
        Ok(())
    })
}
