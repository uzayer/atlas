import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { createSelectors } from "@/lib/create-selectors";
import { logEvent } from "@/features/log/lib/log";
import { flushAll } from "../lib/flush-registry";
import {
  captureSnapshot,
  restoreSnapshot,
  evictSnapshot,
} from "../lib/workspace-snapshot";
import { revalidateWorkspace } from "../lib/workspace-revalidate";
import {
  useProjectStore,
  scheduleAppStateSave,
  loadProjectStores,
} from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useTerminalStore } from "@/features/terminal/stores/terminal-store";
import { isWorkspaceRunning } from "../lib/agent-activity";

/** Default hot-set cap — how many workspaces stay mounted/resident at once. */
const DEFAULT_MAX_MOUNTED = 6;

/**
 * A single open workspace = one project + its UI-state identity. `id` is the
 * stable key that replaces the per-window `webview.label()` everywhere Rust
 * keyed state (file index, git watcher, mention cache, recent files). Mirrors
 * `src-tauri/src/state/app_state.rs:Workspace`.
 */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  groupId: string | null;
  color?: string;
  /** Pinned to the top of the sidebar + prioritized to stay in the hot set. */
  pinned?: boolean;
  /** ISO-8601 of the last time this was the active workspace. */
  lastActiveAt?: string;
}

/** A user-defined collapsible folder grouping workspaces in the sidebar. */
export interface WorkspaceGroup {
  id: string;
  name: string;
  order: number;
  /** Pinned groups float to the top of the Recent tier. */
  pinned?: boolean;
}

interface WorkspaceState {
  /** The full project REGISTRY — every known project (opened, recent, or
   *  bookmarked-for-later). Unbounded; lightweight metadata only. */
  workspaces: Workspace[];
  groups: WorkspaceGroup[];
  activeWorkspaceId: string | null;
  /** The bounded HOT set: workspaces actually MOUNTED in CenterPanel + holding
   *  resident Rust state. CenterPanel renders only these. Capped at
   *  `maxMounted` (Chrome-style tab discarding). */
  mountedWorkspaceIds: string[];
  /** Hot-set cap. Beyond this, the LRU evictable (not active/pinned/running)
   *  workspace is discarded from RAM and cold-loads on revisit. */
  maxMounted: number;
  /** Cmd+. sidebar visibility. */
  sidebarOpen: boolean;
  /** Guards re-entrant switches while a flush/restore is in flight. */
  switching: boolean;
  actions: {
    /** Add a workspace for `path`, or focus the existing one if `path` is
     *  already open. Returns the workspace id. Switches to it (mounts it). */
    addWorkspace: (path: string) => Promise<string>;
    /** Add a registry entry for `path` WITHOUT opening/mounting it — a
     *  bookmark for "open later". Returns the id (or the existing one). */
    addProjectEntry: (path: string) => string;
    /** Flush the outgoing workspace, then restore the incoming one. */
    switchTo: (id: string) => Promise<void>;
    /** Flush + remove a workspace from the registry, tearing down its state. */
    closeWorkspace: (id: string) => Promise<void>;
    /** Ensure `id` is in the hot set, evicting the LRU evictable workspace if
     *  that pushes the set over `maxMounted`. */
    ensureMounted: (id: string) => void;
    pin: (id: string) => void;
    unpin: (id: string) => void;
    setColor: (id: string, color: string | null) => void;
    rename: (id: string, name: string) => void;
    /** Move a workspace into a group (or ungroup with `null`). */
    setGroup: (id: string, groupId: string | null) => void;
    reorder: (orderedIds: string[]) => void;
    addGroup: (name: string) => string;
    renameGroup: (id: string, name: string) => void;
    removeGroup: (id: string) => void;
    pinGroup: (id: string) => void;
    unpinGroup: (id: string) => void;
    toggleSidebar: () => void;
    setSidebarOpen: (open: boolean) => void;
    /** One-shot hydration from Rust `AppState` on boot. */
    hydrate: (payload: {
      workspaces: Workspace[];
      groups: WorkspaceGroup[];
      activeWorkspaceId: string | null;
    }) => void;
  };
}

const uuid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const nameOf = (path: string): string => path.split("/").pop() || path;

/**
 * Tear a workspace OUT of the hot set: free its heavy RAM (chat history,
 * terminal trees), drop its panel snapshot, unmount its CenterPanel subtree
 * (→ BlockTerminal closes its PTYs), and stop its resident Rust watchers.
 * Does NOT flush — a background workspace's editor-state was already persisted
 * at its last switch-away (and the layout mirror is the ACTIVE workspace's, so
 * flushing here would be wrong). Synchronous on the JS side; Rust teardown is
 * fire-and-forget. Does NOT touch `mountedWorkspaceIds`/`workspaces` — the
 * caller manages those.
 */
