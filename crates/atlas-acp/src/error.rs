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

/// How a failure should be handled — the shared taxonomy (Zed §2.3) used by
/// the actor to annotate `TurnFailed` and by the frontend to route auth
/// failures to the sign-in flow instead of a generic banner. The NATIVE
/// retry decision lives in the vendored `cersei_agent::retry` (the runner
/// can't depend on this crate); this classifier is for display/routing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// Worth retrying with backoff (rate limit / overload / IO hiccup).
    Transient,
    /// Needs (re)authentication — never retried, routed to the auth flow.
    Auth,
    /// Will never succeed as-is (bad request / too large / no key).
    Fatal,
    /// The agent process or connection died — Phase 5 disconnect handling.
    ProcessDead,
    /// Nothing recognizable — treated as fatal for retry purposes.
    Unknown,
}

impl ErrorClass {
    /// Wire token for `TurnFailed.error_kind` (additive, optional field).
    pub fn wire_token(self) -> &'static str {
        match self {
            ErrorClass::Transient => "transient",
            ErrorClass::Auth => "auth",
            ErrorClass::Fatal => "fatal",
            ErrorClass::ProcessDead => "process_dead",
            ErrorClass::Unknown => "unknown",
        }
    }
}

/// Classify an error message string (provider bodies, adapter errors).
pub fn classify_message(message: &str) -> ErrorClass {
    let m = message.to_ascii_lowercase();
    const AUTH: &[&str] = &[
        "http 401",
        "http 403",
        "authentication",
        "unauthorized",
        "invalid x-api-key",
        "invalid api key",
        "api key not",
        "permission_error",
        "no api key configured",
        "auth required",
        "not authenticated",
        "please run /login",
    ];
    if AUTH.iter().any(|t| m.contains(t)) {
        return ErrorClass::Auth;
    }
    const FATAL: &[&str] = &[
        "http 400",
        "invalid_request",
        "http 413",
        "prompt is too long",
        "too large",
        "credit balance is too low",
        "billing",
        "no model selected",
    ];
    if FATAL.iter().any(|t| m.contains(t)) {
        return ErrorClass::Fatal;
    }
    const DEAD: &[&str] = &[
        "agent disconnected",
        "driver disconnected",
        "driver exited",
        "process exited",
        "channel closed",
    ];
    if DEAD.iter().any(|t| m.contains(t)) {
        return ErrorClass::ProcessDead;
    }
    const TRANSIENT: &[&str] = &[
        "http 429",
        "rate limit",
        "rate_limit",
        "http 529",
        "http 503",
        "overloaded",
        "service unavailable",
        "http 500",
        "http 502",
        "http 504",
        "internal server error",
        "timed out",
        "timeout",
        "connection refused",
        "connection reset",
        "error sending request",
        "error decoding",
        "failed to decode response",
        "gave up after",
    ];
    if TRANSIENT.iter().any(|t| m.contains(t)) {
        return ErrorClass::Transient;
    }
    ErrorClass::Unknown
}

impl AcpError {
    /// Classify this error for display/routing (see [`ErrorClass`]).
    pub fn class(&self) -> ErrorClass {
        match self {
            AcpError::Timeout { .. } => ErrorClass::Transient,
            AcpError::DriverDown => ErrorClass::ProcessDead,
            AcpError::UnknownAgent | AcpError::UnknownSession => ErrorClass::ProcessDead,
            AcpError::Protocol(m) | AcpError::Other(m) => classify_message(m),
            _ => ErrorClass::Unknown,
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_driven_classification() {
        let cases: &[(&str, ErrorClass)] = &[
            ("HTTP 429: rate_limit_error", ErrorClass::Transient),
            ("HTTP 529: overloaded_error", ErrorClass::Transient),
            ("HTTP 503: Service Unavailable", ErrorClass::Transient),
            ("request timed out", ErrorClass::Transient),
            ("error sending request for url", ErrorClass::Transient),
            ("HTTP 429: x (gave up after 4 attempts)", ErrorClass::Transient),
            ("HTTP 401: authentication_error", ErrorClass::Auth),
            ("HTTP 403: permission_error", ErrorClass::Auth),
            ("invalid x-api-key", ErrorClass::Auth),
            ("No API key configured for 'anthropic'. Add one in Settings.", ErrorClass::Auth),
            ("Auth required — please run /login", ErrorClass::Auth),
            ("HTTP 400: invalid_request_error", ErrorClass::Fatal),
            ("HTTP 413: prompt is too long", ErrorClass::Fatal),
            ("agent disconnected: driver exited cleanly", ErrorClass::ProcessDead),
            ("some novel failure", ErrorClass::Unknown),
        ];
        for (msg, want) in cases {
            assert_eq!(classify_message(msg), *want, "for {msg:?}");
        }
    }

    #[test]
    fn typed_errors_classify() {
        assert_eq!(
            AcpError::Timeout { rpc: "session/set_mode", secs: 10 }.class(),
            ErrorClass::Transient
        );
        assert_eq!(AcpError::DriverDown.class(), ErrorClass::ProcessDead);
        assert_eq!(
            AcpError::Other("HTTP 401: authentication_error".into()).class(),
            ErrorClass::Auth
        );
    }
}
