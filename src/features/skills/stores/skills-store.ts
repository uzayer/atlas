// Skills store — UI state for the center-panel Skills tab. Holds the on-disk
// ("Installed") skills + the agent targets for the current scope. The backend
// is the single source of truth (canonical SKILL.md + symlinks on disk), so
// every mutation refetches rather than locally patching state. Scoped to one
// project + one scope at a time; switching either reloads. Mirrors
// `shared-memory-store.ts` (project-scoped load) and `byok-store.ts` (actions).

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { skills as skillsApi } from "../lib/skills-api";
import type { AgentTarget, Scope, SkillMeta } from "../lib/types";

interface SkillsState {
  scope: Scope;
  projectPath: string | null;
  skills: SkillMeta[];
  agents: AgentTarget[];
  loaded: boolean;
  /** Name of the skill currently mutating (enable/disable/delete), for busy UI. */
  pending: string | null;
  actions: {
    /** Set the active project (does not refetch on its own). */
    load: (projectPath: string | null) => Promise<void>;
    setScope: (scope: Scope) => Promise<void>;
    create: (
      name: string,
      description: string,
      body: string,
      agents: string[],
    ) => Promise<SkillMeta>;
    setEnabled: (
      name: string,
      agent: string,
      enabled: boolean,
    ) => Promise<void>;
    remove: (name: string) => Promise<void>;
    /** Adopt an external skill into canonical + fan out to all detected agents. */
    adopt: (name: string) => Promise<SkillMeta>;
    refresh: () => Promise<void>;
  };
}

/** Fetch list + agent targets for a scope/project, guarding stale responses. */
async function fetchFor(
  scope: Scope,
  projectPath: string | null,
): Promise<{ skills: SkillMeta[]; agents: AgentTarget[] }> {
  // Project scope needs a project; without one there's nothing to read.
  if (scope === "project" && !projectPath) {
    const agents = await skillsApi.listAgentTargets(scope, projectPath);
    return { skills: [], agents };
  }
  const [skills, agents] = await Promise.all([
    skillsApi.list(scope, projectPath),
    skillsApi.listAgentTargets(scope, projectPath),
  ]);
  return { skills, agents };
}

export const useSkillsStore = createSelectors(
  create<SkillsState>((set, get) => ({
    scope: "global",
    projectPath: null,
    skills: [],
    agents: [],
    loaded: false,
    pending: null,
    actions: {
      load: async (projectPath) => {
        const { scope } = get();
        set({ projectPath, loaded: false });
        try {
          const { skills, agents } = await fetchFor(scope, projectPath);
          // Drop a stale response if scope/project changed mid-flight.
          if (get().projectPath !== projectPath || get().scope !== scope)
            return;
          set({ skills, agents, loaded: true });
        } catch (err) {
          console.error("skills.load failed", err);
          if (get().projectPath !== projectPath || get().scope !== scope)
            return;
          set({ skills: [], agents: [], loaded: true });
        }
      },

      setScope: async (scope) => {
        const { projectPath } = get();
        set({ scope, loaded: false });
        try {
          const { skills, agents } = await fetchFor(scope, projectPath);
          if (get().scope !== scope) return;
          set({ skills, agents, loaded: true });
        } catch (err) {
          console.error("skills.setScope failed", err);
          if (get().scope !== scope) return;
          set({ skills: [], agents: [], loaded: true });
        }
      },

      create: async (name, description, body, agents) => {
        const { scope, projectPath } = get();
        const meta = await skillsApi.create(
          scope,
          name,
          description,
          body,
          agents,
          projectPath,
        );
        await get().actions.refresh();
        return meta;
      },

      setEnabled: async (name, agent, enabled) => {
        const { scope, projectPath } = get();
        set({ pending: name });
        try {
          await skillsApi.setEnabled(scope, name, agent, enabled, projectPath);
          await get().actions.refresh();
        } catch (err) {
          console.error("skills.setEnabled failed", err);
          throw err;
        } finally {
          set({ pending: null });
        }
      },

      remove: async (name) => {
        const { scope, projectPath } = get();
        set({ pending: name });
        try {
          await skillsApi.delete(scope, name, projectPath);
          await get().actions.refresh();
        } catch (err) {
          console.error("skills.remove failed", err);
          throw err;
        } finally {
          set({ pending: null });
        }
      },

      adopt: async (name) => {
        const { scope, projectPath } = get();
        set({ pending: name });
        try {
          const meta = await skillsApi.adopt(scope, name, projectPath);
          await get().actions.refresh();
          return meta;
        } catch (err) {
          console.error("skills.adopt failed", err);
          throw err;
        } finally {
          set({ pending: null });
        }
      },

      refresh: async () => {
        const { scope, projectPath } = get();
        try {
          const { skills, agents } = await fetchFor(scope, projectPath);
          if (get().scope !== scope || get().projectPath !== projectPath)
            return;
          set({ skills, agents });
        } catch (err) {
          console.error("skills.refresh failed", err);
        }
      },
    },
  })),
);
