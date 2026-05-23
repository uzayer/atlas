import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import { invoke } from "@tauri-apps/api/core";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  extension: string | null;
}

interface TreeNode {
  entry: FileEntry;
  children: TreeNode[] | null; // null = not loaded, [] = empty
  expanded: boolean;
  depth: number;
}

interface ExplorerState {
  rootPath: string | null;
  tree: TreeNode[];
  loading: boolean;
}

interface ExplorerActions {
  actions: {
    openFolder: (path: string) => Promise<void>;
    toggleExpand: (path: string) => Promise<void>;
    /** Re-fetch a specific directory's children and reconcile in
     *  place, preserving expansion state of any subtrees that
     *  survive the refresh. Used by the filesystem-watcher listener
     *  to incrementally patch the tree when the agent (or anything
     *  else) writes a file in the project. No-op if the directory
     *  isn't currently loaded in the tree. */
    reconcileDirectory: (dirPath: string) => Promise<void>;
    /** Full re-walk of the visible tree. Called when the watcher
     *  reports an opaque event (`fullRefresh: true`) that can't be
     *  pinned to a specific dir, OR programmatically when needed. */
    refresh: () => Promise<void>;
  };
}

export const useExplorerStore = createSelectors(
  create<ExplorerState & ExplorerActions>()(
    immer((set, get) => ({
      rootPath: null,
      tree: [],
      loading: false,
      actions: {
        openFolder: async (path: string) => {
          set((s) => {
            s.rootPath = path;
            s.loading = true;
          });
          try {
            const entries = await invoke<FileEntry[]>("read_directory", { path });
            const nodes: TreeNode[] = entries
              .filter((e) => !e.name.startsWith("."))
              .map((e) => ({
                entry: e,
                children: e.is_dir ? null : [],
                expanded: false,
                depth: 0,
              }));
            set((s) => {
              s.tree = nodes;
              s.loading = false;
            });
          } catch {
            set((s) => {
              s.loading = false;
            });
          }
        },
        toggleExpand: async (path: string) => {
          const state = get();
          const node = findNode(state.tree, path);
          if (!node || !node.entry.is_dir) return;

          if (node.expanded) {
            set((s) => {
              const n = findNode(s.tree, path);
              if (n) n.expanded = false;
            });
            return;
          }

          if (node.children === null) {
            try {
              const entries = await invoke<FileEntry[]>("read_directory", { path });
              set((s) => {
                const n = findNode(s.tree, path);
                if (n) {
                  n.children = entries
                    .filter((e) => !e.name.startsWith("."))
                    .map((e) => ({
                      entry: e,
                      children: e.is_dir ? null : [],
                      expanded: false,
                      depth: n.depth + 1,
                    }));
                  n.expanded = true;
                }
              });
            } catch {
              // failed to read
            }
          } else {
            set((s) => {
              const n = findNode(s.tree, path);
              if (n) n.expanded = true;
            });
          }
        },
        reconcileDirectory: async (dirPath: string) => {
          const state = get();
          // Root re-walk if this is the project root.
          if (state.rootPath === dirPath) {
            try {
              const entries = await invoke<FileEntry[]>("read_directory", { path: dirPath });
              set((s) => {
                s.tree = reconcileChildren(s.tree, entries, 0);
              });
            } catch {
              // ignore — agent may have just deleted the directory; the
              // tree's stale view will self-correct on next event.
            }
            return;
          }
          // Sub-dir: only refetch if it's currently loaded (children !== null).
          const existing = findNode(state.tree, dirPath);
          if (!existing || !existing.entry.is_dir || existing.children === null) {
            return;
          }
          try {
            const entries = await invoke<FileEntry[]>("read_directory", { path: dirPath });
            set((s) => {
              const n = findNode(s.tree, dirPath);
              if (!n || n.children === null) return;
              n.children = reconcileChildren(n.children, entries, n.depth + 1);
            });
          } catch {
            // ignore
          }
        },
        refresh: async () => {
          const rootPath = get().rootPath;
          if (rootPath) {
            await get().actions.reconcileDirectory(rootPath);
            // Also reconcile every expanded-loaded subtree so a full
            // refresh actually catches changes deeper in the tree.
            const expandedDirs: string[] = [];
            collectExpandedDirs(get().tree, expandedDirs);
            for (const dir of expandedDirs) {
              await get().actions.reconcileDirectory(dir);
            }
          }
        },
      },
    }))
  )
);

function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.entry.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

function collectExpandedDirs(nodes: TreeNode[], out: string[]): void {
  for (const n of nodes) {
    if (n.entry.is_dir && n.expanded && n.children !== null) {
      out.push(n.entry.path);
      collectExpandedDirs(n.children, out);
    }
  }
}

/** Merge a fresh directory listing into an existing children array,
 *  preserving the `expanded` + `children` state of any subtree whose
 *  path still exists. New entries are added (with no preloaded
 *  children); deleted entries are dropped. Used by the watcher
 *  reconciler so opening / expanding / agent-side file writes don't
 *  collapse the user's view. */
function reconcileChildren(
  existing: TreeNode[],
  fresh: FileEntry[],
  depth: number,
): TreeNode[] {
  const filtered = fresh.filter((e) => !e.name.startsWith("."));
  const byPath = new Map<string, TreeNode>();
  for (const n of existing) byPath.set(n.entry.path, n);
  return filtered.map((e): TreeNode => {
    const prev = byPath.get(e.path);
    if (prev) {
      return {
        ...prev,
        entry: e,
        depth,
      };
    }
    return {
      entry: e,
      children: e.is_dir ? null : [],
      expanded: false,
      depth,
    };
  });
}

export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.expanded && node.children) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
}
