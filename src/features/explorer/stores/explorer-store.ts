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
        refresh: async () => {
          const rootPath = get().rootPath;
          if (rootPath) {
            await get().actions.openFolder(rootPath);
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
