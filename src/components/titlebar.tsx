import { useState, useEffect, useRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { InboxPanel } from "@/features/chat/components/inbox-panel";
import { ChevronDown, Folder, FolderOpen, X, PanelLeft, PanelRight, Plus, Search, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
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
  const recentProjects = useProjectStore.use.recentProjects();
  const { openProject, removeRecent } = useProjectStore.use.actions();
  const { windowRef, isFullscreen } = useTauriWindow();
  const [search, setSearch] = useState("");

  const filtered = recentProjects.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.path.toLowerCase().includes(search.toLowerCase())
  );

  const handleDrag = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea, [role='menuitem']")) return;
    windowRef.current?.startDragging();
  };

  const handleOpenFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true });
      if (selected) openProject(selected as string);
    } catch {}
  };

  return (
    <div
      onMouseDown={handleDrag}
      className={`relative z-50 flex h-[30px] select-none items-center pr-3 bg-[#000] border-b border-border-default ${isFullscreen ? "pl-3" : "pl-[72px]"}`}
    >
      <div className="flex h-[30px] min-w-0 flex-1 items-center gap-1.5">
        {currentProject && (
          <>
            <LeftPanelToggle />
            <WorkspaceButton />
          </>
        )}
        <DropdownMenu.Root onOpenChange={(open) => { if (!open) setSearch(""); }}>
          <DropdownMenu.Trigger asChild>
            <button
              className="flex items-center gap-1 h-6 px-1.5 text-[12px] font-medium text-[#ccc] hover:text-[#fff] outline-none rounded hover:bg-[#ffffff08] max-w-[260px]"
              title={currentProject?.path}
            >
              <span className="truncate">{currentProject ? currentProject.name : "Atlas"}</span>
              <ChevronDown size={10} className="text-[#555] shrink-0" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={2}
              className="w-[260px] rounded-md border border-[#1a1a1a] bg-[#0f0f0f] shadow-lg py-1"
              style={{ zIndex: "var(--z-max)" as unknown as number }}
            >
              <DropdownMenu.Item
                onClick={handleOpenFolder}
                className="flex items-center gap-2 px-3 h-[30px] text-[12px] text-[#aaa] hover:bg-[#1a1a1a] hover:text-[#fff] cursor-default outline-none"
              >
                <FolderOpen size={13} />
                Open Folder...
              </DropdownMenu.Item>

              {recentProjects.length > 0 && (
                <>
                  <DropdownMenu.Separator className="h-px bg-[#1a1a1a] my-1" />
                  <div className="px-2 py-1">
                    <div className="flex items-center gap-1.5 h-[26px] rounded border border-[#1a1a1a] bg-[#0a0a0a] px-2">
                      <Search size={10} className="text-[#444] shrink-0" />
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search projects..."
                        className="flex-1 bg-transparent outline-none text-[11px] text-[#ccc] placeholder:text-[#444]"
                        onKeyDown={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    </div>
                  </div>
                  <div className="px-3 py-1">
                    <span className="text-[10px] text-[#555] uppercase tracking-[0.05em] font-medium">
                      Recent
                    </span>
                  </div>
                  {filtered.length === 0 ? (
                    <div className="px-3 py-2 text-[10px] text-[#444] text-center">
                      No matching projects
                    </div>
                  ) : (
                    filtered.map((p) => (
                      <DropdownMenu.Item
                        key={p.path}
                        onClick={() => openProject(p.path)}
                        className="group flex items-center gap-2 px-3 h-[28px] text-[11px] text-[#999] hover:bg-[#1a1a1a] hover:text-[#fff] cursor-default outline-none"
                      >
                        <Folder size={12} className="text-[#555] shrink-0" />
                        <span className="truncate flex-1 font-mono">{p.name}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            removeRecent(p.path);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-0.5 text-[#555] hover:text-[#999]"
                        >
                          <X size={10} />
                        </button>
                      </DropdownMenu.Item>
                    ))
                  )}
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

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
  const [open, setOpen] = useState(false);
  // Narrow selectors return primitives — Object.is equality means this
  // component only re-renders when the actual counts flip, not on every
  // streaming chunk.
  const runningCount = useChatStore(
    (s) => Object.values(s.sessions).filter((x) => x.status === "running").length
  );
  const errorCount = useChatStore(
    (s) => Object.values(s.sessions).filter((x) => x.status === "error").length
  );
  const badgeCount = runningCount + errorCount;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className="relative flex items-center justify-center w-6 h-6 rounded text-[#555] hover:text-[#aaa] hover:bg-[#ffffff08] transition-all duration-150 outline-none focus:outline-none"
          title="Inbox"
        >
          <Inbox size={14} />
          {badgeCount > 0 && (
            // Presence dot, not a count badge. Positioned just above the
            // icon's top-right corner so it reads as "there's something
            // here" without obscuring the inbox glyph. The ring matches the
            // titlebar background so the dot looks detached on hover too.
            <span
              className={cn(
                "absolute -top-[1px] -right-[1px] w-[7px] h-[7px] rounded-full ring-1 ring-[#000] pointer-events-none",
                errorCount > 0 ? "bg-[var(--status-error)]" : "bg-white"
              )}
              aria-label={`${badgeCount} active`}
            />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)] overflow-hidden"
          style={{ zIndex: "var(--z-max)" as unknown as number }}
        >
          <InboxPanel onClose={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function WorkspaceButton() {
  return (
    <button
      className="flex items-center justify-center w-6 h-6 rounded text-[#555] hover:text-[#aaa] hover:bg-[#ffffff08] transition-all duration-150"
      title="New workspace"
    >
      <Plus size={14} />
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
