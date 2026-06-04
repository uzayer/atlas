use atlas_terminal::TerminalManager;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};

pub struct TerminalState {
    pub manager: Arc<Mutex<TerminalManager>>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self {
            manager: Arc::new(Mutex::new(TerminalManager::new())),
        }
    }
}

#[tauri::command]
pub async fn terminal_create(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    let (tx, mut rx) = mpsc::unbounded_channel::<atlas_terminal::TerminalOutput>();

    let id = {
        let mut manager = state.manager.lock().await;
        manager
            .create_session(cols, rows, cwd.as_deref(), tx)
            .map_err(|e| e.to_string())?
    };

    // Spawn a task to forward PTY output, batching reads at ~16ms intervals (60fps)
    let app_handle = app.clone();
    let session_id = id.clone();
    tokio::spawn(async move {
        let mut buf: Vec<u8> = Vec::with_capacity(8192);
        loop {
            // Wait for first chunk
            match rx.recv().await {
                Some(output) => buf.extend_from_slice(&output.data),
                None => break,
            }
            // Drain any additional pending data without waiting
            while let Ok(output) = rx.try_recv() {
                buf.extend_from_slice(&output.data);
                // Cap batch size to avoid huge single events
                if buf.len() > 65536 { break; }
            }
            // Emit batched data
            let _ = app_handle.emit("terminal-output", &atlas_terminal::TerminalOutput {
                id: session_id.clone(),
                data: std::mem::take(&mut buf),
            });
        }
        let _ = app_handle.emit(
            "terminal-exit",
            serde_json::json!({ "id": session_id }),
        );
    });

    Ok(id)
}

