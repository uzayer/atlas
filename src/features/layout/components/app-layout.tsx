import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { useLayoutStore } from "../stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { WorkspaceSidebar } from "@/features/workspaces/components/workspace-sidebar";
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

  const showLeft = leftPanel.visible && !!currentProject;
  const showRight = rightPanel.visible && !!currentProject;
  const showStatus = bottomPanel.visible;

  return (
    <div className="flex h-screen">
      {/* Arc-like workspace rail, toggled by Cmd+. */}
      {sidebarOpen && <WorkspaceSidebar />}

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
                <Panel defaultSize={16} minSize={14} maxSize={28} order={1}>
                  <LeftPanel />
                </Panel>
                <PanelResizeHandle className="w-px bg-border-default hover:bg-accent data-[resize-handle-active]:bg-accent transition-colors cursor-col-resize" />
              </>
            )}

            <Panel defaultSize={showLeft && showRight ? 60 : 75} minSize={30} order={2}>
              <CenterPanel />
            </Panel>

            {showRight && (
              <>
                <PanelResizeHandle className="w-px bg-border-default hover:bg-accent data-[resize-handle-active]:bg-accent transition-colors cursor-col-resize" />
                <Panel defaultSize={18} minSize={12} maxSize={30} order={3}>
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