function teardownHot(id: string): void {
  const view = useLayoutStore.getState().viewsByWs[id];
  const tabIds = view ? view.tabs.map((t) => t.id) : [];
  if (tabIds.length) {
    useChatStore.getState().actions.removeSessions(tabIds);
    useTerminalStore.getState().actions.removeTabs(tabIds);
  }
  evictSnapshot(id);
  useLayoutStore.getState().actions.removeWorkspaceView(id);
  void invoke("fileindex_close_project", { workspaceId: id }).catch(() => {});
  void invoke("git_watch_stop", { workspaceId: id }).catch(() => {});
  void invoke("recent_files_close_project", { workspaceId: id }).catch(() => {});
  void invoke("mention_cache_clear", { workspaceId: id }).catch(() => {});
}

export const useWorkspaceStore = createSelectors(
  create<WorkspaceState>()((set, get) => ({
    workspaces: [],
    groups: [],
    activeWorkspaceId: null,
    mountedWorkspaceIds: [],
    maxMounted: DEFAULT_MAX_MOUNTED,
    sidebarOpen: false,
    switching: false,
    actions: {
      addWorkspace: async (path: string) => {
        const existing = get().workspaces.find((w) => w.path === path);
        if (existing) {
          await get().actions.switchTo(existing.id);
          return existing.id;
        }
        const ws: Workspace = {
          id: uuid(),
          name: nameOf(path),
          path,
          groupId: null,
        };
        set((s) => ({ workspaces: [...s.workspaces, ws] }));
        scheduleAppStateSave();
        await get().actions.switchTo(ws.id);
        return ws.id;
      },

      addProjectEntry: (path: string) => {
        const existing = get().workspaces.find((w) => w.path === path);
        if (existing) return existing.id;
        const ws: Workspace = {
          id: uuid(),
          name: nameOf(path),
          path,
          groupId: null,
        };
        set((s) => ({ workspaces: [...s.workspaces, ws] }));
        scheduleAppStateSave();
        return ws.id;
      },

      ensureMounted: (id: string) => {
        const st = get();
        if (st.mountedWorkspaceIds.includes(id)) return;
        let mounted = [...st.mountedWorkspaceIds, id];
        const byId = (wid: string) => st.workspaces.find((w) => w.id === wid);
        const evictable = (wid: string): boolean => {
          if (wid === id || wid === st.activeWorkspaceId) return false;
          const w = byId(wid);
          if (!w) return true;
          if (w.pinned) return false;
          if (isWorkspaceRunning(w.path)) return false;
          return true;
        };
        // Evict the least-recently-active evictable workspaces until under cap.
        // LRU-by-lastActiveAt naturally protects the just-left (2nd-newest)
        // workspace, so A→B→A stays warm.
        while (mounted.length > st.maxMounted) {
          const candidates = mounted
            .filter(evictable)
            .sort((a, b) =>
              (byId(a)?.lastActiveAt ?? "").localeCompare(byId(b)?.lastActiveAt ?? ""),
            );
          if (candidates.length === 0) break; // all pinned/running — exceed cap
          const lru = candidates[0];
          teardownHot(lru);
          mounted = mounted.filter((x) => x !== lru);
        }
        set({ mountedWorkspaceIds: mounted });
      },

      pin: (id: string) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, pinned: true } : w,
          ),
        }));
        // Pinning warms the workspace so it's instant.
        get().actions.ensureMounted(id);
        scheduleAppStateSave();
      },

      unpin: (id: string) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, pinned: false } : w,
          ),
        }));
        scheduleAppStateSave();
      },

      switchTo: async (id: string) => {
        const { activeWorkspaceId, switching, workspaces } = get();
        if (switching) return;
        const target = workspaces.find((w) => w.id === id);
        if (!target) return;
        if (id === activeWorkspaceId) {
          // Already active — make sure currentProject reflects it (covers
          // the very first switch after boot) but skip the flush dance.
          useProjectStore.getState().actions.setActiveProject({
            name: target.name,
            path: target.path,
          });
          return;
        }

        set({ switching: true });
        try {
          // 1) Commit the OUTGOING workspace's tab/split VIEW into the layout
          //    store (its tab subtree stays MOUNTED + hidden in CenterPanel),
          //    snapshot its light panel-data, and kick its disk flush
          //    fire-and-forget. We do NOT reset chat/editor/terminal — they
          //    stay resident across switches so nothing remounts.
          const layout = useLayoutStore.getState().actions;
          const outgoingPath =
            useProjectStore.getState().currentProject?.path ?? null;
          if (activeWorkspaceId) {
            layout.commitWorkspaceView(activeWorkspaceId);
            captureSnapshot(activeWorkspaceId);
            void flushAll({ workspaceId: activeWorkspaceId, path: outgoingPath });
          }

          // 2) Make the switch authoritative.
          const nowIso = new Date().toISOString();
          set((s) => ({
            activeWorkspaceId: id,
            workspaces: s.workspaces.map((w) =>
              w.id === id ? { ...w, lastActiveAt: nowIso } : w,
            ),
          }));

          // 3) Point the project store at the incoming workspace. This sets
          //    `currentProject`, which the App-level effects observe to drive
          //    the per-workspace Rust lifecycle (file index, git watch,
          //    recent files) keyed by `activeWorkspaceId`.
          useProjectStore.getState().actions.setActiveProject({
            name: target.name,
            path: target.path,
          });

          // 4) Residency: a workspace already in the HOT set is instant; a
          //    cold one joins the hot set (evicting the LRU evictable if that
          //    exceeds the cap) and loads from disk/Rust.
          const wasHot = get().mountedWorkspaceIds.includes(id);
          get().actions.ensureMounted(id);

          if (wasHot) {
            // WARM: its subtree is already mounted — swap light panel data +
            // make its column-set visible. No remount.
            restoreSnapshot(id);
            layout.loadWorkspaceView(id);
            revalidateWorkspace(id, target.path);
          } else {
            // COLD: mount fresh. `loadEditorState` (inside loadProjectStores)
            // appends saved tabs by id — idempotent against the seeded view.
            layout.loadWorkspaceView(id);
            await loadProjectStores(target.path);
            captureSnapshot(id);
            layout.commitWorkspaceView(id);
          }

          scheduleAppStateSave();
          logEvent({
            source: "project",
            kind: "workspace-switch",
            summary: target.name,
            projectPath: target.path,
            projectName: target.name,
            payload: { workspaceId: id },
          });
        } finally {
          set({ switching: false });
        }
      },

      closeWorkspace: async (id: string) => {
        const { workspaces, activeWorkspaceId } = get();
        const closing = workspaces.find((w) => w.id === id);
        if (!closing) return;

        const isActive = id === activeWorkspaceId;
        const closingPath = closing.path;
        if (isActive) {
          // Active workspace: the layout mirror is its tabs, so flush is correct.
          await flushAll({ workspaceId: id, path: closingPath });
        }

        // Free RAM + unmount its subtree (closes PTYs) + stop Rust watchers,
        // then drop it from the hot set AND the registry.
        teardownHot(id);
        const remaining = workspaces.filter((w) => w.id !== id);
        set((s) => ({
          workspaces: remaining,
          mountedWorkspaceIds: s.mountedWorkspaceIds.filter((x) => x !== id),
        }));

        if (isActive) {
          // Switch to the most-recently-active remaining workspace, or clear.
          const next = [...remaining].sort(
            (a, b) =>
              (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""),
          )[0];
          if (next) {
            set({ activeWorkspaceId: null });
            await get().actions.switchTo(next.id);
          } else {
            set({ activeWorkspaceId: null });
            useProjectStore.getState().actions.setActiveProject(null);
          }
        }
        scheduleAppStateSave();
      },

      setColor: (id, color) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, color: color ?? undefined } : w,
          ),
        }));
        scheduleAppStateSave();
      },
      rename: (id, name) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, name } : w,
          ),
        }));
        scheduleAppStateSave();
      },
      setGroup: (id, groupId) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, groupId } : w,
          ),
        }));
        scheduleAppStateSave();
      },
      reorder: (orderedIds) => {
        set((s) => {
          const byId = new Map(s.workspaces.map((w) => [w.id, w]));
          const reordered = orderedIds
            .map((wid) => byId.get(wid))
            .filter((w): w is Workspace => Boolean(w));
          // Append any workspaces missing from the order list (defensive).
          for (const w of s.workspaces) {
            if (!orderedIds.includes(w.id)) reordered.push(w);
          }
          return { workspaces: reordered };
        });
        scheduleAppStateSave();
      },
      addGroup: (name) => {
        const group: WorkspaceGroup = {
          id: uuid(),
          name,
          order: get().groups.length,
        };
        set((s) => ({ groups: [...s.groups, group] }));
        scheduleAppStateSave();
        return group.id;
      },
      renameGroup: (id, name) => {
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
        }));
        scheduleAppStateSave();
      },
      removeGroup: (id) => {
        set((s) => ({
          groups: s.groups.filter((g) => g.id !== id),
          // Ungroup any workspaces that belonged to it.
          workspaces: s.workspaces.map((w) =>
            w.groupId === id ? { ...w, groupId: null } : w,
          ),
        }));
        scheduleAppStateSave();
      },
      pinGroup: (id) => {
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, pinned: true } : g)),
        }));
        scheduleAppStateSave();
      },
      unpinGroup: (id) => {
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, pinned: false } : g)),
        }));
        scheduleAppStateSave();
      },
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),

      hydrate: (payload) => {
        set({
          workspaces: payload.workspaces ?? [],
          groups: payload.groups ?? [],
          activeWorkspaceId: payload.activeWorkspaceId ?? null,
        });
      },
    },
  })),
);
