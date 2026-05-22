//! Claude Code install + auth setup commands.
//!
//! Three async commands the chat panel calls to gate the composer behind
//! a working `claude` CLI:
//!
//! - `claude_status` — fast, parallel probe: `claude --version` +
//!   `claude auth status`. Returns `installed` + `authenticated`.
//! - `claude_install` — long-running. Pipes `curl -fsSL
//!   https://claude.ai/install.sh | bash` and streams stdout/stderr lines
//!   as `atlas:claude-install:progress` window events; emits
//!   `atlas:claude-install:done` on child exit.
//! - `claude_auth_login` — branches on the user's chosen method.
//!   * `api_key`  — writes the key into the canonical claude config so the
//!     CLI picks it up the same way as if the user had run `claude /login`
//!     with the API-key option.
//!   * `subscription` — spawns `claude /login`, captures stdout for the
//!     OAuth URL line, opens it via the system browser (the CLI's local
//!     callback handler does the rest).
//!
//! All async + non-blocking on the NSApp main thread; subprocess I/O lives
//! on tokio + spawn_blocking where necessary.

use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as AsyncCommand;

// ─────────────────────────────────────────────────────────────────────────────
// claude_status
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub authenticated: bool,
    pub auth_summary: Option<String>,
}

/// Fast probe — runs `claude --version` and `claude auth status` in parallel.
/// Always returns a populated struct; never errors (an absent binary just
/// surfaces as `installed: false`).
#[tauri::command]
pub async fn claude_status() -> ClaudeStatus {
    let version_fut = AsyncCommand::new("claude").arg("--version").output();
    let auth_fut = AsyncCommand::new("claude").args(["auth", "status"]).output();

    let (version_res, auth_res) = tokio::join!(version_fut, auth_fut);

    let (installed, version) = match version_res {
        Ok(out) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (true, if raw.is_empty() { None } else { Some(raw) })
        }
        _ => (false, None),
    };

    if !installed {
        return ClaudeStatus {
            installed: false,
            version: None,
            authenticated: false,
            auth_summary: None,
        };
    }

    let (authenticated, auth_summary) = match auth_res {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let summary = stdout
                .lines()
                .find(|l| !l.trim().is_empty())
                .or_else(|| stderr.lines().find(|l| !l.trim().is_empty()))
                .map(|l| l.trim().to_string());
            (out.status.success(), summary)
        }
        Err(_) => (false, None),
    };

    ClaudeStatus {
        installed,
        version,
        authenticated,
        auth_summary,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// claude_install
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct InstallProgress {
    stream: &'static str, // "stdout" | "stderr"
    line: String,
}

#[derive(Debug, Clone, Serialize)]
struct InstallDone {
    success: bool,
    exit_code: Option<i32>,
}

const INSTALL_CMD: &str = "curl -fsSL https://claude.ai/install.sh | bash";

/// Runs the official Anthropic install script. Streams each line of
/// stdout/stderr as a `atlas:claude-install:progress` event so the banner
/// can show a live tail; emits `atlas:claude-install:done` when the child
/// exits. Returns immediately after the child is spawned + reader tasks
/// are running — the frontend awaits the `done` event, not this Result.
#[tauri::command]
pub async fn claude_install(app: AppHandle) -> Result<(), String> {
    tracing::info!(target: "atlas::claude_setup", "starting claude install");

    let mut child = AsyncCommand::new("bash")
        .args(["-c", INSTALL_CMD])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn install: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(out) = stdout {
        let app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_progress(&app, "stdout", line);
            }
        });
    }
    if let Some(err) = stderr {
        let app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_progress(&app, "stderr", line);
            }
        });
    }

    // Wait for child exit on a background task so the IPC reply isn't
    // blocked. Frontend listens for `atlas:claude-install:done`.
    let app_for_wait = app.clone();
    tokio::spawn(async move {
        let result = child.wait().await;
        let (success, exit_code) = match result {
            Ok(status) => (status.success(), status.code()),
            Err(e) => {
                tracing::warn!(target: "atlas::claude_setup", "wait failed: {e}");
                (false, None)
            }
        };
        let _ = app_for_wait.emit(
            "atlas:claude-install:done",
            InstallDone { success, exit_code },
        );
    });

    Ok(())
}

