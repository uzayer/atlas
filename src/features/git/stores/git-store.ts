import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logEvent } from "@/features/log/lib/log";

interface GitFileStatus {
  path: string;
  status: string;
  staged: boolean;
}

interface GitLogEntry {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  date: string;
}

interface GitBranch {
  name: string;
  is_current: boolean;
}

/**
 * Subscribe once (lazily) to the Rust-side `atlas:git-status-fresh` event.
 * When fresh git status arrives in the background it patches the store, so
 * any UI that snapshotted the stale cache from the initial `git_status`
 * invoke gets the corrected data the moment git finishes its real walk.
 *
 * Path-gated: if the user switched projects between the initial invoke
 * and the fresh emit, the emit is ignored to avoid stomping the new
 * project's status with the old project's data.
 */
let gitStatusFreshListenerInit = false;
function ensureGitStatusFreshListener(): void {
  if (gitStatusFreshListenerInit) return;
  gitStatusFreshListenerInit = true;
  void listen<{
    path: string;
    status: {
      is_repo: boolean;
      branch: string;
      files: GitFileStatus[];
      ahead: number;
      behind: number;
    };
  }>("atlas:git-status-fresh", (e) => {
    const current = useGitStore.getState().repoPath;
    if (!current || current !== e.payload.path) return;
    useGitStore.setState((s) => {
      s.isRepo = e.payload.status.is_repo;
      s.branch = e.payload.status.branch;
      s.files = e.payload.status.files;
      s.ahead = e.payload.status.ahead;
      s.behind = e.payload.status.behind;
    });
  });

  // Live updates from the git watcher (commands/git_watcher.rs) —
  // commit / checkout / branch / fetch all fire `atlas:git-changed`.
  // Refresh status + branch list so the Changes panel and branch
  // chip reflect on-disk truth without polling.
  void listen<{ project: string }>("atlas:git-changed", (e) => {
    const current = useGitStore.getState().repoPath;
    if (!current || current !== e.payload.project) return;
    const actions = useGitStore.getState().actions;
    void actions.loadStatus(current).catch(() => {});
    void actions.listBranches().catch(() => {});
  });
}

interface GitState {
  isRepo: boolean;
  branch: string;
  branches: GitBranch[];
  files: GitFileStatus[];
  log: GitLogEntry[];
  diff: string;
  ahead: number;
  behind: number;
  loading: boolean;
  repoPath: string | null;
}

interface GitActions {
  actions: {
    loadStatus: (path: string) => Promise<void>;
    loadLog: (path: string) => Promise<void>;
    loadDiff: () => Promise<void>;
    listBranches: () => Promise<void>;
    checkout: (branch: string) => Promise<void>;
    createBranch: (name: string) => Promise<void>;
    deleteBranch: (name: string) => Promise<void>;
    stageFiles: (paths: string[]) => Promise<void>;
    unstageFiles: (paths: string[]) => Promise<void>;
    commit: (message: string) => Promise<void>;
  };
}

export const useGitStore = createSelectors(
  create<GitState & GitActions>()(
    immer((set, get) => ({
      isRepo: false,
      branch: "",
      branches: [],
      files: [],
      log: [],
      diff: "",
      ahead: 0,
      behind: 0,
      loading: false,
      repoPath: null,
      actions: {
        loadStatus: async (path) => {
          ensureGitStatusFreshListener();
          set((s) => {
            s.loading = true;
            s.repoPath = path;
          });
          try {
            // Stale-while-revalidate: Rust returns the cached result
            // immediately and emits `atlas:git-status-fresh` when the
            // background refresh completes. The listener below patches
            // the fresh result into the store.
            const status = await invoke<{
              is_repo: boolean;
              branch: string;
              files: GitFileStatus[];
              ahead: number;
              behind: number;
            }>("git_status", { path });

            set((s) => {
              s.isRepo = status.is_repo;
              s.branch = status.branch;
              s.files = status.files;
              s.ahead = status.ahead;
              s.behind = status.behind;
              s.loading = false;
            });
          } catch {
            set((s) => {
              s.loading = false;
            });
          }
        },
        loadLog: async (path) => {
          try {
            const entries = await invoke<GitLogEntry[]>("git_log", {
              path,
              limit: 50,
            });
            set((s) => {
              s.log = entries;
            });
          } catch {
            // not a git repo or error
          }
        },
        loadDiff: async () => {
          const repoPath = get().repoPath;
          if (!repoPath) return;
          try {
            const diff = await invoke<string>("git_diff_all", { path: repoPath });
            set((s) => { s.diff = diff; });
          } catch {}
        },
        listBranches: async () => {
          const repoPath = get().repoPath;
          if (!repoPath) return;
          try {
            const branches = await invoke<GitBranch[]>("git_list_branches", { path: repoPath });
            set((s) => { s.branches = branches; });
          } catch {
            // not a git repo
          }
        },
        // Mutations no longer do explicit `loadStatus` / `listBranches`
        // afterwards — the Rust git watcher (commands/git_watcher.rs)
        // observes the resulting .git/HEAD, .git/refs/, .git/index
        // change and fires `atlas:git-changed`, which the listener
        // above translates into a refresh. One source of truth
        // (filesystem) instead of two (explicit refresh + watcher).
        checkout: async (branch) => {
          const repoPath = get().repoPath;
          if (!repoPath) return;
          await invoke("git_checkout", { path: repoPath, branch });
          logEvent({ source: "git", kind: "checkout", summary: branch, payload: { branch } });
        },
        createBranch: async (name) => {
          const repoPath = get().repoPath;
          if (!repoPath) return;
          await invoke("git_create_branch", { path: repoPath, name });
          logEvent({ source: "git", kind: "branch-create", summary: name, payload: { name } });
        },
        deleteBranch: async (name) => {
          const repoPath = get().repoPath;
          if (!repoPath) return;
          await invoke("git_delete_branch", { path: repoPath, name });
          logEvent({ source: "git", kind: "branch-delete", summary: name, payload: { name } });
        },
        stageFiles: async (paths) => {
          const repoPath = get().repoPath;
          if (!repoPath) return;
          await invoke("git_stage", { path: repoPath, files: paths });
          logEvent({
            source: "git",
            kind: "stage",
            summary: paths.length === 1 ? paths[0] : `${paths.length} files`,
            payload: { files: paths },
          });
        },
        unstageFiles: async (paths) => {
          const repoPath = get().repoPath;
          if (!repoPath) return;
          await invoke("git_unstage", { path: repoPath, files: paths });
          logEvent({
            source: "git",
            kind: "unstage",
            summary: paths.length === 1 ? paths[0] : `${paths.length} files`,
            payload: { files: paths },
          });
        },
        commit: async (message) => {
          const repoPath = get().repoPath;
          if (!repoPath) return;
          await invoke("git_commit", { path: repoPath, message });
          logEvent({
            source: "git",
            kind: "commit",
            summary: message.slice(0, 120),
            payload: { message },
          });
        },
      },
    }))
  )
);
