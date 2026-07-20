import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { useLayoutStore } from "../stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { WorkspaceSidebar } from "@/features/workspaces/components/workspace-sidebar";
import { useWorkspaceGitPrefetch } from "@/features/workspaces/lib/use-workspace-prefetch";
import { Titlebar } from "@/components/titlebar";
import { StatusBar } from "@/components/status-bar";
import { cn } from "@/lib/utils";
import { LeftPanel } from "./left-panel";
import { RightPanel } from "./right-panel";
import { CenterPanel } from "./center-panel";

export function AppLayout() {
  const leftPanel = useLayoutStore.use.leftPanel();
  const rightPanel = useLayoutStore.use.rightPanel();
  const bottomPanel = useLayoutStore.use.bottomPanel();
  const currentProject = useProjectStore.use.currentProject();
  const sidebarOpen = useWorkspaceStore.use.sidebarOpen();
  const { setSidebarOpen } = useWorkspaceStore.use.actions();

  // Warm the workspace-pane git data at startup so the first slide is smooth.
  useWorkspaceGitPrefetch();

  const showLeft = leftPanel.visible && !!currentProject;
  const showRight = rightPanel.visible && !!currentProject;
  const showStatus = bottomPanel.visible;

  return (
    // `relative` so the workspace rail + scrim can be absolutely-positioned
    // OVERLAYS. The main column below is the only in-flow child, so it always
    // fills the window and NEVER reflows when the rail toggles.
    <div className="relative flex h-screen">
      {/*
       * NOT keyed by workspace: keying forced a full unmount/remount of the
       * whole shell on every switch (rebuilding CodeMirror/xterm/virtualizer)
       * — the dominant switch cost. Instead, `switchTo` swaps Zustand state in
       * place from an in-RAM snapshot (see workspace-snapshot.ts), so the shell
       * stays mounted and switching is near-instant.
       */}
      <div className="flex flex-col flex-1 min-h-0">
        <Titlebar />

        <div className="flex-1 min-h-0">
          <PanelGroup direction="horizontal" autoSaveId="atlas-main-layout">
            {showLeft && (
              <>
                {/* Conditionally-rendered Panels MUST carry a stable `id` (not
                    just `order`) — without it react-resizable-panels can't match
                    panels across mount/unmount, so rapidly toggling left/right
                    corrupts its internal layout state ("Invalid layout total
                    size" + setState-on-unmounted), and an invariant throw with
                    no error boundary tears down the whole React root (looks like
                    a full app reload). Defaults sum to 100 for the 3-panel case;
                    RRP normalizes the 1-/2-panel cases. */}
                <Panel id="atlas-left" order={1} defaultSize={18} minSize={14} maxSize={28}>
                  <LeftPanel />
                </Panel>
                <PanelResizeHandle className="w-px bg-border-default hover:bg-accent data-[resize-handle-active]:bg-accent transition-colors cursor-col-resize" />
              </>
            )}

            <Panel id="atlas-center" order={2} defaultSize={64} minSize={30}>
              <CenterPanel />
            </Panel>

            {showRight && (
              <>
                <PanelResizeHandle className="w-px bg-border-default hover:bg-accent data-[resize-handle-active]:bg-accent transition-colors cursor-col-resize" />
                <Panel id="atlas-right" order={3} defaultSize={18} minSize={12} maxSize={30}>
                  <RightPanel />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>

        {showStatus && <StatusBar />}
      </div>

      {/* Scrim — subtle dim + click-to-close (the frosted rail carries the
          depth, same as the notification overlay). Only interactive while open;
          fades via `opacity` (compositor-only, no layout). */}
      <div
        className={cn(
          "absolute inset-0 z-[55] bg-black/20 transition-opacity duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          sidebarOpen ? "opacity-100" : "opacity-0 pointer-events-none",
        )}
        onClick={() => setSidebarOpen(false)}
        aria-hidden
      />

      {/* Workspace rail — an OVERLAY (Linear-style), toggled by Cmd+⇧. Always
          mounted; it sits ABOVE the content (never in flow), so toggling it does
          zero layout work on the shell — the content underneath stays perfectly
          still. It SLIDES (GPU `translateX`) AND FADES (`opacity`) together for a
          smooth reveal.

          The frosted glass (`bg .../60 backdrop-blur-2xl`) lives on THIS element
          — the same one that carries the transform/opacity — exactly like the
          notification overlay. Critical: `backdrop-filter` breaks if an ANCESTOR
          is an isolated compositing layer (opacity<1 / will-change / transform),
          so the blur must NOT sit on a child of the animated wrapper, and we do
          NOT set `will-change` here (it would isolate the layer and flatten the
          backdrop to nothing — the panel would look merely transparent). Closed =
          parked off the left edge, transparent. */}
      <div
        className="absolute left-0 top-0 h-screen w-[244px] z-[60] border-r border-[var(--border-default)] bg-[var(--bg-elevated)]/60 backdrop-blur-2xl shadow-[var(--shadow-overlay)] transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none [backface-visibility:hidden]"
        style={{
          transform: sidebarOpen ? "translateX(0)" : "translateX(-244px)",
          opacity: sidebarOpen ? 1 : 0,
        }}
        aria-hidden={!sidebarOpen}
      >
        <WorkspaceSidebar />
      </div>
    </div>
  );
}
