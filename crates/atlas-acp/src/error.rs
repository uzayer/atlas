use thiserror::Error;

pub type Result<T> = std::result::Result<T, AcpError>;

#[derive(Debug, Error)]
pub enum AcpError {
    #[error("unknown agent id")]
    UnknownAgent,
    #[error("unknown session id")]
    UnknownSession,
    #[error("unknown agent spec: {0}")]
    UnknownSpec(String),
    #[error("agent driver disconnected")]
    DriverDown,
    #[error("permission request {0} not pending")]
    UnknownPermissionRequest(uuid::Uuid),
    #[error("acp protocol error: {0}")]
    Protocol(String),
    #[error("invalid agent command: {0}")]
    InvalidCommand(String),
    #[error("{rpc} timed out after {secs}s (agent unresponsive)")]
    Timeout { rpc: &'static str, secs: u64 },
    #[error("{0}")]
    Other(String),
}

impl From<agent_client_protocol::Error> for AcpError {
    fn from(e: agent_client_protocol::Error) -> Self {
        AcpError::Protocol(format!("{e:?}"))
    }
}

impl AcpError {
    pub fn other(msg: impl Into<String>) -> Self {
        AcpError::Other(msg.into())
    }
}

impl serde::Serialize for AcpError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
