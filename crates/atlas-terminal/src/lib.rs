use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use uuid::Uuid;

pub struct TerminalSession {
    /// Kept alive (rather than dropped after taking the writer/reader) so
    /// `resize` can drive `MasterPty::resize` — the previous build dropped
    /// the pair and resize was a silent no-op, leaving columns clipped after
    /// a pane resize.
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// PID of the spawned login shell. Used by `cwd` to resolve relative file
    /// paths clicked in the terminal against the shell's live directory.
    pid: Option<u32>,
    _reader_handle: std::thread::JoinHandle<()>,
}

pub struct TerminalManager {
    sessions: HashMap<String, TerminalSession>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TerminalOutput {
    pub id: String,
    pub data: Vec<u8>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn create_session(
        &mut self,
        cols: u16,
        rows: u16,
        cwd: Option<&str>,
        sender: mpsc::UnboundedSender<TerminalOutput>,
    ) -> anyhow::Result<String> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let shell = detect_shell();
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l"); // login shell — sources the user's profile so PATH etc. are correct
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }

        // Set TERM for proper terminal behavior.
        cmd.env("TERM", "xterm-256color");
        // Ensure a UTF-8 locale even if the user's profile doesn't set one,
        // so box-drawing / multi-byte glyphs render correctly.
        if std::env::var_os("LANG").is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }

        let child = pair.slave.spawn_command(cmd)?;
        let pid = child.process_id();
        drop(child); // the pty keeps the process alive; we only needed the pid
        drop(pair.slave); // drop slave so reads on master detect EOF

        let writer = pair.master.take_writer()?;
        let mut reader = pair.master.try_clone_reader()?;
        // Retain the master so resize works for the session's lifetime.
        let master = Arc::new(Mutex::new(pair.master));

        let id = Uuid::new_v4().to_string();
        let session_id = id.clone();

        let reader_handle = std::thread::spawn(move || {
            // 64 KiB read buffer (was 4 KiB) — fewer syscalls / channel sends
            // on high-throughput output (builds, `cat` of large files).
            let mut buf = vec![0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let output = TerminalOutput {
                            id: session_id.clone(),
                            data: buf[..n].to_vec(),
                        };
                        if sender.send(output).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        self.sessions.insert(
            id.clone(),
            TerminalSession {
                master,
                writer: Arc::new(Mutex::new(writer)),
                pid,
                _reader_handle: reader_handle,
            },
        );

        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Terminal session not found: {}", id))?;
        let mut writer = session.writer.lock().unwrap();
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Terminal session not found: {}", id))?;
        let master = session
            .master
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal master mutex poisoned"))?;
        master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn close(&mut self, id: &str) {
        self.sessions.remove(id);
    }

    pub fn has_session(&self, id: &str) -> bool {
        self.sessions.contains_key(id)
    }

    /// PID of the session's login shell (for `cwd_of_pid`).
    pub fn pid(&self, id: &str) -> Option<u32> {
        self.sessions.get(id)?.pid
    }
}

/// The live working directory of a shell pid, used to resolve relative file
/// paths clicked in the terminal. Linux reads the `/proc/<pid>/cwd` symlink;
/// macOS shells out to `lsof` (no `/proc`). BLOCKING (lsof) — call off-thread.
pub fn cwd_of_pid(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/cwd"))
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }
    #[cfg(target_os = "macos")]
    {
        // `lsof -a -d cwd -p <pid> -Fn` prints `n<path>` for the cwd fd.
        let out = std::process::Command::new("lsof")
            .args(["-a", "-d", "cwd", "-p", &pid.to_string(), "-Fn"])
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout);
        s.lines()
            .find_map(|l| l.strip_prefix('n').map(|p| p.to_string()))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

fn detect_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}
