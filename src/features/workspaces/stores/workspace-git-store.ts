import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createSelectors } from "@/lib/create-selectors";

export interface GitSummary {
  isRepo: boolean;
  branch: string;
  headSubject: string;
  dirty: boolean;
  additions: number;
  deletions: number;
}

interface State {
  /** Cached per-workspace git summaries, keyed by project path. */
  summaries: Record<string, GitSummary>;
  actions: {
    /** Fetch a workspace's summary the FIRST time only. Cached at module scope,
     *  so opening/closing the workspace switcher renders instantly from cache
     *  and never recalculates git status/diff. */
    ensure: (path: string) => void;
    /** Force a silent background refetch (used when git state changes). */
    refresh: (path: string) => void;
  };
}

// Module-level so the cache + fetched/in-flight bookkeeping survive the sidebar
// unmounting and remounting (the whole point: don't recompute on every open).
const fetched = new Set<string>();
const inflight = new Set<string>();
let listenerReady = false;

export const useWorkspaceGitStore = createSelectors(
  create<State>((set, get) => {
    function ensureListener() {
      if (listenerReady) return;
      listenerReady = true;
      // One global listener for the app's lifetime: a git change to any project
      // silently refreshes that project's cached summary in the background. The
      // UI updates only if the sidebar happens to be mounted; otherwise the
      // fresh value is simply ready for the next open.
      void listen<{ project?: string }>("atlas:git-changed", (e) => {
        const p = e.payload?.project;
        if (p && fetched.has(p)) get().actions.refresh(p);
      });
    }

    async function load(path: string) {
      if (inflight.has(path)) return;
      inflight.add(path);
      try {
        const s = await invoke<GitSummary>("git_workspace_summary", { path });
        fetched.add(path);
        set((st) => ({ summaries: { ...st.summaries, [path]: s } }));
      } catch {
        // Leave it unfetched so a later `ensure` retries.
      } finally {
        inflight.delete(path);
      }
    }

    return {
      summaries: {},
      actions: {
        ensure: (path) => {
          ensureListener();
          if (!fetched.has(path)) void load(path);
        },
        refresh: (path) => void load(path),
      },
    };
  }),
);
