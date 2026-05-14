import { invoke } from "@tauri-apps/api/core";

export interface ClaudeResponse {
  output: string;
  exit_code: number;
}

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

export async function runClaudeCode(
  prompt: string,
  cwd?: string,
  model?: string
): Promise<ClaudeResponse> {
  return invoke<ClaudeResponse>("claude_run", {
    prompt,
    cwd: cwd ?? null,
    model: model ?? null,
  });
}

export async function checkClaudeCli(): Promise<boolean> {
  try {
    return await invoke<boolean>("claude_check");
  } catch {
    return false;
  }
}

export async function getClaudeVersion(): Promise<string> {
  try {
    return await invoke<string>("claude_version");
  } catch {
    return "not installed";
  }
}

export function stopClaude(sessionId: string): Promise<void> {
  return invoke<void>("claude_stop", { sessionId });
}

export function streamClaude(params: {
  sessionId: string;
  prompt: string;
  cwd: string | null;
  resumeSessionId?: string;
  permissionMode?: string;
}): Promise<void> {
  return invoke<void>("claude_stream", {
    sessionId: params.sessionId,
    prompt: params.prompt,
    cwd: params.cwd,
    resumeSessionId: params.resumeSessionId ?? null,
    permissionMode: params.permissionMode ?? null,
  });
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
