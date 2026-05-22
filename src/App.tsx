import { startTransition, useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppLayout } from "@/features/layout/components/app-layout";
import { AppContextMenu } from "@/components/app-context-menu";
import { CommandPalette } from "@/components/command-palette";
import { SearchOverlay } from "@/components/search-overlay";
import { useHotkeys } from "@/hooks/use-hotkey";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  useProjectStore,
  type AppStateWire,
} from "@/features/project/stores/project-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import {
  listenAgents,
  resetDefaultAgent,
} from "@/features/chat/lib/agents-api";
import type { PendingPermission } from "@/types/acp";
import { FilePicker } from "@/features/file-picker/components/file-picker";
import { fileIndex } from "@/features/file-picker/lib/file-picker-api";
import { useRecentFilesStore } from "@/features/chat/stores/recent-files-store";
import { useClaudeSetupStore } from "@/features/claude-setup/stores/claude-setup-store";
import { Toaster } from "sonner";

export function App() {
  // Probe Claude Code (installed? authed?) on mount. Drives the banner
  // above the message composer and the hard-disabled state of the input
  // when the CLI isn't ready. Fast — two parallel subprocesses, totals
  // <100ms on a warm machine.
  useEffect(() => {
    void useClaudeSetupStore.getState().actions.refreshStatus();
  }, []);

  // Alpha-only: nuke any legacy WebView storage. Nothing in the current
  // codebase reads from localStorage / sessionStorage — the only entries
  // are stale dust from previous zustand-persist builds. Wiping on every
  // boot keeps the WebView storage budget zero. Remove this once we have
  // real users to worry about.
  useEffect(() => {
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      // ignore — some WebView sandboxes refuse storage access
    }
  }, []);

  // One-shot bootstrap of the Rust-owned `AppState` (currentProject +
  // recentProjects). Replaces the zustand `persist` middleware that used
  // to hydrate from localStorage. The Tauri invoke is async but fast
  // (~5–20 ms warm); until it resolves the WelcomeScreen and project-aware
  // panels render their empty/loading states.
  //
  // `startTransition` marks the welcome → project layout swap as non-urgent
  // so React can pause reconciliation between component subtrees and keep
  // the welcome UI interactive while the project layout mounts.
  //
  // Once hydration is done (success or failure) we dispatch `atlas:app-ready`
  // — the inline script in `index.html` listens for it and removes the
  // boot skeleton.
  useEffect(() => {
    let cancelled = false;
    const signalReady = () => {
      const flag = window as unknown as { __atlasAppReady?: boolean };
      if (flag.__atlasAppReady) return;
      flag.__atlasAppReady = true;
      window.dispatchEvent(new CustomEvent("atlas:app-ready"));
    };

    (async () => {
      try {
        const payload = await invoke<AppStateWire>("bootstrap_app_state");
        if (cancelled) return;
        startTransition(() => {
          useProjectStore.getState().actions.hydrate(payload);
        });
      } catch (e) {
        console.warn("bootstrap_app_state failed; starting empty:", e);
        if (!cancelled) {
          startTransition(() => {
            useProjectStore.getState().actions.hydrate({
              currentProject: null,
              recentProjects: [],
              version: 1,
            });
          });
        }
      } finally {
        if (!cancelled) signalReady();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

    // Agent spawn is deferred until the user first focuses the message input
    // (see `MessageInput`'s focus handler). `npx -y @zed-industries/claude-code-acp`
    // can take 10–30s on a cold npm cache; doing it at app boot adds visible
    // latency to first paint and races the project-rehydration cascade. The
    // user is unlikely to send a prompt within the first few hundred ms of
    // focusing the composer, so the spawn finishes in the background while
    // they type.

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
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

  // Maintain the chat-mention picker's "recent files" queue. Push whenever
  // an editor/media/unsupported tab appears whose data.filePath we haven't
  // seen yet in this session. Centralizing here means every call site that
  // opens a file (FilePicker, explorer, message-item link, analysis,
  // git diff, …) feeds the recents list without each having to remember to.
  const seenFileTabsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const projectPath = currentProject?.path ?? "";
    for (const t of tabs) {
      if (t.type !== "editor" && t.type !== "media" && t.type !== "unsupported")
        continue;
      const absPath = (t.data as Record<string, unknown> | undefined)?.filePath as
        | string
        | undefined;
      if (!absPath) continue;
      if (seenFileTabsRef.current.has(absPath)) continue;
      seenFileTabsRef.current.add(absPath);
      const rel =
        projectPath && absPath.startsWith(projectPath + "/")
          ? absPath.slice(projectPath.length + 1)
          : absPath.split("/").pop() ?? absPath;
      useRecentFilesStore.getState().actions.push({ absPath, rel });
    }
  }, [tabs, currentProject?.path]);

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
