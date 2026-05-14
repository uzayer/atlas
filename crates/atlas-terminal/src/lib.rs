use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use uuid::Uuid;

pub struct TerminalSession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
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
        cmd.arg("-l"); // login shell
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }

        // Set TERM for proper terminal behavior
        cmd.env("TERM", "xterm-256color");

        let _child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave); // drop slave so reads on master detect EOF

        let writer = pair.master.take_writer()?;
        let mut reader = pair.master.try_clone_reader()?;

        let id = Uuid::new_v4().to_string();
        let session_id = id.clone();

        let reader_handle = std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
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
                writer: Arc::new(Mutex::new(writer)),
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

    pub fn resize(&self, id: &str, _cols: u16, _rows: u16) -> anyhow::Result<()> {
        // portable-pty resize is handled through the master pair
        // which we've already consumed. For now this is a no-op.
        // A future version can store the master for resize support.
        let _ = self.sessions.get(id);
        Ok(())
    }

    pub fn close(&mut self, id: &str) {
        self.sessions.remove(id);
    }

    pub fn has_session(&self, id: &str) -> bool {
        self.sessions.contains_key(id)
    }
}

fn detect_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}
