import type { SessionModeInfo } from "./agents";

export type AgentType = "claude-code" | "codex" | "cersei" | "custom";

/** Switchable (Atlas-shipped) agents — excludes the catch-all "custom". */
export type SwitchableAgent = "claude-code" | "codex" | "cersei";

/** Map a high-level agent type to the spawnable plugin id (registry.rs /
 *  atlas-cersei). "cersei" is Atlas's native in-process agent. */
export const AGENT_PLUGIN_ID: Record<SwitchableAgent, string> = {
  "claude-code": "claude-code-ts",
  codex: "codex",
  cersei: "cersei",
};

/** The coding agents Atlas ships, in switch order (for option+/). */
export const SWITCHABLE_AGENTS: SwitchableAgent[] = ["claude-code", "codex", "cersei"];

export const AGENT_LABEL: Record<SwitchableAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cersei: "Atlas",
};

/** Derive the display agent type from a spawnable plugin id. */
export function agentTypeFromPluginId(pluginId: string): AgentType {
  if (pluginId === "codex") return "codex";
  if (pluginId === "cersei") return "cersei";
  if (pluginId.startsWith("claude")) return "claude-code";
  return "custom";
}
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
  /** Claude-only permission mode. Absent for non-Claude agents (e.g. Codex),
   *  which drive their modes via the generic ACP `acpCurrentMode`/snapshot. */
  claudePermissionMode?: ClaudePermissionMode;
  /** ACP agent process bound to this tab (set eagerly when the tab mounts). */
  acpAgentId?: string;
  /**
   * Session id bound to this tab. This is the SAME identifier the canonical
   * Claude Code agent writes its JSONL transcript under in
   * `~/.claude/projects/<encoded-cwd>/<id>.jsonl` — so it's both the ACP
   * session id and the on-disk session id. One name, one field.
   */
  acpSessionId?: string;
  /** Currently selected ACP session mode (default / acceptEdits / plan / …). */
  acpCurrentMode?: string;
  /** Modes the agent advertised for this session — drives the composer's mode
   *  picker for non-Claude agents (e.g. Codex). Seeded from the snapshot. */
  acpAvailableModes?: SessionModeInfo[];
  /** True while a non-Claude session is still booting (agent spawn + new_session)
   *  and its real modes haven't been confirmed yet. When true the composer shows
   *  the picker in a loading state, optimistically pre-filled from the persisted
   *  per-agent modes cache so switching feels instant. Cleared by `setAcpModes`. */
  acpModesPending?: boolean;
  /** Currently selected ACP model id (default / sonnet / haiku / …). For the
   *  native Cersei agent this is the bare model id; the provider lives in
   *  `cerseiProvider` and the two are pushed to the backend as `provider/model`. */
  acpCurrentModel?: string;
  /** BYOK provider id backing the native Cersei agent's model selection
   *  (e.g. "anthropic", "openai"). Unused by the ACP agents. */
  cerseiProvider?: string;
  /** Cumulative token/cost usage for the session (native agent surfaces it via
   *  `usage_updated` deltas; drives the composer's token/cost pill). */
  usage?: import("./agents").Usage;
  /** True while the native agent is compacting its context window. */
  compacting?: boolean;
  /** Reasoning-effort level for the native agent ("" / low / medium / high /
   *  max). Only meaningful for Anthropic models (maps to a thinking budget). */
  cerseiEffort?: string;
  /** RTK tool-output compression for the native agent (default on). */
  cerseiCompress?: boolean;
  /** Cumulative usage snapshot at the end of the previous turn — used to derive
   *  per-turn usage for the message footer. */
  lastUsageSnapshot?: { input: number; output: number; cost: number };
  /** Tokens RTK compression saved on the in-flight turn, captured from the
   *  `compression_saved` delta and folded into the usage footer at turn end. */
  pendingSavedTokens?: number;
  /** Available slash commands as reported by the agent for this session. */
  availableCommands?: unknown[];
  /**
   * Cached preview/count fields the sidebar reads. Maintained by the store
   * on user-message inserts and bulk replace so the sidebar's per-tab
   * summary doesn't have to scan `messages` on every streaming chunk.
   */
  firstUserContent?: string;
  userMessageCount?: number;
  /**
   * True while the tab is asynchronously hydrating a historical transcript
   * from disk (sidebar click → `readClaudeSession`). The chat panel renders
   * a "loading transcript" placeholder instead of the welcome state during
   * this window so navigation never flashes the empty page.
   */
  transcriptLoading?: boolean;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls: ToolCallDisplay[];
  fileChanges: FileChange[];
  plan: PlanStep[] | null;
  timestamp: string;
  /**
   * Discriminator for ACP-driven assistant messages. Splits one logical "turn"
   * into a sequence of single-purpose messages so they render in event order
   * (text, then tool, then text, then thinking, etc.).
   *
   * - "text": markdown content
   * - "tool": one or more tool calls only
   * - "thinking": collapsible thought chunks
   *
   * Undefined for legacy / user / system / chat-API messages — falls back to
   * the original combined render.
   */
  mode?: "text" | "tool" | "thinking";
  /** Accumulated thinking chunks; only set when mode === "thinking". */
  thinking?: string;
  /** Pre-split for user messages composed via the @-mention picker. The
   *  composer appends a "Atlas context" suffix to the prose; storing
   *  the split + block count here means MessageItem doesn't re-run a
   *  regex on `content` for every render. Computed once in `addMessage`
   *  when the message is inserted. Undefined for messages that don't
   *  carry an Atlas-context block (every assistant message, every user
   *  message sent without `@` mentions). */
  atlasProse?: string;
  atlasContext?: string;
  atlasContextBlockCount?: number;
  /** Per-turn token usage + cost for the native agent, attached when the turn
   *  finishes. Drives the end-of-message usage footer. `saved` = approx tokens
   *  RTK compression shaved off this turn (0 when compression was off). */
  usage?: { input: number; output: number; cost: number; saved?: number };
}

export interface ToolCallDisplay {
  id: string;
  toolName: string;
  /** ACP semantic class: "execute" | "read" | "edit" | "fetch" | … . The
   *  reliable way to recognise a bash/shell call — `toolName` is the ACP
   *  `title`, which for Bash is the command itself, not "bash". */
  kind: string | null;
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
