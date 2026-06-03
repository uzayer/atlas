import { useEffect, useRef, useState, useCallback } from "react";
import { useTerminalStore, collectPanes, type TreeNode, type PaneNode } from "../stores/terminal-store";
import { TerminalInstance } from "./terminal-instance";
import {
  Plus,
  Columns2,
  Rows2,
  X,
  Terminal as TerminalIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface TerminalPanelProps {
  tabId: string;
}

interface PaneRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function TerminalPanel({ tabId }: TerminalPanelProps) {
  const tab = useTerminalStore((s) => s.tabs[tabId]);
  const { initTab, setActiveTerminalInPane, setActivePane } = useTerminalStore.use.actions();
  const rootRef = useRef<HTMLDivElement>(null);
  const [paneRects, setPaneRects] = useState<Record<string, PaneRect>>({});

  useEffect(() => {
    if (!tab) initTab(tabId);
  }, [tabId, tab, initTab]);

  const measurePanes = useCallback(() => {
    if (!rootRef.current) return;
    const rootRect = rootRef.current.getBoundingClientRect();
    const containers = rootRef.current.querySelectorAll<HTMLElement>("[data-pane-container]");
    const rects: Record<string, PaneRect> = {};
    containers.forEach((el) => {
      const id = el.dataset.paneContainer!;
      const r = el.getBoundingClientRect();
      rects[id] = {
        top: r.top - rootRect.top,
        left: r.left - rootRect.left,
        width: r.width,
        height: r.height,
      };
    });
    setPaneRects(rects);
  }, []);

  // Measure after tree changes and on window resize
  useEffect(() => {
    if (!rootRef.current || !tab) return;
    // Double RAF to ensure layout is settled
    requestAnimationFrame(() => requestAnimationFrame(measurePanes));
  }, [tab?.root, measurePanes]);

  useEffect(() => {
    // Double RAF so we measure AFTER layout settles. A single RAF can fire
    // while the panel is still transitioning (e.g. tab switch flipping the
    // container from display:none to visible), capturing a stale top of 0 —
    // which makes the absolutely-positioned terminal overlay cover its own
    // 28px pane header and bleed up under the tab bar.
    const onResize = () =>
      requestAnimationFrame(() => requestAnimationFrame(measurePanes));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measurePanes]);

  // Also measure when the root container itself resizes (panel drag from main
  // layout, or the tab becoming visible). Double RAF for the same settle
  // reason as above.
  useEffect(() => {
    if (!rootRef.current) return;
    const ro = new ResizeObserver(() =>
      requestAnimationFrame(() => requestAnimationFrame(measurePanes))
    );
    ro.observe(rootRef.current);
    return () => ro.disconnect();
  }, [measurePanes]);

  if (!tab) return null;

  const allPanes = collectPanes(tab.root);

  return (
    <div ref={rootRef} className="h-full bg-[#000] relative">
      {/* Layout layer — toolbars + empty container divs */}
      <div className="h-full absolute inset-0">
        <LayoutRenderer node={tab.root} tabId={tabId} activePaneId={tab.activePaneId} />
      </div>

      {/* Terminal layer — flat list, absolutely positioned, NEVER unmounts on tree changes */}
      {allPanes.map((pane) =>
        pane.terminals.map((ptyId) => {
          const rect = paneRects[pane.id];
          const isActiveInPane = ptyId === pane.activeTerminalId;
          const isPaneActive = pane.id === tab.activePaneId;

          return (
            <div
              key={ptyId}
              style={{
                position: "absolute",
                top: rect?.top ?? 0,
                left: rect?.left ?? 0,
                width: rect?.width ?? 0,
                height: rect?.height ?? 0,
                visibility: rect && isActiveInPane ? "visible" : "hidden",
                pointerEvents: isActiveInPane ? "auto" : "none",
              }}
            >
              <TerminalInstance
                isActive={isActiveInPane && isPaneActive}
                isVisible={isActiveInPane && !!rect}
                onFocus={() => { setActiveTerminalInPane(tabId, pane.id, ptyId); setActivePane(tabId, pane.id); }}
              />
            </div>
          );
        })
      )}
    </div>
  );
}

function LayoutRenderer({ node, tabId, activePaneId }: { node: TreeNode; tabId: string; activePaneId: string | null }) {
  if (node.type === "pane") {
    return <PaneChrome pane={node} tabId={tabId} isActivePane={node.id === activePaneId} />;
  }

  return (
    <div className={cn("h-full flex", node.direction === "horizontal" ? "flex-row" : "flex-col")}>
      {node.children.map((child, i) => (
        <div
          key={child.id}
          className={cn("min-w-0 min-h-0", i > 0 && (node.direction === "horizontal" ? "border-l border-border-default" : "border-t border-border-default"))}
          style={{ flex: 1 }}
        >
          <LayoutRenderer node={child} tabId={tabId} activePaneId={activePaneId} />
        </div>
      ))}
    </div>
  );
}

function PaneChrome({ pane, tabId, isActivePane }: { pane: PaneNode; tabId: string; isActivePane: boolean }) {
  const { addTerminalToPane, splitPane, closeTerminalInPane, closePane, setActiveTerminalInPane, setActivePane } =
    useTerminalStore.use.actions();
  const tab = useTerminalStore((s) => s.tabs[tabId]);
  const hasSplits = tab?.root.type === "split";
  const activePty = pane.activeTerminalId;

  return (
    <div className={cn("h-full flex flex-col", isActivePane && "ring-1 ring-[#ffffff08] ring-inset")}>
      <div className="flex items-center h-[28px] shrink-0 border-b border-border-default bg-bg-primary px-1 gap-0.5">
        <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto hide-scrollbar">
          {pane.terminals.map((ptyId) => (
            <div
              key={ptyId}
              onClick={() => { setActiveTerminalInPane(tabId, pane.id, ptyId); setActivePane(tabId, pane.id); }}
              className={cn(
                "group flex items-center gap-1 px-1.5 h-5 rounded text-[10px] font-mono cursor-pointer shrink-0",
                ptyId === activePty ? "text-text-primary bg-bg-selected" : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover"
              )}
            >
              <TerminalIcon size={9} />
              <span>~</span>
              {pane.terminals.length > 1 && (
                <button onClick={(e) => { e.stopPropagation(); closeTerminalInPane(tabId, pane.id, ptyId); }} className="opacity-0 group-hover:opacity-100 hover:text-text-primary">
                  <X size={8} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={() => { addTerminalToPane(tabId, pane.id); setActivePane(tabId, pane.id); }} className="flex items-center justify-center w-5 h-5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer" title="New tab"><Plus size={11} /></button>
          <button onClick={() => splitPane(tabId, pane.id, "horizontal")} className="flex items-center justify-center w-5 h-5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer" title="Split right"><Columns2 size={11} /></button>
          <button onClick={() => splitPane(tabId, pane.id, "vertical")} className="flex items-center justify-center w-5 h-5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer" title="Split down"><Rows2 size={11} /></button>
          {hasSplits && (
            <button onClick={() => closePane(tabId, pane.id)} className="flex items-center justify-center w-5 h-5 rounded text-text-tertiary hover:text-white hover:bg-bg-hover transition-colors cursor-pointer" title="Close pane"><X size={11} /></button>
          )}
        </div>
      </div>
      {/* Empty container — terminals overlay this via absolute positioning */}
      <div className="flex-1 min-h-0" data-pane-container={pane.id} />
    </div>
  );
}
