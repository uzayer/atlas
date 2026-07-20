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
import { switchClockStart, logSwitchPerf } from "@/features/layout/lib/switch-perf";

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
  /** Group whose header is currently in inline-rename mode (transient, not
   *  persisted). Lives in the store so it survives the virtualized row
   *  remounting and so a freshly-created group can open straight into rename. */
  editingGroupId: string | null;
  /** Workspace whose name is currently in inline-rename mode (transient, not
   *  persisted). Lives in the store — like `editingGroupId` — so it survives
   *  the virtualized row remounting. */
  editingWorkspaceId: string | null;
  /** Guards re-entrant switches while a flush/restore is in flight. */
  switching: boolean;
  /** OPTIMISTIC selection target. Set synchronously the instant a switch is
   *  requested — before the (awaited) flush + restore that actually swaps
   *  `activeWorkspaceId`. The sidebar highlights `optimisticActiveId ??
   *  activeWorkspaceId`, so the clicked row lights up immediately and the real
   *  state catches up. Cleared when the switch settles (or fails). */
  optimisticActiveId: string | null;
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
    /** Enter inline-rename for a workspace row. */
    beginRenameWorkspace: (id: string) => void;
    /** Leave workspace inline-rename (commit or cancel). */
    endRenameWorkspace: () => void;
    /** Move a workspace into a group (or ungroup with `null`). */
    setGroup: (id: string, groupId: string | null) => void;
    reorder: (orderedIds: string[]) => void;
    addGroup: (name: string) => string;
    renameGroup: (id: string, name: string) => void;
    /** Enter inline-rename for a group header. */
    beginRenameGroup: (id: string) => void;
    /** Leave inline-rename (commit or cancel). */
    endRenameGroup: () => void;
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
 * Run `fn` after the current frame has painted. A double-rAF hops past the
 * browser's style/layout/paint commit for this frame, so a workspace switch's
 * authoritative store swap renders visibly before the deferred tail (background
 * revalidate + event logging) competes for the main thread. Falls back to a
 * macrotask where rAF is unavailable (non-DOM test env).
 */
function deferAfterPaint(fn: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  } else {
    setTimeout(fn, 0);
  }
}

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
    optimisticActiveId: null,
    editingGroupId: null,
    editingWorkspaceId: null,
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

        // Optimistic + instant (synchronous, before the awaited flush below):
        //  • `optimisticActiveId` lights the clicked row in the switcher NOW.
        //  • Close the right panel so its heavy LAZY sub-panels (Source Control /
        //    Commit graph / Review / GitHub) unmount BEFORE `currentProject`
        //    flips — otherwise they'd synchronously re-fetch/re-render for the
        //    incoming workspace mid-switch and jank it. This is the one
        //    deliberate layout reset; everything else (editors/terminals/chat)
        //    stays resident. The panel stays closed (global state) until the
        //    user reopens it — a cheap on-demand lazy load.
        set({ switching: true, optimisticActiveId: id });
        useLayoutStore.getState().actions.closeRightPanel();
        // Instrumentation clock: request → first post-swap paint (see below).
        const perfStart = switchClockStart();
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
            // Flush the OUTGOING workspace's pending writes (notably the KB
            // editor's unsaved buffer) to disk BEFORE snapshotting and swapping.
            // Awaited — not fire-and-forget — so a note edited/saved in this
            // workspace can never be stranded or overwritten by the switch race.
            // The snapshot is then taken AFTER the flush so it reflects the
            // just-saved state. `flushAll` swallows per-store errors, so a bad
            // flush can't block the switch.
            //
            // Skip `app-state` here: on a switch that write is pure overhead —
            // it runs BEFORE the active-id swaps (so it would persist the
            // OUTGOING id) and the debounced `scheduleAppStateSave()` at the end
            // of this switch already persists the new active id. The remaining
            // flushes (`knowledge`, `editor-state`) are data-loss-sensitive and
            // MUST stay awaited: the KB flush reads the live editor buffer +
            // `activeEntryId` and must land on disk BEFORE `restoreSnapshot`
            // swaps `useKnowledgeStore` below, or it saves the incoming note's
            // body to the outgoing file. Both are dedup-gated, so on a switch
            // with no unsaved edits this resolves in a microtask.
            await flushAll(
              { workspaceId: activeWorkspaceId, path: outgoingPath },
              { skip: ["app-state"] },
            );
            captureSnapshot(activeWorkspaceId);
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
            // make its column-set visible. No remount. The stale-while-
            // revalidate refresh is deferred (below) so the swapped-in UI paints
            // first; `revalidateWorkspace` re-checks the active id before it
            // applies, so a rapid A→B→A can't clobber.
            restoreSnapshot(id);
            layout.loadWorkspaceView(id);
          } else {
            // COLD: mount fresh. `loadEditorState` (inside loadProjectStores)
            // appends saved tabs by id — idempotent against the seeded view.
            layout.loadWorkspaceView(id);
            await loadProjectStores(target.path);
            captureSnapshot(id);
            layout.commitWorkspaceView(id);
          }

          scheduleAppStateSave();
          // Defer the non-urgent tail (background git/explorer revalidate +
          // event log) to the next frame so the authoritative swap above paints
          // in this one instead of sharing its long task. `deferAfterPaint`
          // runs after the browser has committed the frame.
          deferAfterPaint(() => {
            logSwitchPerf(target.name, perfStart);
            if (wasHot) revalidateWorkspace(id, target.path);
            logEvent({
              source: "project",
              kind: "workspace-switch",
              summary: target.name,
              projectPath: target.path,
              projectName: target.name,
              payload: { workspaceId: id },
            });
          });
        } finally {
          // Real `activeWorkspaceId` is now authoritative (or the switch failed
          // and it's unchanged) — drop the optimistic overlay either way.
          set({ switching: false, optimisticActiveId: null });
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
      beginRenameWorkspace: (id) => set({ editingWorkspaceId: id }),
      endRenameWorkspace: () => set({ editingWorkspaceId: null }),
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
        // Open the new group straight into inline-rename so the user can name it.
        set((s) => ({ groups: [...s.groups, group], editingGroupId: group.id }));
        scheduleAppStateSave();
        return group.id;
      },
      renameGroup: (id, name) => {
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
        }));
        scheduleAppStateSave();
      },
      beginRenameGroup: (id) => set({ editingGroupId: id }),
      endRenameGroup: () => set({ editingGroupId: null }),
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
