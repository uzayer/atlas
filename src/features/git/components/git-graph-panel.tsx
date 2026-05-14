import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import * as Dialog from "@radix-ui/react-dialog";
import {
  RefreshCw,
  GitBranch,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { CommitRowView } from "./commit-node";
import {
  buildGraph,
  ROW_HEIGHT,
  type RawCommit,
  type RawRefs,
  type BuiltGraph,
} from "../lib/git-graph";

const DEFAULT_LIMIT = 1000;
const SIGNATURE_REFRESH_MS = 3000;

// Persist scroll position per repo path across mount/unmount + fullscreen toggle.
const scrollPositionCache = new Map<string, number>();

export function GitGraphPanel() {
  const project = useProjectStore.use.currentProject();
  const isRepo = useGitStore.use.isRepo();
  const path = project?.path ?? "";

  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const queryClient = useQueryClient();

  const sigQuery = useQuery({
    queryKey: ["git-graph-signature", path],
    queryFn: () => invoke<string>("git_graph_signature", { path }),
    enabled: !!path && isRepo,
    staleTime: SIGNATURE_REFRESH_MS,
    refetchInterval: SIGNATURE_REFRESH_MS,
    refetchOnWindowFocus: true,
  });
  const signature = sigQuery.data ?? "";

  const graphQuery = useQuery<BuiltGraph>({
    queryKey: ["git-graph", path, signature, limit],
    queryFn: async () => {
      const [log, refs] = await Promise.all([
        invoke<RawCommit[]>("git_log", { path, limit, all: true }),
        invoke<RawRefs>("git_refs", { path }),
      ]);
      return buildGraph(log, refs);
    },
    enabled: !!path && isRepo && !!signature,
    staleTime: Infinity,
    placeholderData: (prev) => prev,
  });

  const rows = graphQuery.data?.rows ?? [];

  useEffect(() => {
    if (!path) return;
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ["git-graph-signature", path] });
    };
    window.addEventListener("atlas:git-changed", handler);
    return () => window.removeEventListener("atlas:git-changed", handler);
  }, [path, queryClient]);

  const onSelect = useCallback((sha: string) => {
    setSelectedSha((cur) => (cur === sha ? null : sha));
  }, []);

  if (!path || !isRepo) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-[12px] text-text-tertiary gap-2 px-6 text-center">
        <GitBranch size={18} className="opacity-60" />
        <div>Not a git repository.</div>
        <div className="text-[10px]">
          Open a project that contains a `.git` folder to see its history.
        </div>
      </div>
    );
  }

  const refreshing = sigQuery.isFetching || graphQuery.isFetching;

  const inner = (
    <GraphView
      path={path}
      rows={rows}
      isLoading={graphQuery.isLoading && !graphQuery.data}
      compact={!fullscreen}
      selectedSha={selectedSha}
      onSelect={onSelect}
      limit={limit}
      onShowMore={() => setLimit((l) => l + DEFAULT_LIMIT)}
      refreshing={refreshing}
      onRefresh={() => sigQuery.refetch()}
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen((f) => !f)}
    />
  );

  if (!fullscreen) return inner;

  // Fullscreen: same component, just inside a centered Radix Dialog covering the viewport.
  return (
    <Dialog.Root open onOpenChange={(open) => !open && setFullscreen(false)}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 bg-black/60"
          style={{ zIndex: "var(--z-overlay)" as unknown as number }}
        />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-8.5 left-4 right-4 bottom-6 rounded-xl border border-[var(--border-default)] bg-[var(--bg-sidebar)] overflow-hidden flex flex-col shadow-[var(--shadow-overlay)] focus:outline-none"
          style={{ zIndex: "var(--z-modal)" as unknown as number }}
        >
          <Dialog.Title className="sr-only">Git Graph</Dialog.Title>
          {inner}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface GraphViewProps {
  path: string;
  rows: BuiltGraph["rows"];
  isLoading: boolean;
  compact: boolean;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
  limit: number;
  onShowMore: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

function GraphView({
  path,
  rows,
  isLoading,
  compact,
  selectedSha,
  onSelect,
  limit,
  onShowMore,
  refreshing,
  onRefresh,
  fullscreen,
  onToggleFullscreen,
}: GraphViewProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (i) => rows[i]?.sha ?? i,
  });

  // Scroll cache — keyed by repo path, shared between inline + fullscreen mounts.
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const cached = scrollPositionCache.get(path);
    if (cached !== undefined) el.scrollTop = cached;
  }, [path]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      scrollPositionCache.set(path, el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollPositionCache.set(path, el.scrollTop);
      el.removeEventListener("scroll", onScroll);
    };
  }, [path]);

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const showMore = useMemo(() => rows.length >= limit, [rows.length, limit]);

  return (
    <div className="h-full flex flex-col bg-bg-sidebar">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-[28px] shrink-0 border-b border-border-subtle">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wide">
            Git Graph
          </span>
          {rows.length > 0 && (
            <span className="text-[10px] text-text-tertiary">
              · {rows.length} commits
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onToggleFullscreen}
            className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          </button>
          <button
            onClick={onRefresh}
            className={cn(
              "p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors cursor-pointer",
              refreshing && "animate-spin"
            )}
            title="Refresh"
          >
            <RefreshCw size={11} />
          </button>
        </div>
      </div>

      {/* Virtualized commit list */}
      <div className="flex-1 min-h-0 relative">
        <div
          ref={parentRef}
          className="absolute inset-0 overflow-auto hide-scrollbar"
        >
          {isLoading && (
            <div className="px-3 py-3 text-[11px] text-text-tertiary">Loading…</div>
          )}
          {rows.length === 0 && !isLoading && (
            <div className="px-3 py-3 text-[11px] text-text-tertiary">No commits.</div>
          )}
          {rows.length > 0 && (
            <div style={{ height: totalSize, width: "100%", position: "relative" }}>
              {items.map((v) => {
                const row = rows[v.index];
                return (
                  <div
                    key={row.sha}
                    data-index={v.index}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${v.start}px)`,
                    }}
                  >
                    <CommitRowView
                      row={row}
                      selected={row.sha === selectedSha}
                      compact={compact}
                      onSelect={onSelect}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {showMore && (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute left-0 right-0 bottom-0 h-16 z-[1]"
              style={{
                background:
                  "linear-gradient(to bottom, transparent, var(--bg-sidebar))",
              }}
            />
            <button
              onClick={onShowMore}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 h-7 rounded-full border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] shadow-[0_6px_16px_rgba(0,0,0,0.5)] transition-colors cursor-pointer"
              style={{ backdropFilter: "blur(4px)" }}
              title={`Show ${DEFAULT_LIMIT} more commits`}
            >
              Show {DEFAULT_LIMIT} more
            </button>
          </>
        )}
      </div>
    </div>
  );
}
