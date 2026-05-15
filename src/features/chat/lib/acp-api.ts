import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AcpEventEnvelope,
  AcpSessionId,
  AgentId,
  AgentInfo,
  AgentSpec,
  NewSessionInfo,
  PermissionDecision,
  StopReason,
} from "@/types/acp";

export const acp = {
  knownSpecs: () => invoke<AgentSpec[]>("acp_known_specs"),
  listAgents: () => invoke<AgentInfo[]>("acp_list_agents"),
  spawnAgent: (specId: string) =>
    invoke<AgentInfo>("acp_spawn_agent", { specId }),
  killAgent: (agentId: AgentId) =>
    invoke<void>("acp_kill_agent", { agentId }),
  newSession: (agentId: AgentId, cwd: string) =>
    invoke<NewSessionInfo>("acp_new_session", { agentId, cwd }),
  sendPrompt: (agentId: AgentId, sessionId: AcpSessionId, text: string) =>
    invoke<StopReason>("acp_send_prompt", { agentId, sessionId, text }),
  cancelTurn: (agentId: AgentId, sessionId: AcpSessionId) =>
    invoke<void>("acp_cancel_turn", { agentId, sessionId }),
  respondPermission: (
    agentId: AgentId,
    requestId: string,
    decision: PermissionDecision
  ) =>
    invoke<void>("acp_respond_permission", { agentId, requestId, decision }),
};

export const listenAcp = (
  handler: (env: AcpEventEnvelope) => void
): Promise<UnlistenFn> =>
  listen<AcpEventEnvelope>("atlas:acp", (e) => handler(e.payload));

// ── Lazy singleton: one shared "default" agent for now ──────────────────────
// Phase-3 will replace this with a user-managed agent registry / picker.

const DEFAULT_SPEC_ID = "claude-code-ts";
let defaultAgentPromise: Promise<AgentInfo> | null = null;

export function ensureDefaultAgent(): Promise<AgentInfo> {
  if (!defaultAgentPromise) {
    defaultAgentPromise = acp.spawnAgent(DEFAULT_SPEC_ID).catch((e) => {
      // Reset so the next call can retry rather than caching a permanent failure.
      defaultAgentPromise = null;
      throw e;
    });
  }
  return defaultAgentPromise;
}

export function resetDefaultAgent(): void {
  defaultAgentPromise = null;
}
