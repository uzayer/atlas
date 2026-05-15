// Legacy Claude Code helpers. The interactive subprocess path (run / stream /
// stop / check / version) was replaced by the ACP integration in
// `lib/acp-api.ts`. What remains here reads existing JSONL session history
// from `~/.claude/projects/` — both the legacy CLI and the canonical ACP
// agent (`@zed-industries/claude-code-acp`, which uses the same Claude Agent
// SDK) write to that directory, so the history-browser surface still works
// against ACP-produced sessions.

import { invoke } from "@tauri-apps/api/core";

export interface ClaudeSessionMeta {
  id: string;
  file_path: string;
  started_at: string | null;
  last_modified: string | null;
  message_count: number;
  preview: string;
}

export interface ToolCallDump {
  tool_name: string;
  input: Record<string, unknown>;
}

export interface ChatMessageDump {
  role: "user" | "assistant";
  content: string;
  timestamp: string | null;
  tool_calls: ToolCallDump[];
}

export function listClaudeSessions(cwd: string): Promise<ClaudeSessionMeta[]> {
  return invoke<ClaudeSessionMeta[]>("list_claude_sessions", { cwd });
}

export function readClaudeSession(filePath: string): Promise<ChatMessageDump[]> {
  return invoke<ChatMessageDump[]>("read_claude_session", { filePath });
}

export function deleteClaudeSession(filePath: string): Promise<void> {
  return invoke<void>("delete_claude_session", { filePath });
}

export interface ClaudeSessionStats {
  session_id: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  request_count: number;
  total_cost_usd: number;
}

export function getClaudeSessionStats(
  cwd: string,
  sessionId: string
): Promise<ClaudeSessionStats> {
  return invoke<ClaudeSessionStats>("claude_session_stats", { cwd, sessionId });
}
