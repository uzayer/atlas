import { useMemo } from "react";
import { useAnalysisStore } from "../stores/analysis-store";
import { useExplorerStore } from "@/features/explorer/stores/explorer-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { ScrollArea } from "@/ui/scroll-area";
import {
  Loader2,
  Code,
  Box,
  Diamond,
  Layers,
  FileCode,
} from "lucide-react";
import { cn } from "@/lib/utils";

const KIND_ICONS: Record<string, React.ElementType> = {
  function: Code,
  struct: Box,
  class: Box,
  enum: Diamond,
  trait: Layers,
  interface: Layers,
  type: Diamond,
};

const KIND_COLORS: Record<string, string> = {
  function: "text-[var(--accent-primary)]",
  struct: "text-[var(--status-info)]",
  class: "text-[var(--status-info)]",
  enum: "text-[var(--status-warning)]",
  trait: "text-[var(--status-success)]",
  interface: "text-[var(--status-success)]",
  type: "text-[var(--status-warning)]",
};

export function ExplorePanel() {
  const rootPath = useExplorerStore.use.rootPath();
  const indexed = useAnalysisStore.use.indexed();
  const loading = useAnalysisStore.use.loading();
  const totalFiles = useAnalysisStore.use.totalFiles();
  const totalLines = useAnalysisStore.use.totalLines();
  const languages = useAnalysisStore.use.languages();
  const symbols = useAnalysisStore.use.symbols();
  const filterKind = useAnalysisStore.use.filterKind();
  const searchQuery = useAnalysisStore.use.searchQuery();
  const { analyzeProject, setFilterKind, setSearchQuery } = useAnalysisStore.use.actions();
  const { addTab } = useLayoutStore.use.actions();
  const knowledgeEntries = useKnowledgeStore.use.entries();

  // Subscribe to a PRIMITIVE task-status signature, not the whole `sessions`
  // map: immer rewrites the sessions root on every streaming chunk (~60/s), so
  // subscribing to it re-rendered this panel every frame during any stream even
  // though only task counts matter. The signature only changes when a task is
  // added/removed or flips status, so we read the rich state non-reactively.
  const taskSig = useChatStore((s) =>
    Object.values(s.sessions)
      .map((x) => x.tasks.map((t) => t.status).join(","))
      .join("|"),
  );
  const agentTaskStats = useMemo(() => {
    const allTasks = Object.values(useChatStore.getState().sessions).flatMap((s) => s.tasks);
    return {
      total: allTasks.length,
      pending: allTasks.filter((t) => t.status === "action_needed" || t.status === "running").length,
    };
  }, [taskSig]);

  // Analysis is triggered by project-store.openProject(), not auto on mount

  const filteredSymbols = useMemo(() => {
    let result = symbols;
    if (filterKind) {
      result = result.filter((s) => s.kind === filterKind);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((s) => s.name.toLowerCase().includes(q));
    }
    return result.slice(0, 200); // Limit for performance
  }, [symbols, filterKind, searchQuery]);

  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of symbols) {
      counts[s.kind] = (counts[s.kind] || 0) + 1;
    }
    return counts;
  }, [symbols]);

  if (loading) {
    return (
      <div className="px-3 py-8 text-center">
        <Loader2 size={16} className="animate-spin mx-auto text-accent mb-2" />
        <span className="text-[11px] text-text-tertiary">Analyzing project...</span>
      </div>
    );
  }

  const handlePickFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true });
      if (selected) {
        analyzeProject(selected as string);
      }
    } catch {
      // dialog not available
    }
  };

  if (!indexed) {
    return (
      <div className="px-3 py-8 text-center space-y-3">
        <div className="text-[11px] text-text-tertiary">No project indexed</div>
        <button
          onClick={handlePickFolder}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-text-inverse text-[11px] font-medium hover:bg-accent-hover transition-colors"
        >
          <Loader2 size={11} className="animate-none" />
          Analyze Project
        </button>
        {rootPath && (
          <button
            onClick={() => analyzeProject(rootPath)}
            className="block mx-auto text-[10px] text-accent hover:underline mt-1"
          >
            Analyze current folder
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Stats — horizontally scrollable */}
      <div className="px-2 pt-2 shrink-0 overflow-x-auto hide-scrollbar">
        <div className="flex gap-2 min-w-max">
          <StatCard label="Files" value={totalFiles.toLocaleString()} />
          <StatCard label="Lines" value={totalLines.toLocaleString()} />
          <StatCard label="Symbols" value={symbols.length.toLocaleString()} />
          <StatCard label="Notes" value={knowledgeEntries.length.toString()} />
          <StatCard label="Tasks" value={agentTaskStats.total.toString()} sub={agentTaskStats.pending > 0 ? `${agentTaskStats.pending} active` : undefined} />
        </div>
      </div>

      {/* Languages */}
      <div className="px-2 mt-3 shrink-0">
        <SectionHeader label="Languages" count={languages.length} />
        <div className="space-y-0.5 mt-1">
          {languages.slice(0, 8).map((l) => (
            <div key={l.language} className="flex items-center justify-between px-1 py-0.5">
              <span className="text-[11px] text-text-secondary">{l.language}</span>
              <span className="text-[10px] text-text-tertiary font-mono">
                {l.files}f / {l.lines.toLocaleString()}L
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Symbol filter */}
      <div className="px-2 mt-3 shrink-0">
        <SectionHeader label="Symbols" count={symbols.length} />
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter symbols..."
          className="w-full h-6 mt-1 rounded border border-border-default bg-bg-secondary px-2 text-[10px] text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-border-focus"
        />
        <div className="flex flex-wrap gap-1 mt-1.5">
          <KindFilter label="All" kind={null} active={filterKind === null} count={symbols.length} onClick={() => setFilterKind(null)} />
          {Object.entries(kindCounts).map(([kind, count]) => (
            <KindFilter key={kind} label={kind} kind={kind} active={filterKind === kind} count={count} onClick={() => setFilterKind(filterKind === kind ? null : kind)} />
          ))}
        </div>
      </div>

      {/* Symbol list — fills remaining height */}
      <ScrollArea className="px-2 mt-2 flex-1 min-h-0 overflow-y-auto">
        {filteredSymbols.map((sym, i) => {
          const Icon = KIND_ICONS[sym.kind] ?? FileCode;
          const color = KIND_COLORS[sym.kind] ?? "text-text-tertiary";
          return (
            <button
              key={`${sym.file_path}:${sym.line}:${i}`}
              onClick={() => {
                const fullPath = rootPath ? `${rootPath}/${sym.file_path}` : sym.file_path;
                addTab({
                  id: `editor-${fullPath}`,
                  type: "editor",
                  title: sym.file_path.split("/").pop() ?? sym.name,
                  closable: true,
                  dirty: false,
                  data: { filePath: fullPath },
                });
              }}
              className="w-full flex items-center gap-1.5 px-1 h-[22px] rounded hover:bg-bg-hover text-left group"
            >
              <Icon size={11} className={cn("shrink-0", color)} />
              <span className="text-[11px] text-text-secondary group-hover:text-text-primary truncate flex-1">
                {sym.name}
              </span>
              <span className="text-[9px] text-text-tertiary font-mono shrink-0">
                :{sym.line}
              </span>
            </button>
          );
        })}
      </ScrollArea>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-[#1a1a1a] bg-[#0F0F0F] px-3 py-2 text-center shrink-0 min-w-[72px]">
      <div className="text-[13px] font-semibold text-text-primary font-mono leading-none">{value}</div>
      <div className="text-[9px] text-text-tertiary uppercase tracking-wide mt-1">{label}</div>
      {sub && <div className="text-[8px] text-accent mt-0.5">{sub}</div>}
    </div>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wide">{label}</span>
      <span className="text-[9px] text-text-tertiary">{count}</span>
    </div>
  );
}

function KindFilter({ label, active, count, onClick }: { label: string; kind: string | null; active: boolean; count: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors",
        active ? "bg-accent text-text-inverse" : "bg-bg-elevated text-text-tertiary hover:text-text-secondary border border-border-default"
      )}
    >
      {label} ({count})
    </button>
  );
}
