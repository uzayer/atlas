// Persisted per-agent ACP model cache.
//
// Claude Code / Codex advertise their selectable models in the `session/new`
// response — but that only arrives after the agent process spawns + the ACP
// handshake + new_session complete (~3-4s on a fresh switch), and ACP
// `session/load` does NOT re-advertise models. The model list is effectively
// static per agent, so we persist the last set we saw and optimistically
// pre-fill the composer's model picker the instant the user switches or resumes
// a session, then reconcile when a live `session/new` confirms. Keyed by
// agentType so each agent has its own cache. Mirrors `acp-modes-cache`.

import type { SessionModeInfo } from "@/types/agents";

const key = (agentType: string) => `atlas:acp-models:${agentType}`;

export interface CachedAcpModels {
  currentModel: string | null;
  availableModels: SessionModeInfo[];
}

/** Last-seen models for an agent, or null if we've never bound one. */
export function loadCachedAcpModels(agentType: string): CachedAcpModels | null {
  try {
    const raw = localStorage.getItem(key(agentType));
    if (!raw) return null;
    const v = JSON.parse(raw) as CachedAcpModels;
    if (Array.isArray(v?.availableModels) && v.availableModels.length > 0) return v;
  } catch {
    // corrupt / unavailable storage — treat as a cache miss
  }
  return null;
}

/** Persist the models confirmed by a live session (no-op for empty sets). */
export function saveCachedAcpModels(agentType: string, models: CachedAcpModels): void {
  try {
    if (models.availableModels.length > 0) {
      localStorage.setItem(key(agentType), JSON.stringify(models));
    }
  } catch {
    // storage full / unavailable — caching is best-effort
  }
}
