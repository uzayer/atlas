export type AgentType = "claude-code" | "custom";
export type AgentStatus = "idle" | "running" | "waiting" | "done" | "error";
export type MessageRole = "user" | "assistant" | "system" | "tool";
export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export const CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

export const CLAUDE_PERMISSION_MODE_LABEL: Record<ClaudePermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept Edits",
  plan: "Plan Mode",
  bypassPermissions: "Bypass Permissions",
};

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  agentType: AgentType;
  model: string;
  status: AgentStatus;
  workingDirectory: string;
  tasks: AgentTask[];
  createdAt: string;
  updatedAt: string;
  claudeSessionId?: string;
  /** Per-send unique id used to disambiguate concurrent streams. */
  streamId?: string;
  useClaude: boolean;
  claudePermissionMode: ClaudePermissionMode;
  /** ACP agent process bound to this tab (lazily set on first prompt). */
  acpAgentId?: string;
  /** ACP session id bound to this tab (lazily set on first prompt). */
  acpSessionId?: string;
  /** Currently selected ACP session mode (default / acceptEdits / plan / …). */
  acpCurrentMode?: string;
  /** Currently selected ACP model id (default / sonnet / haiku / …). */
  acpCurrentModel?: string;
  /** Available slash commands as reported by the agent for this session. */
  availableCommands?: unknown[];
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls: ToolCallDisplay[];
  fileChanges: FileChange[];
  plan: PlanStep[] | null;
  timestamp: string;
}

export interface ToolCallDisplay {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: string | null;
  status: "pending" | "running" | "completed" | "failed";
  duration: number | null;
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted";
}

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
}

export interface AgentTask {
  id: string;
  title: string;
  status: "action_needed" | "running" | "done" | "error";
  linesAdded: number;
  linesRemoved: number;
}
