import { useMemo, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import {
  useExplorerStore,
  flattenTree,
} from "../stores/explorer-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  ChevronRight,
  FolderPlus,
  RefreshCw,
  Code,
} from "lucide-react";

const ROW_HEIGHT = 24;
const INDENT_SIZE = 18;
const GUIDE_OFFSET = 11; // px from left of each indent level where the guide line draws

export function FileTree() {
  const tree = useExplorerStore.use.tree();
  const rootPath = useExplorerStore.use.rootPath();
  const loading = useExplorerStore.use.loading();
  const { toggleExpand, refresh } = useExplorerStore.use.actions();
  const { addTab } = useLayoutStore.use.actions();
  const scrollRef = useRef<HTMLDivElement>(null);

  const flat = useMemo(() => flattenTree(tree), [tree]);

  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15,
  });

  const handleOpenFile = useCallback((path: string, name: string) => {
    addTab({
      id: `editor-${path}`,
      type: "editor",
      title: name,
      closable: true,
      dirty: false,
      data: { filePath: path },
    });
  }, [addTab]);

  const handlePickFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true });
      if (selected) {
        useExplorerStore.getState().actions.openFolder(selected as string);
      }
    } catch {}
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-2 h-[28px] shrink-0">
        <span className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide truncate flex-1">
          {rootPath ? rootPath.split("/").pop() : "Files"}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => refresh()}
            className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors"
            title="Refresh"
          >
            <RefreshCw size={11} />
          </button>
          <button
            onClick={handlePickFolder}
            className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors"
            title="Open folder"
          >
            <FolderPlus size={11} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto hide-scrollbar">
        {loading ? (
          <div className="px-3 py-4 text-[12px] text-text-tertiary text-center">
            Loading...
          </div>
        ) : flat.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-text-tertiary text-center">
            Empty folder
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const node = flat[virtualRow.index];
              const isDir = node.entry.is_dir;
              const depth = node.depth;

              return (
                <button
                  key={node.entry.path}
                  onClick={() => {
                    if (isDir) {
                      toggleExpand(node.entry.path);
                    } else {
                      handleOpenFile(node.entry.path, node.entry.name);
                    }
                  }}
                  className={cn(
                    "absolute w-full flex items-center text-left hover:bg-bg-hover transition-colors group"
                  )}
                  style={{
                    height: ROW_HEIGHT,
                    top: 0,
                    transform: `translateY(${virtualRow.start}px)`,
                    paddingLeft: 4 + depth * INDENT_SIZE + (!isDir && depth === 0 ? 4 : 0),
                  }}
                >
                  {/* Indent guides */}
                  {depth > 0 && Array.from({ length: depth }, (_, i) => (
                    <span
                      key={i}
                      className="absolute top-0 bottom-0 w-px bg-[#333]"
                      style={{ left: 4 + i * INDENT_SIZE + GUIDE_OFFSET }}
                    />
                  ))}

                  {/* Arrow for directories, code icon for files */}
                  {isDir ? (
                    <ChevronRight
                      size={12}
                      className={cn(
                        "text-text-tertiary shrink-0 transition-transform mr-1",
                        node.expanded && "rotate-90"
                      )}
                    />
                  ) : (
                    <Code size={12} className="text-text-tertiary shrink-0 mr-1" />
                  )}

                  {/* Name */}
                  <span className={cn(
                    "truncate text-[12.5px] leading-none",
                    isDir
                      ? "text-text-primary font-medium"
                      : "text-text-secondary group-hover:text-text-primary"
                  )}>
                    {node.entry.name}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
