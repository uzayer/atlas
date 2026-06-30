import { memo, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useGitStore } from "../stores/git-store";
import { openGitDiff } from "../lib/git-diff-api";

const TREE_ROW_H = 22;

interface ChangedFilesTreeProps {
  repoPath: string;
  /** Staged-ness of the diff tab — the tree lists files of the same kind and
   *  opens them with the same flag so a click always lands on a real diff. */
  staged: boolean;
  /** Path of the file currently shown in the diff pane (highlighted). */
  currentFile: string;
}

interface DirNode {
  name: string;
  path: string;
  isDir: true;
  children: TreeNode[];
}
interface FileNode {
  name: string;
  path: string;
  isDir: false;
  status: string;
}
type TreeNode = DirNode | FileNode;

/** First porcelain char → a tint. Mirrors the Changes-panel status badges. */
function statusColor(status: string): string {
  switch (status[0]) {
    case "A":
    case "?":
      return "var(--status-success, #22c55e)";
    case "M":
      return "var(--status-warning, #f5b43c)";
    case "D":
      return "var(--status-error, #ef4444)";
    case "R":
    case "C":
      return "var(--accent, #6ea8fe)";
    default:
      return "var(--text-tertiary)";
  }
}

function buildTree(files: { path: string; status: string }[]): DirNode {
  const root: DirNode = { name: "", path: "", isDir: true, children: [] };
  for (const { path, status } of files) {
    const parts = path.split("/");
    let dir = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      acc = acc ? `${acc}/${part}` : part;
      if (i === parts.length - 1) {
        dir.children.push({ name: part, path, isDir: false, status });
      } else {
        let next = dir.children.find(
          (c): c is DirNode => c.isDir && c.name === part,
        );
        if (!next) {
          next = { name: part, path: acc, isDir: true, children: [] };
          dir.children.push(next);
        }
        dir = next;
      }
    }
  }
  collapseChains(root);
  sortTree(root);
  return root;
}

/** Fold single-child directory chains into one row (src ▸ features ▸ git →
 *  "src/features/git"), the way VS Code / JetBrains compact trees do. */
function collapseChains(dir: DirNode) {
  for (const child of dir.children) {
    if (child.isDir) collapseChains(child);
  }
  // Root keeps its (empty) name; only fold interior dirs.
  if (
    dir.name !== "" &&
    dir.children.length === 1 &&
    dir.children[0].isDir
  ) {
    const only = dir.children[0];
    dir.name = `${dir.name}/${only.name}`;
    dir.path = only.path;
    dir.children = only.children;
  }
}

function sortTree(dir: DirNode) {
  dir.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of dir.children) if (c.isDir) sortTree(c);
}

interface FlatRow {
  node: TreeNode;
  depth: number;
}

function flatten(dir: DirNode, collapsed: Set<string>, depth: number): FlatRow[] {
  const out: FlatRow[] = [];
  for (const child of dir.children) {
    out.push({ node: child, depth });
    if (child.isDir && !collapsed.has(child.path)) {
      out.push(...flatten(child, collapsed, depth + 1));
    }
  }
  return out;
}

export const ChangedFilesTree = memo(function ChangedFilesTree({
  repoPath,
  staged,
  currentFile,
}: ChangedFilesTreeProps) {
  const files = useGitStore.use.files();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = useMemo(() => {
    const seen = new Set<string>();
    const scoped = files
      .filter((f) => f.staged === staged)
      .filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)))
      .map((f) => ({ path: f.path, status: f.status }));
    // Ensure the open file is present even if the store hasn't caught up.
    if (currentFile && !seen.has(currentFile)) {
      scoped.push({ path: currentFile, status: "M" });
    }
    return buildTree(scoped);
  }, [files, staged, currentFile]);

  const rows = useMemo(
    () => flatten(tree, collapsed, 0),
    [tree, collapsed],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TREE_ROW_H,
    overscan: 20,
  });

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex h-full w-56 shrink-0 flex-col border-r border-[var(--border-default)] bg-[var(--bg-secondary)]">
      <div className="flex h-8 shrink-0 items-center border-b border-[var(--border-default)] px-3 text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
        Changed files
        <span className="ml-auto tabular-nums">
          {rows.filter((r) => !r.node.isDir).length}
        </span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto hide-scrollbar py-1">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vr) => {
            const { node, depth } = rows[vr.index];
            const pad = 6 + depth * 12;
            const common = {
              className:
                "absolute left-0 right-0 flex items-center gap-1 pr-2 text-left hover:bg-[var(--bg-hover)] cursor-pointer",
              style: { top: vr.start, height: TREE_ROW_H, paddingLeft: pad },
            } as const;
            if (node.isDir) {
              const open = !collapsed.has(node.path);
              return (
                <button
                  key={`d:${node.path}`}
                  onClick={() => toggle(node.path)}
                  className={`${common.className} text-[11px] text-[var(--text-tertiary)]`}
                  style={common.style}
                >
                  {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  <span className="truncate font-mono">{node.name}</span>
                </button>
              );
            }
            const active = node.path === currentFile;
            return (
              <button
                key={`f:${node.path}`}
                onClick={() => openGitDiff(repoPath, node.path, staged)}
                title={node.path}
                className={`${common.className} gap-1.5 text-[11px] ${
                  active
                    ? "bg-[var(--bg-active,var(--bg-hover))] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)]"
                }`}
                style={{ ...common.style, paddingLeft: pad + 12 }}
              >
                <span
                  className="w-2 shrink-0 text-center font-mono text-[9px]"
                  style={{ color: statusColor(node.status) }}
                >
                  {node.status[0]}
                </span>
                <span className="truncate font-mono">{node.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});
