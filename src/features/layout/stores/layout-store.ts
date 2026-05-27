import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import { invoke } from "@tauri-apps/api/core";
import type { TabType } from "@/lib/constants";

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  closable: boolean;
  dirty: boolean;
  data: Record<string, unknown>;
}

interface LayoutState {
  leftPanel: {
    visible: boolean;
    width: number;
    activeSection: "files" | "knowledge" | "git-graph";
    gitPanelHeight: number;
  };
  rightPanel: {
    visible: boolean;
    width: number;
    activeSection: "changes" | "analysis" | "explore" | "github";
  };
  bottomPanel: {
    visible: boolean;
    height: number;
  };
  chatSidebar: {
    visible: boolean;
    width: number;
  };
  bashPanel: {
    width: number;
  };
  tabs: Tab[];
  activeTabId: string | null;
  tabBarVisible: boolean;
  // Back/forward stack of tab ids — entries are pushed every time the user
  // navigates to a tab; back() / forward() rewind/advance an index.
  tabHistory: string[];
  tabHistoryIndex: number;
}

interface LayoutActions {
  actions: {
    toggleLeftPanel: () => void;
    toggleRightPanel: () => void;
    toggleBottomPanel: () => void;
    toggleChatSidebar: () => void;
    setChatSidebarWidth: (width: number) => void;
    setBashPanelWidth: (width: number) => void;
    setLeftSection: (section: LayoutState["leftPanel"]["activeSection"]) => void;
    setRightSection: (section: LayoutState["rightPanel"]["activeSection"]) => void;
    addTab: (tab: Tab) => void;
    closeTab: (id: string) => void;
    setActiveTab: (id: string) => void;
    setTabDirty: (id: string, dirty: boolean) => void;
    toggleTabBar: () => void;
    navigateTabBack: () => void;
    navigateTabForward: () => void;
    activateTabByIndex: (i: number) => void;
    saveEditorState: (projectPath: string) => void;
    loadEditorState: (projectPath: string) => Promise<void>;
    /** Wipe tabs/history back to the welcome-chat baseline. Called when
     *  the user switches projects so the previous project's editor / chat
     *  tabs don't leak into the new one. Panel layout (widths, sidebar
     *  visibility) is intentionally preserved — those are user prefs. */
    resetForProjectSwitch: () => void;
  };
}

const initialState: LayoutState = {
  leftPanel: {
    visible: true,
    width: 240,
    activeSection: "files",
    gitPanelHeight: 40,
  },
  rightPanel: {
    visible: true,
    width: 280,
    activeSection: "changes",
  },
  bottomPanel: {
    visible: true,
    height: 32,
  },
  chatSidebar: {
    visible: true,
    width: 220,
  },
  bashPanel: {
    width: 260,
  },
  tabs: [
    {
      id: "welcome-chat",
      type: "chat",
      title: "Chat",
      closable: false,
      dirty: false,
      data: {},
    },
  ],
  activeTabId: "welcome-chat",
  tabBarVisible: true,
  tabHistory: ["welcome-chat"],
  tabHistoryIndex: 0,
};

