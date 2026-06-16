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
import { LeftPanel } from "./left-panel";
import { RightPanel } from "./right-panel";
import { CenterPanel } from "./center-panel";

export function AppLayout() {
  const leftPanel = useLayoutStore.use.leftPanel();
  const rightPanel = useLayoutStore.use.rightPanel();
  const bottomPanel = useLayoutStore.use.bottomPanel();
  const currentProject = useProjectStore.use.currentProject();
  const sidebarOpen = useWorkspaceStore.use.sidebarOpen();

  // Warm the workspace-pane git data at startup so the first slide is smooth.
  useWorkspaceGitPrefetch();

  const showLeft = leftPanel.visible && !!currentProject;
  const showRight = rightPanel.visible && !!currentProject;
  const showStatus = bottomPanel.visible;

  return (
    <div className="flex h-screen">
      {/* Arc-like workspace rail, toggled by Cmd+. Always mounted so it can
          slide open AND closed: an overflow-hidden wrapper animates its width
          0↔244 with a smooth curve, clipping the fixed-width sidebar (whose
          internals never reflow — only the outer width animates). */}
      <div
        className="h-screen shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
        style={{ width: sidebarOpen ? 244 : 0 }}
        aria-hidden={!sidebarOpen}
      >
        <WorkspaceSidebar />
      </div>

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
    </div>
  );
}
