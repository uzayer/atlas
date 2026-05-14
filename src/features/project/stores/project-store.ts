import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";
import { useExplorerStore } from "@/features/explorer/stores/explorer-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useAnalysisStore } from "@/features/analysis/stores/analysis-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { useSessionStore } from "./session-store";
import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";
import { logEvent } from "@/features/log/lib/log";

interface Project {
  name: string;
  path: string;
}

interface RecentProject {
  name: string;
  path: string;
  lastOpened: string;
}

interface ProjectState {
  currentProject: Project | null;
  recentProjects: RecentProject[];
  actions: {
    openProject: (path: string) => Promise<void>;
    closeProject: () => void;
    removeRecent: (path: string) => void;
  };
}

export const useProjectStore = createSelectors(
  create<ProjectState>()(
    persist(
      (set) => ({
        currentProject: null,
        recentProjects: [],
        actions: {
          openProject: async (path: string) => {
            const name = path.split("/").pop() ?? path;

            // Update project state
            set((s) => ({
              currentProject: { name, path },
              recentProjects: [
                { name, path, lastOpened: new Date().toISOString() },
                ...s.recentProjects.filter((r) => r.path !== path),
              ].slice(0, 5),
            }));

            logEvent({
              source: "project",
              kind: "open",
              summary: name,
              projectPath: path,
              projectName: name,
              payload: { path },
            });

            // Trigger all downstream stores in parallel
            await Promise.all([
              useExplorerStore.getState().actions.openFolder(path).catch((e) => console.error("Explorer failed:", e)),
              useAnalysisStore.getState().actions.analyzeProject(path).catch((e) => console.error("Analysis failed:", e)),
              Promise.all([
                useGitStore.getState().actions.loadStatus(path),
                useGitStore.getState().actions.loadLog(path),
              ]).catch((e) => console.error("Git failed:", e)),
              useSessionStore.getState().actions.loadSession(path).catch((e) => console.error("Session load failed:", e)),
              useKnowledgeStore.getState().actions.loadEntries(path).catch((e) => console.error("Knowledge load failed:", e)),
              useLayoutStore.getState().actions.loadEditorState(path).catch((e) => console.error("Editor state load failed:", e)),
            ]);
          },
          closeProject: () => set({ currentProject: null }),
          removeRecent: (path: string) =>
            set((s) => ({
              recentProjects: s.recentProjects.filter((r) => r.path !== path),
            })),
        },
      }),
      {
        name: "atlas-projects",
        partialize: (state) => ({
          currentProject: state.currentProject,
          recentProjects: state.recentProjects,
        }),
        onRehydrateStorage: () => (state) => {
          // New windows should start fresh with no project
          const isNewWindow = new URLSearchParams(window.location.search).has("new");
          if (isNewWindow && state) {
            state.currentProject = null;
            return;
          }
          // Re-open the project to restore downstream stores after rehydration
          if (state?.currentProject) {
            const path = state.currentProject.path;
            // Delay to ensure all stores are initialized
            setTimeout(() => {
              useExplorerStore.getState().actions.openFolder(path).catch(() => {});
              useAnalysisStore.getState().actions.analyzeProject(path).catch(() => {});
              useGitStore.getState().actions.loadStatus(path).catch(() => {});
              useGitStore.getState().actions.loadLog(path).catch(() => {});
              useSessionStore.getState().actions.loadSession(path).catch(() => {});
              useKnowledgeStore.getState().actions.loadEntries(path).catch(() => {});
              useLayoutStore.getState().actions.loadEditorState(path).catch(() => {});
            }, 0);
          }
        },
      }
    )
  )
);
