//! MCP (Model Context Protocol) bridge for the native agent.
//!
//! Cersei 0.1.9 collects MCP server configs on the agent builder but never
//! connects them (`mcp_manager: None // TODO`). So we drive `cersei::mcp`
//! ourselves: connect the configured servers once, then expose each discovered
//! MCP tool to the model as a normal Cersei `Tool` that proxies to
//! `McpManager::call_tool`. This lets the Atlas agent use any MCP server (stdio
//! today; SSE is unimplemented in the SDK).
//!
//! Servers are configured in `<config_dir>/mcp-servers.json` — a JSON array of
//! `cersei::mcp::McpServerConfig` (`{ name, command, args, env, url, type }`).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use cersei::mcp::{McpManager, McpServerConfig};
use cersei::tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use cersei::types::ToolDefinition;
use serde_json::Value;

/// Read configured MCP servers. Missing / unparseable file → no servers.
pub fn load_configs(config_dir: &Path) -> Vec<McpServerConfig> {
    let path = config_dir.join("mcp-servers.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// A connected set of MCP servers + their discovered tools. Built once and
/// cached; `proxy_tools()` mints fresh per-turn `Tool` boxes from it.
pub struct McpHandle {
    manager: Arc<McpManager>,
    defs: Vec<ToolDefinition>,
    pub server_names: Vec<String>,
}

impl McpHandle {
    /// Connect all configured servers and discover their tools. Returns `None`
    /// when nothing is configured or no server exposed any tool.
    pub async fn connect(config_dir: &Path) -> Option<McpHandle> {
        let configs = load_configs(config_dir);
        if configs.is_empty() {
            return None;
        }
        let server_names = configs.iter().map(|c| c.name.clone()).collect();
        // `connect` logs + skips servers that fail, so this only errors on a
        // hard failure; otherwise we get whatever connected.
        let manager = McpManager::connect(&configs).await.ok()?;
        let defs = manager.tool_definitions().await;
        if defs.is_empty() {
            return None;
        }
        Some(McpHandle {
            manager: Arc::new(manager),
            defs,
            server_names,
        })
    }

    /// Fresh `Tool` boxes proxying each discovered MCP tool (cheap — they share
    /// the `Arc<McpManager>`).
    pub fn proxy_tools(&self) -> Vec<Box<dyn Tool>> {
        self.defs
            .iter()
            .map(|d| {
                Box::new(McpToolProxy {
                    manager: self.manager.clone(),
                    name: d.name.clone(),
                    description: d.description.clone(),
                    schema: d.input_schema.clone(),
                }) as Box<dyn Tool>
            })
            .collect()
    }
}

/// A single MCP tool surfaced to the model; `execute` routes to the server.
struct McpToolProxy {
    manager: Arc<McpManager>,
    name: String,
    description: String,
    schema: Value,
}

#[async_trait]
impl Tool for McpToolProxy {
    fn name(&self) -> &str {
        &self.name
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn input_schema(&self) -> Value {
        self.schema.clone()
    }
    fn permission_level(&self) -> PermissionLevel {
        // MCP tools are arbitrary third-party code — treat like shell exec so
        // they still prompt under `default`/`acceptEdits` and only run freely
        // under `bypass`.
        PermissionLevel::Execute
    }
    async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
        match self.manager.call_tool(&self.name, Some(input)).await {
            Ok(out) => ToolResult::success(out),
            Err(e) => ToolResult::error(format!("MCP tool '{}' failed: {e}", self.name)),
        }
    }
}
