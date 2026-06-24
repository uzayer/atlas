// Wire shapes for the `atlas-agents` Rust surface. These mirror
// `crates/atlas-agents/src/{session,events,plugin,manager}.rs` — keep in sync
// when the Rust types change.

import type { AgentId, AcpSessionId } from "./acp";

export interface SessionKey {
  agent_id: AgentId;
  session_id: AcpSessionId;
}

export type TranscriptKind = { kind: "none" } | { kind: "claude_jsonl" };

export interface PluginSpec {
  plugin_id: string;
  display_name: string;
  command: string;
  transcript: TranscriptKind;
  supports_modes: boolean;
  supports_models: boolean;
}

export type SessionStatus = "idle" | "running" | "waiting" | "error";
export type MessageRole = "user" | "assistant" | "system";
export type MessageMode = "text" | "tool" | "thinking";
export type ToolCallStatus = "pending" | "running" | "completed" | "failed";

export interface ToolCall {
  id: string;
  tool_name: string;
  title: string | null;
  kind: string | null;
  status: ToolCallStatus;
  arguments: unknown;
  result: string | null;
  locations: unknown[];
}

export interface PlanEntry {
  content: string;
  priority?: string;
  status: string;
}

export interface SessionMessage {
  id: string;
  role: MessageRole;
  mode: MessageMode;
  content: string;
  thinking?: string;
  tool_calls: ToolCall[];
  plan?: PlanEntry[];
  timestamp: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  /** Estimated cumulative cost in USD (native agent; 0 when unknown). */
  cost?: number;
}

/** One ACP-advertised session mode (e.g. Codex's read-only / auto / full-access). */
export interface SessionModeInfo {
  id: string;
  name: string;
  description?: string | null;
}

export interface SessionSnapshot {
  agent_id: AgentId;
  session_id: AcpSessionId;
  cwd: string;
  plugin_id: string;
  status: SessionStatus;
  current_mode: string | null;
  current_model: string | null;
  available_modes: SessionModeInfo[];
  /** Models the agent advertised (ACP `session/new` `models`). Drives the
   *  Claude Code / Codex model picker; empty when unsupported. */
  available_models: SessionModeInfo[];
  available_commands: unknown[];
  plan: PlanEntry[];
  messages: SessionMessage[];
  usage: Usage;
  created_at: string;
  updated_at: string;
}

/**
 * Single multiplexed delta stream emitted on the `atlas:agents` window event.
 * `kind` discriminates; `agent_id` + `session_id` route to the right tab.
 */
export type AgentDelta =
  | { kind: "status"; agent_id: AgentId; session_id: AcpSessionId; status: SessionStatus }
  | { kind: "message_appended"; agent_id: AgentId; session_id: AcpSessionId; message: SessionMessage }
  | { kind: "text_chunk"; agent_id: AgentId; session_id: AcpSessionId; message_id: string; delta: string }
  | { kind: "thinking_chunk"; agent_id: AgentId; session_id: AcpSessionId; message_id: string; delta: string }
  | { kind: "tool_call_upserted"; agent_id: AgentId; session_id: AcpSessionId; message_id: string; tool_call: ToolCall }
  | { kind: "plan_updated"; agent_id: AgentId; session_id: AcpSessionId; plan: PlanEntry[] }
  | { kind: "mode_changed"; agent_id: AgentId; session_id: AcpSessionId; mode_id: string }
  | { kind: "model_changed"; agent_id: AgentId; session_id: AcpSessionId; model_id: string }
  | { kind: "available_commands"; agent_id: AgentId; session_id: AcpSessionId; commands: unknown[] }
  | { kind: "usage_updated"; agent_id: AgentId; session_id: AcpSessionId; usage: Usage }
  | { kind: "compaction"; agent_id: AgentId; session_id: AcpSessionId; active: boolean }
  | { kind: "compression_saved"; agent_id: AgentId; session_id: AcpSessionId; saved_tokens: number }
  | {
      kind: "permission_request";
      agent_id: AgentId;
      session_id: AcpSessionId;
      request_id: string;
      tool_call: unknown;
      options: unknown;
    }
  | { kind: "permission_resolved"; agent_id: AgentId; session_id: AcpSessionId; request_id: string }
  | { kind: "turn_finished"; agent_id: AgentId; session_id: AcpSessionId; stop_reason: string }
  | { kind: "turn_failed"; agent_id: AgentId; session_id: AcpSessionId; error: string }
  | { kind: "agent_disconnected"; agent_id: AgentId; session_id: AcpSessionId; reason: string };
