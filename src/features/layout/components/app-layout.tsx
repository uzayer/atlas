import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { useLayoutStore } from "../stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
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

  const showLeft = leftPanel.visible && !!currentProject;
  const showRight = rightPanel.visible && !!currentProject;
  const showStatus = bottomPanel.visible;

  return (
    <div className="flex flex-col h-screen">
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
  );
}
