// ACP schema mirror — only the bits the Atlas frontend touches directly. Most
// of the schema is forwarded through as opaque `unknown`; phase-2 widgets will
// pull stronger types out of `SessionUpdate` variants as they need them.

export type AgentId = string; // UUID
export type AcpSessionId = string; // ACP session id (string under the hood)

export interface AgentSpec {
  spec_id: string;
  display_name: string;
  command: string;
}

export interface AgentInfo {
  agent_id: AgentId;
  spec_id: string;
  display_name: string;
}

export interface NewSessionInfo {
  session_id: AcpSessionId;
  modes?: unknown;
  models?: unknown;
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export type PermissionDecision =
  | { kind: "selected"; 0: string } // selected(option_id)
  | { kind: "cancelled" };

// `SessionUpdate` in the schema is a discriminated union by `sessionUpdate`.
// We pin the variants we care about and leave the rest opaque.
export type ContentBlockText = { type: "text"; text: string };
export type ContentBlock =
  | ContentBlockText
  | { type: "image"; [k: string]: unknown }
  | { type: "tool_use"; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

export interface PlanEntry {
  content: string;
  priority?: string;
  status: "pending" | "in_progress" | "completed";
}

export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title?: string;
      kind?: string;
      status?: string;
      input?: unknown;
      locations?: unknown[];
      content?: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status?: string;
      content?: unknown;
    }
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: unknown[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "current_model_update"; currentModelId: string };

export interface PermissionOptionRef {
  option_id: string;
  name: string;
  kind: string;
}

export interface ToolCallRef {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  content?: unknown;
  [k: string]: unknown;
}

export interface PendingPermission {
  agentId: AgentId;
  acpSessionId: AcpSessionId;
  requestId: string;
  toolCall: ToolCallRef;
  options: PermissionOptionRef[];
}

export type AcpEvent =
  | { kind: "agent_disconnected"; reason: string }
  | {
      kind: "session_update";
      session_id: AcpSessionId;
      update: SessionUpdate;
    }
  | {
      kind: "permission_request";
      request_id: string;
      session_id: AcpSessionId;
      tool_call: ToolCallRef;
      options: PermissionOptionRef[];
    }
  | {
      kind: "turn_stopped";
      session_id: AcpSessionId;
      turn_id: string;
      stop_reason: StopReason;
    }
  | {
      kind: "turn_failed";
      session_id: AcpSessionId;
      turn_id: string;
      error: string;
    };

export type AcpEventEnvelope = AcpEvent & { agent_id: AgentId };
