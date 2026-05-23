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
  File,
  Folder,
  FolderOpen,
  FolderPlus,
} from "lucide-react";

// Tight rows + per-level indent. No visible guide lines — the indent
// alone is enough at this size and matches the inspiration screenshots.
const ROW_HEIGHT = 26;
const INDENT_PER_LEVEL = 14;

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
              const depth = node.depth;
              const isActive = !isDir && node.entry.path === activeFilePath;

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
                    "absolute left-0 right-0 flex items-center gap-1.5 text-left rounded-md mx-1",
                    "transition-colors cursor-pointer",
                    isActive
                      ? "bg-[var(--bg-elevated)] text-text-primary"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                  )}
                  style={{
                    height: ROW_HEIGHT - 2,
                    top: 1,
                    // Base 2px lands the chevron at 12px from the panel
                    // edge (container px-1.5 = 6, row mx-1 = 4, +2),
                    // aligning with the header's `px-3` left padding so
                    // the "M" of MARKOPOLO and the top chevron sit on
                    // the same vertical line.
                    transform: `translateY(${virtualRow.start}px)`,
                    paddingLeft: 2 + depth * INDENT_PER_LEVEL,
                    paddingRight: 6,
                  }}
                  title={node.entry.path}
                >
                  {/* Chevron: directories get a real twisty, files get
                      an invisible spacer so their icon column lines up
                      with the folder icon above it. */}
                  {isDir ? (
                    <ChevronRight
                      size={12}
                      className={cn(
                        "shrink-0 text-text-tertiary transition-transform",
                        node.expanded && "rotate-90",
                      )}
                      strokeWidth={2}
                    />
                  ) : (
                    <span className="w-3 shrink-0" aria-hidden />
                  )}

                  {/* Icon. Folders flip to FolderOpen when expanded. */}
                  {isDir ? (
                    node.expanded ? (
                      <FolderOpen
                        size={13}
                        className="shrink-0 text-text-tertiary"
                        strokeWidth={1.5}
                      />
                    ) : (
                      <Folder
                        size={13}
                        className="shrink-0 text-text-tertiary"
                        strokeWidth={1.5}
                      />
                    )
                  ) : (
                    <File
                      size={13}
                      className="shrink-0 text-text-tertiary"
                      strokeWidth={1.5}
                    />
                  )}

                  <span
                    className={cn(
                      "truncate font-mono text-[12px] leading-none",
                      isDir && "text-text-primary",
                    )}
                  >
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
