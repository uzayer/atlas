import { useState, useEffect, useRef } from "react";
import { AppLayout } from "@/features/layout/components/app-layout";
import { AppContextMenu } from "@/components/app-context-menu";
import { CommandPalette } from "@/components/command-palette";
import { SearchOverlay } from "@/components/search-overlay";
import { useHotkeys } from "@/hooks/use-hotkey";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import {
  ensureDefaultAgent,
  listenAgents,
  resetDefaultAgent,
} from "@/features/chat/lib/agents-api";
import type { PendingPermission } from "@/types/acp";
import { FilePicker } from "@/features/file-picker/components/file-picker";
import { fileIndex } from "@/features/file-picker/lib/file-picker-api";
import { Toaster } from "sonner";

// `requestIdleCallback` isn't in lib.dom yet in all TS configurations and
// isn't implemented on Safari/WebKit (which Tauri uses on macOS). Fall back
// to a generous setTimeout — the exact value doesn't matter as long as it's
// after first paint.
type IdleHandle = number;
function scheduleIdle(fn: () => void): IdleHandle {
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (typeof w.requestIdleCallback === "function") {
    return w.requestIdleCallback(fn, { timeout: 2000 });
  }
  return window.setTimeout(fn, 300) as unknown as IdleHandle;
}
function cancelIdle(handle: IdleHandle): void {
  const w = window as unknown as {
    cancelIdleCallback?: (h: number) => void;
  };
  if (typeof w.cancelIdleCallback === "function") {
    w.cancelIdleCallback(handle);
    return;
  }
  window.clearTimeout(handle);
}

export function App() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
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

  // Global agent event bus. One listener routes atlas-agents SessionDelta
  // events into the chat-store, queues permission requests for the
  // PermissionModal, and resets the lazy agent handle on disconnect.
  //
  // text_chunk / thinking_chunk arrive at the rate the agent streams (many
  // per second). Coalesce per requestAnimationFrame so the re-render rate
  // caps at ~60 Hz instead of paying an Immer + subscriber notification per
  // chunk.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const pendingText = new Map<string, string>(); // session_id → buffered narration
    const pendingThought = new Map<string, string>(); // session_id → buffered thinking
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      const actions = useChatStore.getState().actions;
      for (const [sid, text] of pendingText) {
        actions.appendAssistantText(sid, text);
      }
      pendingText.clear();
      for (const [sid, text] of pendingThought) {
        actions.appendAssistantThought(sid, text);
      }
      pendingThought.clear();
    };
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(flush);
    };

    listenAgents((env) => {
      if (cancelled) return;
      const actions = useChatStore.getState().actions;
      switch (env.kind) {
        case "text_chunk":
          pendingText.set(
            env.session_id,
            (pendingText.get(env.session_id) ?? "") + env.delta
          );
          schedule();
          return;
        case "thinking_chunk":
          pendingThought.set(
            env.session_id,
            (pendingThought.get(env.session_id) ?? "") + env.delta
          );
          schedule();
          return;
        case "permission_request":
          actions.pushPermission({
            agentId: env.agent_id,
            acpSessionId: env.session_id,
            requestId: env.request_id,
            toolCall: env.tool_call as PendingPermission["toolCall"],
            options: env.options as PendingPermission["options"],
          });
          return;
        case "permission_resolved":
          actions.popPermission(env.session_id, env.request_id);
          return;
        case "agent_disconnected":
          actions.clearPermissionsForAgent(env.agent_id);
          resetDefaultAgent();
          return;
        default:
          actions.applyAgentDelta(env);
          return;
      }
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });

    // Pre-spawn the default agent so the first user prompt doesn't pay
    // npx/node cold-start (10–30s). Deferred past first paint via
    // `requestIdleCallback` — `npx -y @zed-industries/claude-code-acp` on a
    // fresh install fetches the package from npm and starts Node, which can
    // hold the tokio runtime busy for several seconds. Doing it eagerly
    // here would race with React's mount work and contribute to the
    // beachball during cold-start.
    const idleHandle = scheduleIdle(() => {
      if (cancelled) return;
      ensureDefaultAgent().catch((e) => {
        console.warn("Agent pre-spawn failed (will retry on first send):", e);
      });
    });

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      cancelIdle(idleHandle);
      unlisten?.();
    };
  }, []);

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

  // FileIndex lifecycle: open the backend file index on project change,
  // close on project clear. The backend handles fs-watch and incremental
  // updates from that point — Cmd+P queries against the live index.
  useEffect(() => {
    if (!currentProject) {
      fileIndex.closeProject().catch(() => {});
      return;
    }
    fileIndex
      .openProject(currentProject.path)
      .catch((e) => console.warn("fileindex open failed:", e));
  }, [currentProject?.path]);

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
      combo: { key: "p", meta: true },
      action: () => setFilePickerOpen(true),
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
      <FilePicker open={filePickerOpen} onOpenChange={setFilePickerOpen} />
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
