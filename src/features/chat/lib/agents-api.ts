// Thin TS wrapper around the `agents_*` Tauri commands exposed by
// `src-tauri/src/commands/agents.rs`. Rust owns per-session state; the UI
// fetches a snapshot on attach and subscribes to delta events.
//
// No singleton agent here — callers explicitly pick a plugin and spawn.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AgentId,
  AgentInfo,
  AcpSessionId,
  PermissionDecision,
} from "@/types/acp";
import type {
  AgentDelta,
  PluginSpec,
  SessionKey,
  SessionSnapshot,
} from "@/types/agents";

/** Mirror of `atlas_acp::AuthMethodWire` — auth methods the ACP adapter
 *  advertised in its `initialize` response. The dialog renders one row
 *  per entry and calls `runAuthMethod(method.id)` on selection. */
export interface AuthMethodWire {
  id: string;
  name: string;
  description: string | null;
  terminalCommand: string | null;
  terminalArgs: string[] | null;
  terminalLabel: string | null;
}

export interface AuthRunDone {
  success: boolean;
  exitCode: number | null;
  message: string | null;
}

export interface AuthRunProgress {
  stream: "stdout" | "stderr";
  line: string;
}

export const agents = {
  listPlugins: () => invoke<PluginSpec[]>("agents_list_plugins"),
  listRunning: () => invoke<AgentInfo[]>("agents_list_running"),
  spawn: (pluginId: string) =>
    invoke<AgentInfo>("agents_spawn", { pluginId }),
  kill: (agentId: AgentId) => invoke<void>("agents_kill", { agentId }),

  newSession: (agentId: AgentId, cwd: string) =>
    invoke<SessionKey>("agents_new_session", { agentId, cwd }),
  loadSession: (agentId: AgentId, sessionId: AcpSessionId, cwd: string) =>
    invoke<SessionKey>("agents_load_session", { agentId, sessionId, cwd }),

  snapshot: (key: SessionKey) =>
    invoke<SessionSnapshot>("agents_snapshot", { key }),

  send: (key: SessionKey, text: string) =>
    invoke<void>("agents_send", { key, text }),
  cancel: (key: SessionKey) => invoke<void>("agents_cancel", { key }),

  setMode: (key: SessionKey, modeId: string) =>
    invoke<void>("agents_set_mode", { key, modeId }),
  setModel: (key: SessionKey, modelId: string) =>
    invoke<void>("agents_set_model", { key, modelId }),

  respondPermission: (
    agentId: AgentId,
    sessionId: AcpSessionId,
    requestId: string,
    decision: PermissionDecision
  ) =>
    invoke<void>("agents_respond_permission", {
      agentId,
      sessionId,
      requestId,
      decision,
    }),

  listAuthMethods: (agentId: AgentId) =>
    invoke<AuthMethodWire[]>("agents_list_auth_methods", { agentId }),
  runAuthMethod: (agentId: AgentId, methodId: string) =>
    invoke<void>("agents_run_auth_method", { agentId, methodId }),
};

export const listenAuthRunProgress = (
  handler: (p: AuthRunProgress) => void,
): Promise<UnlistenFn> =>
  listen<AuthRunProgress>("atlas:auth-run:progress", (e) => handler(e.payload));

export const listenAuthRunDone = (
  handler: (p: AuthRunDone) => void,
): Promise<UnlistenFn> =>
  listen<AuthRunDone>("atlas:auth-run:done", (e) => handler(e.payload));

/**
 * Subscribe to the single multiplexed delta stream. Every delta carries
 * `agent_id` + `session_id` so the consumer can route to the right tab.
 */
export const listenAgents = (
  handler: (env: AgentDelta) => void
): Promise<UnlistenFn> =>
  listen<AgentDelta>("atlas:agents", (e) => handler(e.payload));

// ── Lazy default-agent singleton ────────────────────────────────────────────
// One shared agent process for now — hardcoded `claude-code-ts`. App.tsx
// pre-spawns it at startup so the first prompt doesn't pay npx/node cold-start
// (10–30s). A multi-plugin picker UI replaces this when ready.

const DEFAULT_PLUGIN_ID = "claude-code-ts";
let defaultAgentPromise: Promise<AgentInfo> | null = null;
let cachedDefaultAgent: AgentInfo | null = null;

export function ensureDefaultAgent(): Promise<AgentInfo> {
  if (cachedDefaultAgent) return Promise.resolve(cachedDefaultAgent);
  if (!defaultAgentPromise) {
    defaultAgentPromise = agents
      .spawn(DEFAULT_PLUGIN_ID)
      .then((info) => {
        cachedDefaultAgent = info;
        return info;
      })
      .catch((e) => {
        // Reset so the next call can retry rather than caching a permanent failure.
        defaultAgentPromise = null;
        throw e;
      });
  }
  return defaultAgentPromise;
}

/**
 * Synchronous accessor for the default agent — `null` until the spawn
 * resolves. Used for optimistic UI bindings (e.g. binding a sidebar click to
 * a session id before awaiting the agent).
 */
export function getDefaultAgentSync(): AgentInfo | null {
  return cachedDefaultAgent;
}

export function resetDefaultAgent(): void {
  defaultAgentPromise = null;
  cachedDefaultAgent = null;
}