fn emit_progress(app: &AppHandle, stream: &'static str, line: String) {
    let _ = app.emit(
        "atlas:claude-install:progress",
        InstallProgress { stream, line },
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// claude_auth_login
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClaudeAuthMethod {
    ApiKey { value: String },
    Subscription,
}

/// Drive the `claude` CLI through one of its two login flows.
///
/// **API key path.** Writes the key to `~/.claude/.credentials.json` in the
/// shape the CLI itself maintains. If the file's schema evolves, the worst
/// case is the CLI ignores our key and the user has to run `claude /login`
/// manually — we never overwrite an existing logged-in credential without
/// the user opting in via this dialog.
///
/// **Subscription path.** Spawns `claude /login`, scans stdout for the
/// OAuth URL the CLI prints, opens it in the system browser via Tauri.
/// The CLI's local callback listener finishes the auth and writes its own
/// credential. Frontend polls `claude_status` until `authenticated == true`.
#[tauri::command]
pub async fn claude_auth_login(
    method: ClaudeAuthMethod,
    app: AppHandle,
) -> Result<(), String> {
    match method {
        ClaudeAuthMethod::ApiKey { value } => write_api_key_credentials(&value).await,
        ClaudeAuthMethod::Subscription => spawn_subscription_login(app).await,
    }
}

async fn write_api_key_credentials(key: &str) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("API key is empty".into());
    }

    let home = dirs::home_dir().ok_or_else(|| "could not resolve $HOME".to_string())?;
    let dir = home.join(".claude");
    let path = dir.join(".credentials.json");

    let key = trimmed.to_string();
    let path_for_task = path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir ~/.claude: {e}"))?;

        // Merge with any existing file so we don't clobber unrelated keys.
        let existing: serde_json::Value = std::fs::read_to_string(&path_for_task)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}));

        let mut obj = match existing {
            serde_json::Value::Object(m) => m,
            _ => serde_json::Map::new(),
        };
        obj.insert(
            "anthropicApiKey".into(),
            serde_json::Value::String(key.clone()),
        );
        // Some CLI versions read snake_case; write both for resilience.
        obj.insert(
            "anthropic_api_key".into(),
            serde_json::Value::String(key),
        );
        let value = serde_json::Value::Object(obj);

        let raw = serde_json::to_string_pretty(&value)
            .map_err(|e| format!("serialize credentials: {e}"))?;
        let tmp = path_for_task.with_extension("json.tmp");
        std::fs::write(&tmp, raw).map_err(|e| format!("write tmp: {e}"))?;
        std::fs::rename(&tmp, &path_for_task)
            .map_err(|e| format!("rename to credentials.json: {e}"))?;

        // Restrict to user-only — credentials file holds an API key.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&path_for_task) {
                let mut perms = meta.permissions();
                perms.set_mode(0o600);
                let _ = std::fs::set_permissions(&path_for_task, perms);
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    tracing::info!(
        target: "atlas::claude_setup",
        "wrote API key to {}",
        path.display()
    );
    Ok(())
}

async fn spawn_subscription_login(app: AppHandle) -> Result<(), String> {
    let mut child = AsyncCommand::new("claude")
        .args(["/login"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn `claude /login`: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Scan stdout for the first URL the CLI prints; open it.
    if let Some(out) = stdout {
        let app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            let mut opened = false;
            while let Ok(Some(line)) = lines.next_line().await {
                if !opened {
                    if let Some(url) = first_url(&line) {
                        opened = open_system_browser(&app, &url);
                    }
                }
                tracing::debug!(target: "atlas::claude_setup", "claude /login stdout: {line}");
            }
        });
    }

    if let Some(err) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "atlas::claude_setup", "claude /login stderr: {line}");
            }
        });
    }

    // Don't block IPC on the CLI completing — the frontend polls
    // `claude_status` until `authenticated == true`.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    Ok(())
}

fn first_url(line: &str) -> Option<String> {
    let start = line
        .find("https://")
        .or_else(|| line.find("http://"))?;
    let tail = &line[start..];
    let end = tail
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ')')
        .unwrap_or(tail.len());
    Some(line[start..start + end].to_string())
}

fn open_system_browser(app: &AppHandle, url: &str) -> bool {
    use tauri_plugin_opener::OpenerExt;
    match app.opener().open_url(url, None::<&str>) {
        Ok(()) => {
            tracing::info!(target: "atlas::claude_setup", "opened auth URL in browser");
            true
        }
        Err(e) => {
            tracing::warn!(target: "atlas::claude_setup", "open_url failed: {e}");
            false
        }
    }
}

