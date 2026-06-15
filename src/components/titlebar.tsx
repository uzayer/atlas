import { useState, useEffect, useRef } from "react";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { useNotificationsStore } from "@/features/notifications/stores/notifications-store";
import { PanelLeft, PanelRight, Bell, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import type { Window as TauriWindow } from "@tauri-apps/api/window";

function useTauriWindow() {
  const windowRef = useRef<TauriWindow | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        windowRef.current = win;
        setIsFullscreen(await win.isFullscreen());
        unlisten = await win.onResized(async () => {
          setIsFullscreen(await win.isFullscreen());
        });
      } catch {
        // not in Tauri context
      }
    })();

    return () => unlisten?.();
  }, []);

  return { windowRef, isFullscreen };
}

export function Titlebar() {
  const currentProject = useProjectStore.use.currentProject();
  const { windowRef, isFullscreen } = useTauriWindow();
  // When the workspace sidebar is open it owns the top-left corner (its own
  // traffic-light spacer), so the titlebar must NOT also reserve 72px for the
  // window controls — that double-reservation is the empty gap before the
  // workspace toggle. Fullscreen hides the controls entirely, same effect.
  const sidebarOpen = useWorkspaceStore.use.sidebarOpen();

  const isTitlebarSurface = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    return !el?.closest("button, a, input, select, textarea, [role='menuitem']");
  };

  // Drag the window manually (the `data-tauri-drag-region` CSS hook
  // doesn't work in this app — see memory). Calling `startDragging()`
  // straight from mousedown hands the event stream to the OS drag
  // session and swallows the double-click, so instead we only begin the
  // drag once the pointer actually moves past a small threshold. A
  // stationary click / double-click then flows through to onDoubleClick.
  const handleDrag = (e: React.MouseEvent) => {
    if (e.button !== 0 || !isTitlebarSurface(e.target)) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (ev: MouseEvent) => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) {
        cleanup();
        void windowRef.current?.startDragging();
      }
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", cleanup);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", cleanup);
  };

  // macOS double-click-to-zoom. Tauri's `toggleMaximize()` doesn't map to
  // AppKit's zoom, so we call a native `performZoom:` command instead.
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!isTitlebarSurface(e.target)) return;
    void invoke("window_zoom").catch(() => {});
  };

  return (
    <div
      onMouseDown={handleDrag}
      onDoubleClick={handleDoubleClick}
      className={`relative z-50 flex h-[30px] select-none items-center pr-3 bg-[#000] border-b border-border-default ${isFullscreen || sidebarOpen ? "pl-3" : "pl-[72px]"}`}
    >
      <div className="flex h-[30px] min-w-0 flex-1 items-center gap-1.5">
        <WorkspaceToggle />
        {currentProject && <LeftPanelToggle />}
        {/* Static project label — the recent-projects picker moved to the
         *  workspace sidebar's "+" menu. */}
        <span
          className="truncate text-[12px] font-medium text-[#ccc] max-w-[260px] px-1"
          title={currentProject?.path}
        >
          {currentProject ? currentProject.name : "Atlas"}
        </span>
      </div>

      {currentProject && (
        <div className="flex items-center gap-1.5">
          <NotificationButton />
          <RightPanelToggle />
        </div>
      )}
    </div>
  );
}

function WorkspaceToggle() {
  const sidebarOpen = useWorkspaceStore.use.sidebarOpen();
  const { toggleSidebar } = useWorkspaceStore.use.actions();
  const count = useWorkspaceStore.use.workspaces().length;

  return (
    <button
      onClick={toggleSidebar}
      className={cn(
        "relative flex items-center justify-center w-6 h-6 rounded hover:bg-[#ffffff08] transition-all duration-150",
        sidebarOpen ? "text-[#ccc]" : "text-[#555] hover:text-[#aaa]",
      )}
      title={sidebarOpen ? "Hide workspaces (⌘⇧.)" : "Show workspaces (⌘⇧.)"}
    >
      <Layers size={14} />
      {count > 1 && (
        <span className="absolute -bottom-0.5 -right-0.5 text-[7px] font-mono text-[var(--accent-primary)]">
          {count}
        </span>
      )}
    </button>
  );
}

function LeftPanelToggle() {
  const leftPanel = useLayoutStore.use.leftPanel();
  const { toggleLeftPanel } = useLayoutStore.use.actions();

  return (
    <button
      onClick={toggleLeftPanel}
      className="flex items-center justify-center w-6 h-6 rounded text-[#555] hover:text-[#aaa] hover:bg-[#ffffff08] transition-all duration-150"
      title={leftPanel.visible ? "Hide left panel" : "Show left panel"}
    >
      <PanelLeft size={14} className={leftPanel.visible ? "" : "opacity-40"} />
    </button>
  );
}

function NotificationButton() {
  const { toggle } = useNotificationsStore.use.actions();
  // Select PRIMITIVES (booleans) — returning a filtered array from the selector
  // would create a new reference every render and trigger an infinite loop.
  const hasUnread = useNotificationsStore((s) => s.items.some((i) => !i.read));
  const hasError = useNotificationsStore((s) =>
    s.items.some(
      (i) => !i.read && (i.kind === "agent-failed" || i.kind === "chat-error"),
    ),
  );

  return (
    <button
      onClick={toggle}
      className="relative flex items-center justify-center w-6 h-6 rounded text-[#555] hover:text-[#aaa] hover:bg-[#ffffff08] transition-all duration-150 outline-none focus:outline-none"
      title="Notifications"
    >
      <Bell size={14} />
      {hasUnread && (
        <span
          className={cn(
            "absolute -top-[1px] -right-[1px] w-[7px] h-[7px] rounded-full ring-1 ring-[#000] pointer-events-none",
            hasError ? "bg-[var(--status-error)]" : "bg-white",
          )}
          aria-label="Unread notifications"
        />
      )}
    </button>
  );
}

function RightPanelToggle() {
  const rightPanel = useLayoutStore.use.rightPanel();
  const { toggleRightPanel } = useLayoutStore.use.actions();

  return (
    <button
      onClick={toggleRightPanel}
      className="flex items-center justify-center w-6 h-6 rounded text-[#555] hover:text-[#aaa] hover:bg-[#ffffff08] transition-all duration-150"
      title={rightPanel.visible ? "Hide right panel" : "Show right panel"}
    >
      <PanelRight size={14} className={rightPanel.visible ? "" : "opacity-40"} />
    </button>
  );
}
