import { useMemo } from "react";
import { useAnalysisStore } from "../stores/analysis-store";
import { useExplorerStore } from "@/features/explorer/stores/explorer-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { ScrollArea } from "@/ui/scroll-area";
import {
  Loader2,
  GitCompare,
  Network,
  Flame,
  AlertTriangle,
  TrendingUp,
} from "lucide-react";
import { DependencyGraph } from "./dependency-graph";

export function AnalysisPanel() {
  const rootPath = useExplorerStore.use.rootPath();
  const indexed = useAnalysisStore.use.indexed();
  const loading = useAnalysisStore.use.loading();
  const totalFiles = useAnalysisStore.use.totalFiles();
  const totalLines = useAnalysisStore.use.totalLines();
  const symbols = useAnalysisStore.use.symbols();
  const languages = useAnalysisStore.use.languages();
  const gitFiles = useGitStore.use.files();
  const { addTab } = useLayoutStore.use.actions();
  const { analyzeProject } = useAnalysisStore.use.actions();

  // Compute blast radius from git changed files
  const changedFiles = useMemo(() => {
    return gitFiles.map((f) => f.path);
  }, [gitFiles]);

  // Find symbols in changed files (simple blast radius approximation)
  const affectedSymbols = useMemo(() => {
    if (changedFiles.length === 0 || symbols.length === 0) return [];
    return symbols.filter((s) =>
      changedFiles.some((cf) => s.file_path.endsWith(cf) || cf.endsWith(s.file_path))
    );
  }, [changedFiles, symbols]);

  // Compute file heatmap — files with most symbols
  const fileHeatmap = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of symbols) {
      counts[s.file_path] = (counts[s.file_path] || 0) + 1;
    }
    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 15)
      .map(([file, count]) => ({ file, count }));
  }, [symbols]);

  // Dependency map — files that share symbol names (imports/references approximation).
  //
  // Uses Map (not a plain object record) on purpose: symbols are user-source
  // identifiers, and names like `constructor`, `toString`, `__proto__`, `push`
  // collide with Object.prototype members when used as record keys —
  // `symbolFiles["constructor"]` returns the Object constructor function,
  // `.push` is undefined on it, and the whole panel crashes. Map has no
  // prototype-chain hazard.
  const dependencyEdges = useMemo(() => {
    const symbolFiles = new Map<string, string[]>();
    for (const s of symbols) {
      const bucket = symbolFiles.get(s.name);
      if (bucket) bucket.push(s.file_path);
      else symbolFiles.set(s.name, [s.file_path]);
    }
    const edges: Array<{ from: string; to: string; symbol: string }> = [];
    for (const [name, files] of symbolFiles) {
      if (files.length > 1) {
        for (let i = 1; i < files.length && edges.length < 30; i++) {
          edges.push({ from: files[0], to: files[i], symbol: name });
        }
      }
    }
    return edges;
  }, [symbols]);

  if (loading) {
    return (
      <div className="px-3 py-8 text-center">
        <Loader2 size={16} className="animate-spin mx-auto text-accent mb-2" />
        <span className="text-[11px] text-text-tertiary">Analyzing...</span>
      </div>
    );
  }

  if (!indexed) {
    return (
      <div className="px-3 py-8 text-center space-y-3">
        <Network size={24} className="mx-auto text-text-tertiary" />
        <div className="text-[11px] text-text-tertiary">No analysis data</div>
        {rootPath && (
          <button
            onClick={() => analyzeProject(rootPath)}
            className="text-[10px] text-accent hover:underline"
          >
            Run analysis
          </button>
        )}
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-4">
        {/* Blast Radius — symbols affected by current git changes */}
        <Section
          icon={GitCompare}
          title="Blast Radius"
          subtitle={`${changedFiles.length} changed files`}
        >
          {changedFiles.length === 0 ? (
            <EmptyHint text="No uncommitted changes" />
          ) : (
            <div className="space-y-0.5">
              <div className="text-[10px] text-text-tertiary px-1 mb-1">
                {affectedSymbols.length} symbols in changed files
              </div>
              {affectedSymbols.slice(0, 12).map((s, i) => (
                <SymbolRow
                  key={`${s.file_path}:${s.line}:${i}`}
                  name={s.name}
                  kind={s.kind}
                  line={s.line}
                  onClick={() => {
                    const fullPath = rootPath ? `${rootPath}/${s.file_path}` : s.file_path;
                    addTab({
                      id: `editor-${fullPath}`,
                      type: "editor",
                      title: s.file_path.split("/").pop() ?? s.name,
                      closable: true,
                      dirty: false,
                      data: { filePath: fullPath },
                    });
                  }}
                />
              ))}
              {affectedSymbols.length > 12 && (
                <div className="text-[9px] text-text-tertiary px-1 pt-1">
                  +{affectedSymbols.length - 12} more
                </div>
              )}
            </div>
          )}
        </Section>

        {/* File Heatmap — complexity hotspots */}
        <Section
          icon={Flame}
          title="Complexity Heatmap"
          subtitle="Symbols per file"
        >
          {fileHeatmap.length === 0 ? (
            <EmptyHint text="No data" />
          ) : (
            <div className="space-y-0.5">
              {fileHeatmap.map((item) => {
                const maxCount = fileHeatmap[0].count;
                const pct = Math.round((item.count / maxCount) * 100);
                return (
                  <div
                    key={item.file}
                    className="flex items-center gap-2 px-1 h-[22px] rounded hover:bg-bg-hover cursor-default group"
                  >
                    <div className="flex-1 min-w-0 relative">
                      <div
                        className="absolute inset-y-0 left-0 rounded-sm bg-accent-muted"
                        style={{ width: `${pct}%` }}
                      />
                      <span className="relative text-[10px] font-mono text-text-secondary truncate block px-1">
                        {item.file}
                      </span>
                    </div>
                    <span className="text-[9px] font-mono text-text-tertiary shrink-0 w-6 text-right">
                      {item.count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* Dependency Graph — Obsidian-style */}
        <Section
          icon={Network}
          title="Cross-file Dependencies"
          subtitle={`${dependencyEdges.length} connections`}
        >
          <DependencyGraph edges={dependencyEdges} />
        </Section>

        {/* Language Distribution */}
        <Section
          icon={TrendingUp}
          title="Language Distribution"
          subtitle={`${totalFiles} files, ${totalLines.toLocaleString()} lines`}
        >
          <div className="space-y-1">
            {languages.slice(0, 8).map((l) => {
              const pct = totalLines > 0 ? Math.round((l.lines / totalLines) * 100) : 0;
              return (
                <div key={l.language} className="space-y-0.5">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] text-text-secondary">{l.language}</span>
                    <span className="text-[9px] text-text-tertiary font-mono">
                      {pct}% · {l.lines.toLocaleString()}L
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-bg-elevated mx-1">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      </div>
    </ScrollArea>
  );
}

function Section({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ElementType;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border-default bg-bg-secondary overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 h-[28px] border-b border-border-subtle">
        <Icon size={11} className="text-accent shrink-0" />
        <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide">
          {title}
        </span>
        {subtitle && (
          <span className="text-[9px] text-text-tertiary ml-auto">{subtitle}</span>
        )}
      </div>
      <div className="p-1.5">{children}</div>
    </div>
  );
}

function SymbolRow({
  name,
  kind,
  line,
  onClick,
}: {
  name: string;
  kind: string;
  line: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-1.5 px-1 h-[20px] rounded hover:bg-bg-hover text-left"
    >
      <AlertTriangle size={9} className="text-status-warning shrink-0" />
      <span className="text-[10px] text-text-secondary truncate flex-1">{name}</span>
      <span className="text-[8px] text-text-tertiary font-mono shrink-0">{kind}</span>
      <span className="text-[8px] text-text-tertiary font-mono shrink-0">:{line}</span>
    </button>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="text-[10px] text-text-tertiary text-center py-3">{text}</div>
  );
}
