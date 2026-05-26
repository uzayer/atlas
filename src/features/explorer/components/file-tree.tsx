import { useMemo, useRef, useCallback, useState, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  useExplorerStore,
  flattenTree,
  type FileEntry,
} from "../stores/explorer-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { FolderPlus } from "lucide-react";
import { TreeRow } from "./tree-row";
import { ROW_HEIGHT } from "../lib/tree-constants";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/ui/context-menu";
import { KbdCombo } from "@/ui/kbd";
import { FileTreeConfirmDelete } from "./file-tree-confirm-delete";

/* ── Internal flat-row shape: either a real tree node OR a synthetic
 *    ghost-row carrying the pending new-entry state. The virtualizer
 *    treats both uniformly so the layout stays flicker-free. */

interface FlatRow {
  node: ReturnType<typeof flattenTree>[number] | null;
  ghost?: { parentDir: string; isDir: boolean; depth: number };
}

export function FileTree() {
  const tree = useExplorerStore.use.tree();
  const rootPath = useExplorerStore.use.rootPath();
  const loading = useExplorerStore.use.loading();
  const clipboard = useExplorerStore.use.clipboard();
  const pendingRenamePath = useExplorerStore.use.pendingRenamePath();
  const pendingNewEntry = useExplorerStore.use.pendingNewEntry();
  const {
    toggleExpand,
    reconcileDirectory,
    collapseAll,
    setClipboard,
    clearClipboard,
    beginRename,
    endRename,
    beginNewEntry,
    endNewEntry,
    ensureExpanded,
  } = useExplorerStore.use.actions();
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;
  const activeTabId = useLayoutStore.use.activeTabId();
  const tabs = useLayoutStore.use.tabs();
  const { addTab, closeTab } = useLayoutStore.use.actions();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; name: string; isDir: boolean } | null>(null);

  // Active editor tab's file path — used to highlight the matching
  // row in the tree (pill style like the screenshot).
  const activeFilePath = useMemo(() => {
    const t = tabs.find((tab) => tab.id === activeTabId);
    if (!t || t.type !== "editor") return null;
    const fp = (t.data as { filePath?: string }).filePath;
    return typeof fp === "string" ? fp : null;
  }, [tabs, activeTabId]);

  // Ensure the parent dir is expanded when a new-entry ghost is queued,
  // so the user sees the input inside the target folder. Skips for root
  // (which is always rendered).
  useEffect(() => {
    if (pendingNewEntry && rootPath && pendingNewEntry.parentDir !== rootPath) {
      void ensureExpanded(pendingNewEntry.parentDir);
    }
  }, [pendingNewEntry, rootPath, ensureExpanded]);

  // Flatten the tree, then splice in the ghost row for pendingNewEntry
  // at the correct position (immediately after the parent dir row, or
  // at the top of the root list when parentDir === root).
  const flat = useMemo<FlatRow[]>(() => {
    const base = flattenTree(tree).map((n) => ({ node: n }) as FlatRow);
    if (!pendingNewEntry) return base;
    if (rootPath && pendingNewEntry.parentDir === rootPath) {
      return [
        { node: null, ghost: { parentDir: rootPath, isDir: pendingNewEntry.isDir, depth: 0 } },
        ...base,
      ];
    }
    const idx = base.findIndex(
      (r) => r.node?.entry.path === pendingNewEntry.parentDir,
    );
    if (idx === -1) return base;
    const parentDepth = base[idx].node?.depth ?? 0;
    const next: FlatRow[] = [...base];
    next.splice(idx + 1, 0, {
      node: null,
      ghost: { parentDir: pendingNewEntry.parentDir, isDir: pendingNewEntry.isDir, depth: parentDepth + 1 },
    });
    return next;
  }, [tree, pendingNewEntry, rootPath]);

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

  /* ── Action handlers ───────────────────────────────────────── */

  const dirOfPath = (p: string): string => {
    const idx = p.lastIndexOf("/");
    return idx >= 0 ? p.slice(0, idx) : p;
  };
  const basenameOfPath = (p: string): string => {
    const idx = p.lastIndexOf("/");
    return idx >= 0 ? p.slice(idx + 1) : p;
  };

  const handleNewFileCommit = async (parentDir: string, name: string) => {
    const path = `${parentDir}/${name}`;
    try {
      await invoke("fs_create_file", { path });
      await reconcileDirectory(parentDir);
      handleOpenFile(path, name);
    } catch (e) {
      toast.error(String(e));
    } finally {
      endNewEntry();
    }
  };

  const handleNewFolderCommit = async (parentDir: string, name: string) => {
    const path = `${parentDir}/${name}`;
    try {
      await invoke("fs_create_dir", { path });
      await reconcileDirectory(parentDir);
    } catch (e) {
      toast.error(String(e));
    } finally {
      endNewEntry();
    }
  };

  const handleRenameCommit = async (oldPath: string, name: string) => {
    const newPath = `${dirOfPath(oldPath)}/${name}`;
    if (newPath === oldPath) {
      endRename();
      return;
    }
    try {
      await invoke("fs_rename", { from: oldPath, to: newPath });
      await reconcileDirectory(dirOfPath(oldPath));
      // If the renamed file is open, swap the tab to the new path.
      const openTab = tabs.find(
        (t) => t.type === "editor" && (t.data as { filePath?: string }).filePath === oldPath,
      );
      if (openTab) {
        closeTab(openTab.id);
        handleOpenFile(newPath, name);
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      endRename();
    }
  };

  const handleDelete = async (entry: FileEntry) => {
    try {
      await invoke("fs_delete", { path: entry.path });
      await reconcileDirectory(dirOfPath(entry.path));
      // Close any open editor tab pointing at this file.
      const openTab = tabs.find(
        (t) => t.type === "editor" && (t.data as { filePath?: string }).filePath === entry.path,
      );
      if (openTab) closeTab(openTab.id);
      if (clipboard?.path === entry.path) clearClipboard();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeleteTarget(null);
    }
  };

  const handlePaste = async (destDir: string) => {
    if (!clipboard) return;
    const baseName = basenameOfPath(clipboard.path);
    let destPath = `${destDir}/${baseName}`;
    // Collision: suffix " copy" then " copy N".
    try {
      let n = 0;
      // Probe up to 50 candidate names. Cheap; happens once per paste.
      while (await pathExists(destPath)) {
        n += 1;
        const dot = baseName.lastIndexOf(".");
        if (n === 1) {
          destPath =
            dot > 0
              ? `${destDir}/${baseName.slice(0, dot)} copy${baseName.slice(dot)}`
              : `${destDir}/${baseName} copy`;
        } else {
          destPath =
            dot > 0
              ? `${destDir}/${baseName.slice(0, dot)} copy ${n}${baseName.slice(dot)}`
              : `${destDir}/${baseName} copy ${n}`;
        }
        if (n > 50) break;
      }
      if (clipboard.isCut) {
        await invoke("fs_rename", { from: clipboard.path, to: destPath });
        await reconcileDirectory(dirOfPath(clipboard.path));
        clearClipboard();
      } else {
        await invoke("fs_copy", { from: clipboard.path, to: destPath });
      }
      await reconcileDirectory(destDir);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleDuplicate = async (path: string) => {
    try {
      await invoke<string>("fs_duplicate", { path });
      await reconcileDirectory(dirOfPath(path));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleRevealInFinder = async (path: string) => {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleOpenInDefaultApp = async (path: string) => {
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(path);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleOpenInTerminal = async (path: string) => {
    try {
      await invoke("fs_open_in_terminal", { path });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleCopyPath = (path: string) => {
    void navigator.clipboard.writeText(path).catch(() => {});
  };
  const handleCopyRelativePath = (path: string) => {
    if (projectPath && path.startsWith(projectPath)) {
      const rel = path.slice(projectPath.length + 1);
      void navigator.clipboard.writeText(rel).catch(() => {});
    } else {
      void navigator.clipboard.writeText(path).catch(() => {});
    }
  };

  const handleAddToGitignore = async (path: string) => {
    if (!projectPath) return;
    const rel = path.startsWith(projectPath)
      ? path.slice(projectPath.length + 1)
      : path;
    try {
      await invoke("fs_add_to_gitignore", { projectPath, pattern: rel });
      toast.success(`Added to .gitignore: ${rel}`);
    } catch (e) {
      toast.error(String(e));
    }
  };

  /* ── Render ────────────────────────────────────────────────── */

  const rowMenuItems = (entry: FileEntry) => {
    const isDir = entry.is_dir;
    return (
      <>
        {isDir ? (
          <>
            <ContextMenuItem onSelect={() => beginNewEntry(entry.path, false)}>
              New File
              <ContextMenuShortcut><KbdCombo combo="⌘N" /></ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => beginNewEntry(entry.path, true)}>
              New Folder
              <ContextMenuShortcut><KbdCombo combo="⌥⌘N" /></ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : (
          <>
            <ContextMenuItem onSelect={() => handleOpenFile(entry.path, entry.name)}>
              Open
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={() => handleRevealInFinder(entry.path)}>
          Reveal in Finder
          <ContextMenuShortcut><KbdCombo combo="⌥⌘R" /></ContextMenuShortcut>
        </ContextMenuItem>
        {!isDir && (
          <ContextMenuItem onSelect={() => handleOpenInDefaultApp(entry.path)}>
            Open in Default App
          </ContextMenuItem>
        )}
        {isDir && (
          <ContextMenuItem onSelect={() => handleOpenInTerminal(entry.path)}>
            Open in Terminal
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => setClipboard(entry.path, true)}>
          Cut
          <ContextMenuShortcut><KbdCombo combo="⌘X" /></ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => setClipboard(entry.path, false)}>
          Copy
          <ContextMenuShortcut><KbdCombo combo="⌘C" /></ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void handleDuplicate(entry.path)}>
          Duplicate
          <ContextMenuShortcut><KbdCombo combo="⌘D" /></ContextMenuShortcut>
        </ContextMenuItem>
        {isDir && clipboard && (
          <ContextMenuItem onSelect={() => void handlePaste(entry.path)}>
            Paste
            <ContextMenuShortcut><KbdCombo combo="⌘V" /></ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleCopyPath(entry.path)}>
          Copy Path
          <ContextMenuShortcut><KbdCombo combo="⌥⌘C" /></ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleCopyRelativePath(entry.path)}>
          Copy Relative Path
          <ContextMenuShortcut><KbdCombo combo="⇧⌥⌘C" /></ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void handleAddToGitignore(entry.path)}>
          Add to .gitignore
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => beginRename(entry.path)}>
          Rename
          <ContextMenuShortcut><KbdCombo combo="F2" /></ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => setDeleteTarget({ path: entry.path, name: entry.name, isDir: entry.is_dir })}
        >
          Delete
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </>
    );
  };

  const emptyAreaMenu = (
    <ContextMenuContent>
      <ContextMenuItem
        disabled={!rootPath}
        onSelect={() => rootPath && beginNewEntry(rootPath, false)}
      >
        New File
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!rootPath}
        onSelect={() => rootPath && beginNewEntry(rootPath, true)}
      >
        New Folder
      </ContextMenuItem>
      {rootPath && clipboard && (
        <ContextMenuItem onSelect={() => void handlePaste(rootPath)}>
          Paste
          <ContextMenuShortcut><KbdCombo combo="⌘V" /></ContextMenuShortcut>
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      {rootPath && (
        <ContextMenuItem onSelect={() => handleRevealInFinder(rootPath)}>
          Reveal Project in Finder
        </ContextMenuItem>
      )}
      {rootPath && (
        <ContextMenuItem onSelect={() => handleOpenInTerminal(rootPath)}>
          Open in Terminal
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => collapseAll()}>Collapse All</ContextMenuItem>
    </ContextMenuContent>
  );

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

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            className="flex-1 overflow-auto hide-scrollbar px-1.5 pb-2"
          >
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
                  const row = flat[virtualRow.index];

                  // Ghost row for pending new-file/new-folder input.
                  if (row.ghost) {
                    return (
                      <TreeRow
                        key={`ghost-${virtualRow.index}`}
                        depth={row.ghost.depth}
                        isDir={row.ghost.isDir}
                        isExpanded={false}
                        isActive
                        name=""
                        editingMode="new"
                        initialValue=""
                        onCommit={(name) => {
                          if (row.ghost!.isDir) {
                            void handleNewFolderCommit(row.ghost!.parentDir, name);
                          } else {
                            void handleNewFileCommit(row.ghost!.parentDir, name);
                          }
                        }}
                        onCancel={endNewEntry}
                        onClick={() => {}}
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                      />
                    );
                  }

                  const node = row.node!;
                  const isDir = node.entry.is_dir;
                  const isActive = !isDir && node.entry.path === activeFilePath;
                  const isCut = clipboard?.isCut === true && clipboard.path === node.entry.path;
                  const isRenaming = pendingRenamePath === node.entry.path;

                  return (
                    <ContextMenu key={node.entry.path}>
                      <ContextMenuTrigger asChild>
                        <div>
                          <TreeRow
                            depth={node.depth}
                            isDir={isDir}
                            isExpanded={node.expanded}
                            isActive={isActive}
                            name={node.entry.name}
                            title={node.entry.path}
                            editingMode={isRenaming ? "rename" : undefined}
                            initialValue={isRenaming ? node.entry.name : undefined}
                            onCommit={(name) => void handleRenameCommit(node.entry.path, name)}
                            onCancel={endRename}
                            isCut={isCut}
                            onClick={() => {
                              if (isDir) {
                                toggleExpand(node.entry.path);
                              } else {
                                handleOpenFile(node.entry.path, node.entry.name);
                              }
                            }}
                            style={{ transform: `translateY(${virtualRow.start}px)` }}
                          />
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>{rowMenuItems(node.entry)}</ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        {emptyAreaMenu}
      </ContextMenu>

      {deleteTarget && (
        <FileTreeConfirmDelete
          open={!!deleteTarget}
          name={deleteTarget.name}
          isDir={deleteTarget.isDir}
          onConfirm={() => {
            const t = deleteTarget;
            if (!t) return;
            void handleDelete({
              name: t.name,
              path: t.path,
              is_dir: t.isDir,
              is_symlink: false,
              size: 0,
              extension: null,
            });
          }}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        />
      )}
    </div>
  );
}

// Cheap exists check via read_directory probe — Tauri doesn't expose
// a dedicated `exists` command and we don't want to add one for the
// paste-collision loop. We try to read the parent's listing and look
// for the basename. Falls back to false on error.
async function pathExists(path: string): Promise<boolean> {
  try {
    const lastSlash = path.lastIndexOf("/");
    const parent = lastSlash > 0 ? path.slice(0, lastSlash) : "/";
    const name = path.slice(lastSlash + 1);
    const entries = await invoke<Array<{ name: string }>>("read_directory", { path: parent });
    return entries.some((e) => e.name === name);
  } catch {
    return false;
  }
}
