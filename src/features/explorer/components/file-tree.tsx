import { useMemo, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useExplorerStore,
  flattenTree,
} from "../stores/explorer-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { FolderPlus } from "lucide-react";
import { TreeRow } from "./tree-row";
import { ROW_HEIGHT } from "../lib/tree-constants";

export function FileTree() {
  const tree = useExplorerStore.use.tree();
  const rootPath = useExplorerStore.use.rootPath();
  const loading = useExplorerStore.use.loading();
  const { toggleExpand } = useExplorerStore.use.actions();
  const activeTabId = useLayoutStore.use.activeTabId();
  const tabs = useLayoutStore.use.tabs();
  const { addTab } = useLayoutStore.use.actions();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Active editor tab's file path — used to highlight the matching
  // row in the tree (pill style like the screenshot).
  const activeFilePath = useMemo(() => {
    const t = tabs.find((tab) => tab.id === activeTabId);
    if (!t || t.type !== "editor") return null;
    const fp = (t.data as { filePath?: string }).filePath;
    return typeof fp === "string" ? fp : null;
  }, [tabs, activeTabId]);

  const flat = useMemo(() => flattenTree(tree), [tree]);

  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15,
  });

  const handleOpenFile = useCallback(
    (path: string, name: string) => {
      addTab({
        id: `editor-${path}`,
        type: "editor",
        title: name,
        closable: true,
        dirty: false,
        data: { filePath: path },
      });
    },
    [addTab],
  );

  const handlePickFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true });
      if (selected) {
        useExplorerStore.getState().actions.openFolder(selected as string);
      }
    } catch {
      // user cancelled
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Panel header. No refresh button — the file-tree updates live
          off the project-wide filesystem watcher (atlas:explorer:changed). */}
      <div className="flex items-center justify-between px-3 h-[28px] shrink-0">
        <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider truncate flex-1">
          {rootPath ? rootPath.split("/").pop() : "Files"}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handlePickFolder}
            className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary transition-colors"
            title="Open folder"
          >
            <FolderPlus size={11} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto hide-scrollbar px-1.5 pb-2">
        {loading ? (
          <div className="px-3 py-4 text-[11px] text-text-tertiary text-center">
            Loading…
          </div>
        ) : flat.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-text-tertiary text-center">
            Empty folder
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const node = flat[virtualRow.index];
              const isDir = node.entry.is_dir;
              const isActive = !isDir && node.entry.path === activeFilePath;

              return (
                <TreeRow
                  key={node.entry.path}
                  depth={node.depth}
                  isDir={isDir}
                  isExpanded={node.expanded}
                  isActive={isActive}
                  name={node.entry.name}
                  title={node.entry.path}
                  onClick={() => {
                    if (isDir) {
                      toggleExpand(node.entry.path);
                    } else {
                      handleOpenFile(node.entry.path, node.entry.name);
                    }
                  }}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