export const useLayoutStore = createSelectors(
  create<LayoutState & LayoutActions>()(
    immer((set) => ({
      ...initialState,
      actions: {
        toggleLeftPanel: () =>
          set((s) => {
            s.leftPanel.visible = !s.leftPanel.visible;
          }),
        toggleRightPanel: () =>
          set((s) => {
            s.rightPanel.visible = !s.rightPanel.visible;
          }),
        toggleBottomPanel: () =>
          set((s) => {
            s.bottomPanel.visible = !s.bottomPanel.visible;
          }),
        toggleChatSidebar: () =>
          set((s) => {
            s.chatSidebar.visible = !s.chatSidebar.visible;
          }),
        setChatSidebarWidth: (width) =>
          set((s) => {
            s.chatSidebar.width = Math.max(160, Math.min(width, 420));
          }),
        setBashPanelWidth: (width) =>
          set((s) => {
            s.bashPanel.width = Math.max(200, Math.min(width, 480));
          }),
        setLeftSection: (section) =>
          set((s) => {
            s.leftPanel.activeSection = section;
          }),
        setRightSection: (section) =>
          set((s) => {
            s.rightPanel.activeSection = section;
          }),
        addTab: (tab) =>
          set((s) => {
            // chat: each session is its own tab (multiple parallel agent
            // chats supported). editor / diff: one per filePath. Everything
            // else: at most one instance.
            const allowMultiple =
              tab.type === "editor" ||
              tab.type === "diff" ||
              tab.type === "chat";

            let targetId = tab.id;
            if (!allowMultiple) {
              const existingOfType = s.tabs.find((t) => t.type === tab.type);
              if (existingOfType) {
                targetId = existingOfType.id;
              } else {
                s.tabs.push(tab);
              }
            } else {
              const existsById = s.tabs.find((t) => t.id === tab.id);
              if (!existsById) {
                s.tabs.push(tab);
              }
            }
            if (s.activeTabId !== targetId) {
              s.activeTabId = targetId;
              s.tabHistory = s.tabHistory.slice(0, s.tabHistoryIndex + 1);
              s.tabHistory.push(targetId);
              s.tabHistoryIndex = s.tabHistory.length - 1;
            }
          }),
        closeTab: (id) =>
          set((s) => {
            const idx = s.tabs.findIndex((t) => t.id === id);
            if (idx === -1) return;
            const tab = s.tabs[idx];
            if (!tab.closable) return;
            s.tabs.splice(idx, 1);
            // Never leave an empty tab strip — the welcome chat is the
            // permanent first-tab fallback.
            if (s.tabs.length === 0) {
              s.tabs.push({
                id: "welcome-chat",
                type: "chat",
                title: "Chat",
                closable: false,
                dirty: false,
                data: {},
              });
            }
            if (s.activeTabId === id) {
              // Prefer the neighbour at the same slot; fall back to the
              // first tab (always present after the guard above).
              s.activeTabId = s.tabs[Math.min(idx, s.tabs.length - 1)]?.id
                ?? s.tabs[0].id;
            }
          }),
        setActiveTab: (id) =>
          set((s) => {
            // Defensive: if the caller hands us an id that no longer
            // exists in the tab list, route to the first tab instead
            // of letting `activeTabId` point at nothing.
            const target = s.tabs.find((t) => t.id === id)
              ? id
              : s.tabs[0]?.id ?? null;
            if (target === null || s.activeTabId === target) return;
            s.activeTabId = target;
            // Truncate forward history (typical browser-style) and push.
            s.tabHistory = s.tabHistory.slice(0, s.tabHistoryIndex + 1);
            s.tabHistory.push(target);
            s.tabHistoryIndex = s.tabHistory.length - 1;
          }),
        toggleTabBar: () =>
          set((s) => {
            s.tabBarVisible = !s.tabBarVisible;
          }),
        navigateTabBack: () =>
          set((s) => {
            for (let i = s.tabHistoryIndex - 1; i >= 0; i--) {
              const id = s.tabHistory[i];
              if (s.tabs.find((t) => t.id === id)) {
                s.tabHistoryIndex = i;
                s.activeTabId = id;
                return;
              }
            }
          }),
        navigateTabForward: () =>
          set((s) => {
            for (let i = s.tabHistoryIndex + 1; i < s.tabHistory.length; i++) {
              const id = s.tabHistory[i];
              if (s.tabs.find((t) => t.id === id)) {
                s.tabHistoryIndex = i;
                s.activeTabId = id;
                return;
              }
            }
          }),
        activateTabByIndex: (i) =>
          set((s) => {
            if (i < 0 || i >= s.tabs.length) return;
            const id = s.tabs[i].id;
            if (s.activeTabId === id) return;
            s.activeTabId = id;
            s.tabHistory = s.tabHistory.slice(0, s.tabHistoryIndex + 1);
            s.tabHistory.push(id);
            s.tabHistoryIndex = s.tabHistory.length - 1;
          }),
        setTabDirty: (id, dirty) =>
          set((s) => {
            const tab = s.tabs.find((t) => t.id === id);
            if (tab) tab.dirty = dirty;
          }),
        saveEditorState: (projectPath) => {
          const state = useLayoutStore.getState();
          const editorTabs = state.tabs.filter((t) => t.type === "editor");
          const data = {
            tabs: editorTabs.map((t) => ({
              id: t.id,
              type: t.type,
              title: t.title,
              data: t.data,
            })),
            activeTabId: state.activeTabId,
          };
          invoke("save_editor_state", {
            projectPath,
            stateJson: JSON.stringify(data),
          }).catch(() => {});
        },
        resetForProjectSwitch: () =>
          set((s) => {
            s.tabs = [
              {
                id: "welcome-chat",
                type: "chat",
                title: "Chat",
                closable: false,
                dirty: false,
                data: {},
              },
            ];
            s.activeTabId = "welcome-chat";
            s.tabHistory = ["welcome-chat"];
            s.tabHistoryIndex = 0;
          }),
        loadEditorState: async (projectPath) => {
          try {
            const raw = await invoke<string>("load_editor_state", { projectPath });
            const data = JSON.parse(raw) as {
              tabs?: Array<{ id: string; type: string; title: string; data: Record<string, unknown> }>;
              activeTabId?: string;
            };
            if (data.tabs && data.tabs.length > 0) {
              set((s) => {
                for (const saved of data.tabs!) {
                  if (!s.tabs.find((t) => t.id === saved.id)) {
                    s.tabs.push({
                      id: saved.id,
                      type: saved.type as TabType,
                      title: saved.title,
                      closable: true,
                      dirty: false,
                      data: saved.data,
                    });
                  }
                }
                if (data.activeTabId) {
                  s.activeTabId = data.activeTabId;
                }
              });
            }
          } catch {
            // no saved state
          }
        },
      },
    }))
  )
);
