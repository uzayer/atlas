import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
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

/**
 * Wire shape returned by the Rust `bootstrap_app_state` command. Mirrors
 * `src-tauri/src/state/app_state.rs:AppState` field-for-field.
 */
export interface AppStateWire {
  currentProject: Project | null;
  recentProjects: RecentProject[];
  version: number;
}

interface ProjectState {
  currentProject: Project | null;
  recentProjects: RecentProject[];
  /** True until the Rust-side bootstrap returns. UI gates on this to keep
   *  the boot skeleton up rather than flashing an empty WelcomeScreen. */
  hydrated: boolean;
  actions: {
    openProject: (path: string) => Promise<void>;
    closeProject: () => void;
    removeRecent: (path: string) => void;
    /** One-shot hydration from Rust. Called once on app boot. */
    hydrate: (payload: AppStateWire) => void;
  };
}

// Debounced persistence: the Rust `save_app_state` command takes the full
// `AppState` payload, so we just resend the whole thing whenever `currentProject`
// or `recentProjects` changes. Coalesced to ~500ms to avoid burst writes
// when the user clicks around recents.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(state: ProjectState) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const payload: AppStateWire = {
      currentProject: state.currentProject,
      recentProjects: state.recentProjects,
      version: 1,
    };
    invoke("save_app_state", { payload }).catch((e) =>
      console.warn("save_app_state failed:", e)
    );
  }, 500);
}

export const useProjectStore = createSelectors(
  create<ProjectState>()((set, get) => ({
    currentProject: null,
    recentProjects: [],
    hydrated: false,
    actions: {
      openProject: async (path: string) => {
        const name = path.split("/").pop() ?? path;

        set((s) => ({
          currentProject: { name, path },
          recentProjects: [
            { name, path, lastOpened: new Date().toISOString() },
            ...s.recentProjects.filter((r) => r.path !== path),
          ].slice(0, 5),
        }));
        scheduleSave(get());

        logEvent({
          source: "project",
          kind: "open",
          summary: name,
          projectPath: path,
          projectName: name,
          payload: { path },
        });

        // Trigger all downstream stores in parallel.
        // `loadLog` is intentionally NOT fired here — the git-store's `log`
        // field is unused (git-graph-panel has its own useQuery) and the
        // underlying `git log --all` walk can take several seconds on a
        // repo with many refs.
        await Promise.all([
          useExplorerStore.getState().actions.openFolder(path).catch((e) => console.error("Explorer failed:", e)),
          useAnalysisStore.getState().actions.analyzeProject(path).catch((e) => console.error("Analysis failed:", e)),
          useGitStore.getState().actions.loadStatus(path).catch((e) => console.error("Git failed:", e)),
          useSessionStore.getState().actions.loadSession(path).catch((e) => console.error("Session load failed:", e)),
          useKnowledgeStore.getState().actions.loadEntries(path).catch((e) => console.error("Knowledge load failed:", e)),
          useLayoutStore.getState().actions.loadEditorState(path).catch((e) => console.error("Editor state load failed:", e)),
        ]);
      },
      closeProject: () => {
        set({ currentProject: null });
        scheduleSave(get());
      },
      removeRecent: (path: string) => {
        set((s) => ({
          recentProjects: s.recentProjects.filter((r) => r.path !== path),
        }));
        scheduleSave(get());
      },
      hydrate: (payload: AppStateWire) => {
        // New windows always start fresh — same special case the previous
        // `onRehydrateStorage` handled. `?new` query param signals this.
        const isNewWindow =
          typeof window !== "undefined" &&
          new URLSearchParams(window.location.search).has("new");

        const current = isNewWindow ? null : payload.currentProject;
        set({
          currentProject: current,
          recentProjects: payload.recentProjects ?? [],
          hydrated: true,
        });

        // Fire downstream loaders in parallel. They run on Tauri's tokio
        // runtime (not the JS main thread); each panel renders its own
        // loading state, so no need to gate this on idle. `loadLog` is
        // intentionally NOT here — the git-store's `log` field is unused
        // by any panel (git-graph fetches its own via useQuery) and
        // `git log --all` is the slowest of the bunch.
        if (current) {
          const path = current.path;
          useExplorerStore.getState().actions.openFolder(path).catch(() => {});
          useLayoutStore.getState().actions.loadEditorState(path).catch(() => {});
          useAnalysisStore.getState().actions.analyzeProject(path).catch(() => {});
          useGitStore.getState().actions.loadStatus(path).catch(() => {});
          useSessionStore.getState().actions.loadSession(path).catch(() => {});
          useKnowledgeStore.getState().actions.loadEntries(path).catch(() => {});
        }
      },
    },
  }))
);