/// The zsh shell-integration ZDOTDIR, so the frontend can relaunch an
/// interactive root shell (`sudo -s`/`-i`/`su`) with the same integration.
#[tauri::command]
pub fn terminal_zsh_dir() -> Option<String> {
    atlas_terminal::zsh_integration_dir().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, TerminalState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let manager = state.manager.lock().await;
    manager.write(&id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let manager = state.manager.lock().await;
    manager.resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_close(
    state: State<'_, TerminalState>,
    id: String,
) -> Result<(), String> {
    let mut manager = state.manager.lock().await;
    manager.close(&id);
    Ok(())
}

/// Resolve a path token clicked in the terminal to an existing absolute path,
/// or `None`. Strips a trailing `:line[:col]` suffix, expands `~`, resolves a
/// relative path against the shell's live cwd, and verifies the file exists
/// (so non-path matches in the link regex silently no-op). Blocking (lsof +
/// stat), so run off the main thread.
#[tauri::command]
pub async fn terminal_resolve_path(
    state: State<'_, TerminalState>,
    id: String,
    raw: String,
) -> Result<Option<String>, String> {
    let pid = {
        let manager = state.manager.lock().await;
        manager.pid(&id)
    };
    tokio::task::spawn_blocking(move || {
        let base = pid.and_then(atlas_terminal::cwd_of_pid);
        resolve_path_with_base(base.as_deref(), &raw)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Resolve a path token against an EXPLICIT base directory (e.g. a historical
/// command block's captured cwd), returning the existing absolute path or None.
#[tauri::command]
pub async fn resolve_path(base: String, raw: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || resolve_path_with_base(Some(&base), &raw))
        .await
        .map_err(|e| e.to_string())
}

fn resolve_path_with_base(base: Option<&str>, raw: &str) -> Option<String> {
    use std::path::PathBuf;

    let mut s = raw.trim().to_string();
    // Trim trailing punctuation that commonly abuts a path in prose/output.
    s = s
        .trim_end_matches(['.', ',', ';', ')', ']', '"', '\''])
        .to_string();
    // Strip up to two trailing `:NN` (line, col) segments.
    for _ in 0..2 {
        if let Some(idx) = s.rfind(':') {
            let tail = &s[idx + 1..];
            if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
                s.truncate(idx);
                continue;
            }
        }
        break;
    }
    if s.is_empty() {
        return None;
    }

    let path: PathBuf = if s == "~" {
        dirs::home_dir()?
    } else if let Some(rest) = s.strip_prefix("~/") {
        dirs::home_dir()?.join(rest)
    } else if s.starts_with('/') {
        PathBuf::from(&s)
    } else {
        // Relative — resolve against the provided base directory.
        let cwd = base?;
        PathBuf::from(cwd).join(s.strip_prefix("./").unwrap_or(&s))
    };

    let canon = std::fs::canonicalize(&path).ok()?;
    Some(canon.to_string_lossy().into_owned())
}

// ── Autocomplete (command + path) for the terminal command input ────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct PathCompletion {
    pub name: String,
    pub is_dir: bool,
}

/// Complete a path token (relative to `cwd`) for the terminal input. Splits the
/// token at the last `/` into a directory part and a filename prefix, resolves
/// the directory (expanding `~`, honouring absolute / cwd-relative), lists it,
/// and returns entries whose name starts with the prefix (case-insensitive).
/// Hidden entries are included only when the prefix itself starts with `.`.
#[tauri::command]
pub async fn terminal_path_complete(
    cwd: String,
    token: String,
) -> Result<Vec<PathCompletion>, String> {
    tokio::task::spawn_blocking(move || path_complete(&cwd, &token))
        .await
        .map_err(|e| e.to_string())
}

fn path_complete(cwd: &str, token: &str) -> Vec<PathCompletion> {
    use std::path::PathBuf;

    let (dir_part, prefix) = match token.rfind('/') {
        Some(i) => (&token[..=i], &token[i + 1..]),
        None => ("", token),
    };

    let base: PathBuf = if dir_part.is_empty() {
        PathBuf::from(cwd)
    } else if dir_part == "~" || dir_part == "~/" {
        match dirs::home_dir() {
            Some(h) => h,
            None => return Vec::new(),
        }
    } else if let Some(rest) = dir_part.strip_prefix("~/") {
        match dirs::home_dir() {
            Some(h) => h.join(rest),
            None => return Vec::new(),
        }
    } else if dir_part.starts_with('/') {
        PathBuf::from(dir_part)
    } else {
        PathBuf::from(cwd).join(dir_part.strip_prefix("./").unwrap_or(dir_part))
    };

    let read = match std::fs::read_dir(&base) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let pl = prefix.to_lowercase();
    let want_hidden = prefix.starts_with('.');
    let mut out: Vec<PathCompletion> = Vec::new();
    for entry in read {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && !want_hidden {
            continue;
        }
        if !pl.is_empty() && !name.to_lowercase().starts_with(&pl) {
            continue;
        }
        // `is_dir()` follows symlinks so a symlinked directory still completes
        // with a trailing slash.
        let is_dir = entry.path().is_dir();
        out.push(PathCompletion { name, is_dir });
    }
    // Directories first, then case-insensitive alphabetical.
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out.truncate(50);
    out
}

/// Executable names on `$PATH` + a curated builtin list, deduped + sorted.
/// Scanned once and cached for the process lifetime (`$PATH` rarely changes).
#[tauri::command]
pub async fn terminal_list_commands() -> Result<Vec<String>, String> {
    use std::sync::OnceLock;
    static COMMANDS: OnceLock<Vec<String>> = OnceLock::new();
    if let Some(c) = COMMANDS.get() {
        return Ok(c.clone());
    }
    let list = tokio::task::spawn_blocking(scan_commands)
        .await
        .map_err(|e| e.to_string())?;
    Ok(COMMANDS.get_or_init(|| list).clone())
}

const SHELL_BUILTINS: &[&str] = &[
    "cd", "pwd", "echo", "export", "alias", "unalias", "source", ".", "exit", "history",
    "jobs", "fg", "bg", "kill", "set", "unset", "which", "type", "clear", "pushd", "popd",
    "dirs", "read", "trap", "wait", "umask", "let", "local", "return", "eval", "exec", "time",
];

fn scan_commands() -> Vec<String> {
    use std::collections::BTreeSet;
    let mut set: BTreeSet<String> = SHELL_BUILTINS.iter().map(|s| s.to_string()).collect();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(path) = std::env::var("PATH") {
            for dir in path.split(':').filter(|d| !d.is_empty()) {
                let Ok(read) = std::fs::read_dir(dir) else { continue };
                for entry in read {
                    let Ok(entry) = entry else { continue };
                    let Ok(meta) = entry.metadata() else { continue };
                    if meta.is_dir() {
                        continue;
                    }
                    if meta.permissions().mode() & 0o111 == 0 {
                        continue;
                    }
                    set.insert(entry.file_name().to_string_lossy().into_owned());
                }
            }
        }
    }
    set.into_iter().collect()
}
