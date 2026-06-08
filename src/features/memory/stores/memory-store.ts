import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { createSelectors } from "@/lib/create-selectors";
import type { AgentMemory, MemorySubTab } from "../lib/memory-types";
import { memoryPolicy, type Policy } from "../lib/memory-policy-api";

/**
 * Module-level cache for the Memory module. The Memory tab isn't persistent —
 * switching center tabs (or Memory sub-tabs) unmounts/remounts the views — so
 * without this every visit re-ran the expensive Rust indexing (agent_memory_read,
 * memory_policies). This store survives remounts and is keyed by project: views
 * render cached data instantly (optimistic) and only fetch on first load, project
 * change, or an explicit refresh. (The graph keeps its own memory-graph-store,
 * which is already module-level and self-guards.)
 */

type PolicyPhase =
  | "idle"
  | "checking"
  | "not-downloaded"
  | "downloading"
  | "loading"
  | "ready"
  | "error";

interface MemoryStoreState {
  /** Active sub-tab, preserved across remounts. */
  subTab: MemorySubTab;
  /** Which project the caches below belong to (reset on change). */
  project: string | null;

  // Claude/Codex panel data.
  agentMemory: AgentMemory | null;
  agentMemoryLoading: boolean;

  // Policy table.
  policies: Policy[] | null;
  policyPhase: PolicyPhase;
  policyError: string | null;

  actions: {
    setSubTab: (t: MemorySubTab) => void;
    /** Drop caches when the project changes. */
    ensureProject: (projectPath: string | null) => void;
    loadAgentMemory: (projectPath: string, force?: boolean) => Promise<void>;
    loadPolicies: (projectPath: string, force?: boolean) => Promise<void>;
    setPolicyPhase: (phase: PolicyPhase, error?: string | null) => void;
    setPolicies: (rows: Policy[]) => void;
    /** Optimistic in-place value update after an edit saves. */
    updatePolicyValue: (id: string, value: string) => void;
  };
}

export const useMemoryStore = createSelectors(
  create<MemoryStoreState>()((set, get) => ({
    subTab: "claude",
    project: null,
    agentMemory: null,
    agentMemoryLoading: false,
    policies: null,
    policyPhase: "idle",
    policyError: null,
    actions: {
      setSubTab: (t) => set({ subTab: t }),

      ensureProject: (projectPath) => {
        if (get().project === projectPath) return;
        // New project → invalidate every cache.
        set({
          project: projectPath,
          agentMemory: null,
          agentMemoryLoading: false,
          policies: null,
          policyPhase: "idle",
          policyError: null,
        });
      },

      loadAgentMemory: async (projectPath, force = false) => {
        const s = get();
        if (!force && s.project === projectPath && s.agentMemory) return; // cache hit
        set({ agentMemoryLoading: true });
        try {
          const data = await invoke<AgentMemory>("agent_memory_read", { projectPath });
          set({ agentMemory: data, agentMemoryLoading: false, project: projectPath });
        } catch {
          set({ agentMemory: null, agentMemoryLoading: false });
        }
      },

      loadPolicies: async (projectPath, force = false) => {
        const s = get();
        if (!force && s.project === projectPath && s.policies && s.policyPhase === "ready") {
          return; // cache hit — no re-index
        }
        set({ policyPhase: "loading", policyError: null });
        try {
          const rows = await memoryPolicy.list(projectPath);
          set({ policies: rows, policyPhase: "ready", project: projectPath });
        } catch (e) {
          const msg = String(e);
          if (msg.includes("model-not-downloaded")) {
            set({ policyPhase: "not-downloaded" });
          } else {
            set({ policyError: msg, policyPhase: "error" });
          }
        }
      },

      setPolicyPhase: (phase, error = null) => set({ policyPhase: phase, policyError: error }),
      setPolicies: (rows) => set({ policies: rows, policyPhase: "ready" }),
      updatePolicyValue: (id, value) =>
        set((st) => ({
          policies: st.policies?.map((p) => (p.id === id ? { ...p, value } : p)) ?? null,
        })),
    },
  })),
);
