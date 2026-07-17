//! Vertical-slice smoke test for the ACP integration.
//!
//! Spawns a real ACP agent (defaults to `npx -y @agentclientprotocol/claude-agent-acp`),
//! initializes the protocol, opens a session in the current working directory,
//! sends one prompt, prints every `SessionUpdate` it streams back, and exits on
//! the prompt's `stop_reason`.
//!
//! ```bash
//! ANTHROPIC_API_KEY=... cargo run -p atlas-acp --example smoke
//! ACP_COMMAND="claude-code-acp-rs"            cargo run -p atlas-acp --example smoke
//! ACP_PROMPT="What is 2 + 2?"                 cargo run -p atlas-acp --example smoke
//! ```

use std::path::PathBuf;
use std::str::FromStr;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome,
    SessionNotification, TextContent,
};
// ACP 1.x folds the subprocess + line-framed JSON-RPC transport (`AcpAgent`) and
// the debug-callback `LineDirection` enum into the protocol crate root (they
// used to live in the separate `agent-client-protocol-tokio` helper). The driver
// in `src/driver.rs` imports them the same way.
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo, LineDirection};

const DEFAULT_COMMAND: &str = "npx -y @agentclientprotocol/claude-agent-acp";
const DEFAULT_PROMPT: &str = "Say hello in exactly one short sentence.";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let command = std::env::var("ACP_COMMAND").unwrap_or_else(|_| DEFAULT_COMMAND.into());
    let prompt = std::env::var("ACP_PROMPT").unwrap_or_else(|_| DEFAULT_PROMPT.into());

    eprintln!("🚀 Spawning agent: {command}");
    let agent = AcpAgent::from_str(&command)?.with_debug(|line, direction| match direction {
        LineDirection::Stderr => eprintln!("⚠️  agent[stderr]: {line}"),
        LineDirection::Stdin => eprintln!("→ {line}"),
        LineDirection::Stdout => eprintln!("← {line}"),
    });

    agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                eprintln!("📨 update: {:?}", notification.update);
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                eprintln!("🔐 permission request: {request:?}");
                let option_id = request.options.first().map(|opt| opt.option_id.clone());
                if let Some(id) = option_id {
                    responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
                    ))
                } else {
                    responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    ))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            eprintln!("🤝 Initializing…");
            let init_response = connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            eprintln!("✓ Agent initialized: {:?}", init_response.agent_info);

            eprintln!("📝 Creating session…");
            let new_session_response = connection
                .send_request(NewSessionRequest::new(
                    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
                ))
                .block_task()
                .await?;
            let session_id = new_session_response.session_id;
            eprintln!("✓ session_id = {session_id:?}");

            eprintln!("💬 Sending prompt: {prompt:?}");
            let prompt_response = connection
                .send_request(PromptRequest::new(
                    session_id.clone(),
                    vec![ContentBlock::Text(TextContent::new(prompt.clone()))],
                ))
                .block_task()
                .await?;

            eprintln!("✅ stop_reason = {:?}", prompt_response.stop_reason);
            Ok(())
        })
        .await?;

    Ok(())
}
