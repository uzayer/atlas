import { useState, useEffect, useRef } from "react";
import { AppLayout } from "@/features/layout/components/app-layout";
import { AppContextMenu } from "@/components/app-context-menu";
import { CommandPalette } from "@/components/command-palette";
import { SearchOverlay } from "@/components/search-overlay";
import { useHotkeys } from "@/hooks/use-hotkey";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { Toaster } from "sonner";

export function App() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const {
    toggleLeftPanel,
    toggleRightPanel,
    toggleBottomPanel,
    toggleChatSidebar,
    toggleTabBar,
    addTab,
    setActiveTab,
    closeTab,
    activateTabByIndex,
  } = useLayoutStore.use.actions();
  const tabs = useLayoutStore.use.tabs();
  const activeTabId = useLayoutStore.use.activeTabId();

  const cycleTab = (delta: 1 | -1) => {
    const list = useLayoutStore.getState().tabs;
    if (list.length === 0) return;
    const current = useLayoutStore.getState().activeTabId;
    const idx = list.findIndex((t) => t.id === current);
    const next = (idx === -1 ? 0 : (idx + delta + list.length) % list.length);
    setActiveTab(list[next].id);
  };

  // Remember the last non-terminal tab so cmd+j can toggle back to it.
  const lastNonTerminalTabRef = useRef<string | null>(null);
  useEffect(() => {
    const active = tabs.find((t) => t.id === activeTabId);
    if (active && active.type !== "terminal") {
      lastNonTerminalTabRef.current = active.id;
    }
  }, [activeTabId, tabs]);

  const toggleTerminal = () => {
    const list = useLayoutStore.getState().tabs;
    const current = useLayoutStore.getState().activeTabId;
    const activeTab = list.find((t) => t.id === current);

    const focusTerminalSoon = () => {
      // Ask the active TerminalInstance to focus once the tab is mounted/visible.
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("atlas:focus-terminal"));
      });
    };

    if (activeTab?.type === "terminal") {
      const target = lastNonTerminalTabRef.current;
      const back = target && list.find((t) => t.id === target);
      if (back) {
        setActiveTab(back.id);
        return;
      }
      const anyOther = list.find((t) => t.type !== "terminal");
      if (anyOther) setActiveTab(anyOther.id);
      return;
    }

    const existing = list.find((t) => t.type === "terminal");
    if (existing) {
      setActiveTab(existing.id);
      focusTerminalSoon();
    } else {
      addTab({
        id: `terminal-${Date.now()}`,
        type: "terminal",
        title: "Terminal",
        closable: true,
        dirty: false,
        data: {},
      });
      focusTerminalSoon();
    }
  };
  const currentProject = useProjectStore.use.currentProject();

  // Auto-save editor state when tabs change
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!currentProject) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      useLayoutStore.getState().actions.saveEditorState(currentProject.path);
    }, 1000);
    return () => clearTimeout(saveTimerRef.current);
  }, [tabs.length, activeTabId, currentProject]);

  useHotkeys([
    {
      combo: { key: "n", meta: true, shift: true },
      action: () => {
        import("@tauri-apps/api/webviewWindow")
          .then(({ WebviewWindow }) => {
            new WebviewWindow(`atlas-${Date.now()}`, {
              url: "/?new=1",
              title: "Atlas",
              width: 1200,
              height: 800,
              center: true,
              decorations: true,
              titleBarStyle: "overlay",
              hiddenTitle: true,
            });
          })
          .catch((err) => console.error("New window failed:", err));
      },
    },
    {
      combo: { key: "k", meta: true },
      action: () => setCommandPaletteOpen(true),
    },
    {
      combo: { key: "f", meta: true, shift: true },
      action: () => setSearchOpen(true),
    },
    {
      combo: { key: "b", meta: true },
      action: toggleLeftPanel,
    },
    {
      combo: { key: "b", meta: true, shift: true },
      action: toggleRightPanel,
    },
    {
      combo: { key: "j", meta: true },
      action: toggleTerminal,
    },
    {
      combo: { key: "b", meta: true, alt: true },
      action: toggleBottomPanel,
    },
    {
      combo: { key: "j", meta: true, alt: true },
      action: toggleChatSidebar,
    },
    {
      combo: { key: "t", meta: true, alt: true },
      action: toggleTabBar,
    },
    ...Array.from({ length: 9 }, (_, i) => ({
      combo: { key: String(i + 1), meta: true },
      action: () => activateTabByIndex(i),
    })),
    {
      combo: { key: "w", meta: true },
      action: () => {
        const current = useLayoutStore.getState().activeTabId;
        if (current) closeTab(current);
      },
    },
    {
      combo: { key: "[", meta: true, shift: true },
      action: () => cycleTab(-1),
    },
    {
      combo: { key: "]", meta: true, shift: true },
      action: () => cycleTab(1),
    },
    {
      combo: { key: "t", meta: true },
      action: () =>
        addTab({
          id: `chat-${Date.now()}`,
          type: "chat",
          title: "New Chat",
          closable: true,
          dirty: false,
          data: {},
        }),
    },
    {
      combo: { key: "t", meta: true, shift: true },
      action: () =>
        addTab({
          id: `terminal-${Date.now()}`,
          type: "terminal",
          title: "Terminal",
          closable: true,
          dirty: false,
          data: {},
        }),
    },
    {
      combo: { key: ",", meta: true },
      action: () =>
        addTab({
          id: "settings",
          type: "settings",
          title: "Settings",
          closable: true,
          dirty: false,
          data: {},
        }),
    },
  ]);

  return (
    <>
      <AppContextMenu>
        <div className="h-screen w-screen" onContextMenu={(e) => e.preventDefault()}>
          <AppLayout />
        </div>
      </AppContextMenu>
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
      />
      <SearchOverlay open={searchOpen} onOpenChange={setSearchOpen} />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            fontSize: "var(--font-size-sm)",
          },
        }}
      />
    </>
  );
}
