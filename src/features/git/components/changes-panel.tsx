import { useEffect, useState, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as Popover from "@radix-ui/react-popover";
import { useGitStore } from "../stores/git-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { ExternalLink, RefreshCw, Settings, Search, MoreHorizontal, ArrowDownWideNarrow, Code } from "lucide-react";
import { cn } from "@/lib/utils";

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  language: string;
}

interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLine?: number;
  newLine?: number;
}

function getLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
    py: "Python", rs: "Rust", go: "Go", rb: "Ruby", java: "Java",
    c: "C", h: "C", cpp: "C++", hpp: "C++", swift: "Swift", kt: "Kotlin",
    css: "CSS", scss: "CSS", html: "HTML", json: "JSON", toml: "TOML",
    yaml: "YAML", yml: "YAML", md: "Markdown", mdx: "Markdown",
    sh: "Shell", sql: "SQL", xml: "XML", svg: "XML",
  };
  return map[ext] ?? ext.toUpperCase();
}

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!raw.trim()) return files;
  const fileSections = raw.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");
    const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
    const path = headerMatch?.[2] ?? headerMatch?.[1] ?? "unknown";
    let additions = 0, deletions = 0;
    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let oldLine = 0, newLine = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        oldLine = parseInt(hunkMatch[1], 10);
        newLine = parseInt(hunkMatch[2], 10);
        currentHunk = { header: line, oldStart: oldLine, newStart: newLine, lines: [] };
        hunks.push(currentHunk);
        continue;
      }
      if (!currentHunk) continue;
      if (line.startsWith("+")) { currentHunk.lines.push({ type: "add", content: line.slice(1), newLine: newLine++ }); additions++; }
      else if (line.startsWith("-")) { currentHunk.lines.push({ type: "remove", content: line.slice(1), oldLine: oldLine++ }); deletions++; }
      else if (line.startsWith(" ")) { currentHunk.lines.push({ type: "context", content: line.slice(1), oldLine: oldLine++, newLine: newLine++ }); }
    }
    files.push({ path, additions, deletions, hunks, language: getLanguage(path) });
  }
  return files;
}

type SortMode = "default" | "most-changes";

type VirtualRow =
  | { kind: "file-header"; file: DiffFile; fileIndex: number }
  | { kind: "diff-line"; line: DiffLine; fileIndex: number }
  | { kind: "file-footer"; fileIndex: number };

function buildRows(files: DiffFile[], collapsedFiles: Set<string>): VirtualRow[] {
  const rows: VirtualRow[] = [];
  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    rows.push({ kind: "file-header", file, fileIndex: fi });
    if (collapsedFiles.has(file.path)) continue;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        rows.push({ kind: "diff-line", line, fileIndex: fi });
      }
    }
    // Bottom-cap row so the diff card closes with a rounded border
    // instead of leaving a dangling open edge below the last line.
    rows.push({ kind: "file-footer", fileIndex: fi });
  }
  return rows;
}

export function ChangesPanel() {
  const diff = useGitStore.use.diff();
  const branch = useGitStore.use.branch();
  const files = useGitStore.use.files();
  const isRepo = useGitStore.use.isRepo();
  const { loadDiff } = useGitStore.use.actions();
  const { addTab } = useLayoutStore.use.actions();
  const currentProject = useProjectStore.use.currentProject();
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [langFilter, setLangFilter] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isRepo) loadDiff();
  }, [isRepo, files.length, loadDiff]);

  const parsed = useMemo(() => parseDiff(diff), [diff]);

  // Available languages for filter
  const languages = useMemo(() => {
    const set = new Set(parsed.map((f) => f.language));
    return Array.from(set).sort();
  }, [parsed]);

  // Filtered + sorted files
  const filteredFiles = useMemo(() => {
    let result = parsed;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((f) => f.path.toLowerCase().includes(q));
    }
    if (langFilter) {
      result = result.filter((f) => f.language === langFilter);
    }
    if (sortMode === "most-changes") {
      result = [...result].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions));
    }
    return result;
  }, [parsed, searchQuery, langFilter, sortMode]);

  const rows = useMemo(() => buildRows(filteredFiles, collapsedFiles), [filteredFiles, collapsedFiles]);
  const totalAdditions = useMemo(() => filteredFiles.reduce((s, f) => s + f.additions, 0), [filteredFiles]);
  const totalDeletions = useMemo(() => filteredFiles.reduce((s, f) => s + f.deletions, 0), [filteredFiles]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const k = rows[i].kind;
      if (k === "file-header") return 30;
      if (k === "file-footer") return 8;
      return 20;
    },
    overscan: 30,
  });

  const toggleFile = (path: string) => {
    setCollapsedFiles((s) => { const next = new Set(s); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  };

  const openFile = (filePath: string) => {
    if (!currentProject) return;
    const fullPath = `${currentProject.path}/${filePath}`;
    addTab({ id: `editor-${fullPath}`, type: "editor", title: filePath.split("/").pop() ?? filePath, closable: true, dirty: false, data: { filePath: fullPath } });
  };

  if (!isRepo) return <div className="px-3 py-8 text-center text-[11px] text-text-tertiary">Not a git repository</div>;
  if (parsed.length === 0) return (
    <div className="px-3 py-8 text-center">
      <div className="text-[11px] text-text-tertiary">No changes</div>
      <button onClick={loadDiff} className="mt-2 text-[10px] text-accent hover:underline cursor-pointer">Refresh</button>
    </div>
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border-default shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-text-secondary">Changes</span>
          <div className="flex items-center gap-0.5">
            <button onClick={loadDiff} className="p-1 rounded hover:bg-bg-hover text-text-tertiary cursor-pointer" title="Refresh"><RefreshCw size={10} /></button>
            <FileListPopover files={filteredFiles} onOpen={openFile} />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] text-text-tertiary font-mono">{branch}</span>
          <span className="text-[10px] text-text-tertiary">{filteredFiles.length} file{filteredFiles.length !== 1 ? "s" : ""}</span>
          <span className="text-[10px] font-mono"><span className="text-success">+{totalAdditions}</span> <span className="text-error">-{totalDeletions}</span></span>
        </div>
      </div>

      {/* Filters */}
      <div className="px-3 py-1.5 border-b border-border-default shrink-0 flex items-center gap-1.5">
        <div className="flex-1 flex items-center gap-1.5 h-6 rounded border border-border-default bg-bg-secondary px-2">
          <Search size={10} className="text-text-tertiary shrink-0" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter files..."
            className="flex-1 bg-transparent outline-none text-[10px] text-text-primary placeholder:text-text-tertiary"
          />
        </div>
        <button
          onClick={() => setSortMode(sortMode === "most-changes" ? "default" : "most-changes")}
          className={cn("p-1 rounded transition-colors cursor-pointer", sortMode === "most-changes" ? "text-accent bg-bg-selected" : "text-text-tertiary hover:bg-bg-hover")}
          title="Sort by most changes"
        >
          <ArrowDownWideNarrow size={11} />
        </button>
        <LangFilterPopover languages={languages} active={langFilter} onSelect={setLangFilter} />
      </div>

      {/* Virtualized diff list */}
      <div ref={scrollRef} className="flex-1 overflow-auto hide-scrollbar px-3 py-2">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];

            if (row.kind === "file-header") {
              const file = row.file;
              return (
                <div
                  key={virtualRow.index}
                  style={{ position: "absolute", top: 0, transform: `translateY(${virtualRow.start}px)`, width: "100%", height: virtualRow.size }}
                  className="flex items-center gap-1.5 px-3 rounded-t-md border border-border-default bg-[#0F0F0F] hover:bg-[#141414] cursor-pointer group"
                  onClick={() => toggleFile(file.path)}
                >
                  <Settings size={10} className="text-text-tertiary shrink-0" />
                  <span className="text-[11px] text-text-secondary font-mono truncate flex-1 select-text">{file.path}</span>
                  <button onClick={(e) => { e.stopPropagation(); openFile(file.path); }} className="opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-text-primary"><ExternalLink size={9} /></button>
                  <span className="text-[9px] font-mono shrink-0"><span className="text-success">+{file.additions}</span> <span className="text-error">-{file.deletions}</span></span>
                </div>
              );
            }

            if (row.kind === "file-footer") {
              return (
                <div
                  key={virtualRow.index}
                  style={{ position: "absolute", top: 0, transform: `translateY(${virtualRow.start}px)`, width: "100%", height: virtualRow.size }}
                  className="border-x border-b border-border-default rounded-b-md bg-[#0a0a0a]"
                />
              );
            }

            if (row.kind === "diff-line") {
              const line = row.line;
              return (
                <div
                  key={virtualRow.index}
                  style={{ position: "absolute", top: 0, transform: `translateY(${virtualRow.start}px)`, width: "100%", height: virtualRow.size }}
                  className={cn(
                    "flex text-[11px] font-mono leading-[20px] select-text border-x border-border-default",
                    line.type === "add" && "bg-[#0d2211]",
                    line.type === "remove" && "bg-[#220d0d]",
                    line.type === "context" && "bg-[#0a0a0a]",
                  )}
                >
                  <span className={cn("w-[3px] shrink-0", line.type === "add" && "bg-success", line.type === "remove" && "bg-error")} />
                  <span className="w-[36px] shrink-0 text-right pr-2 text-[10px] text-text-tertiary select-none">{line.oldLine ?? ""}</span>
                  <span className="w-[36px] shrink-0 text-right pr-2 text-[10px] text-text-tertiary select-none">{line.newLine ?? ""}</span>
                  <span className="flex-1 min-w-0 whitespace-pre pr-3 text-text-secondary overflow-hidden">{line.content}</span>
                </div>
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}

// Language filter popover
function LangFilterPopover({ languages, active, onSelect }: { languages: string[]; active: string | null; onSelect: (lang: string | null) => void }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className={cn("p-1 rounded transition-colors cursor-pointer", active ? "text-accent bg-bg-selected" : "text-text-tertiary hover:bg-bg-hover")} title="Filter by language">
          <Code size={11} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="bottom" align="end" sideOffset={4} className="w-[140px] rounded-lg border border-[#1a1a1a] bg-[#0f0f0f] shadow-xl py-1" style={{ zIndex: 99999 }}>
          <button onClick={() => onSelect(null)} className={cn("w-full text-left px-3 h-[26px] text-[10px] hover:bg-[#1a1a1a] cursor-default outline-none", !active ? "text-accent" : "text-[#aaa]")}>All languages</button>
          {languages.map((lang) => (
            <button key={lang} onClick={() => onSelect(active === lang ? null : lang)} className={cn("w-full text-left px-3 h-[26px] text-[10px] hover:bg-[#1a1a1a] cursor-default outline-none", active === lang ? "text-accent" : "text-[#aaa]")}>{lang}</button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// File list popover (three-dot menu)
function FileListPopover({ files, onOpen }: { files: DiffFile[]; onOpen: (path: string) => void }) {
  const [search, setSearch] = useState("");
  const filtered = files.filter((f) => f.path.toLowerCase().includes(search.toLowerCase()));

  return (
    <Popover.Root onOpenChange={() => setSearch("")}>
      <Popover.Trigger asChild>
        <button className="p-1 rounded hover:bg-bg-hover text-text-tertiary cursor-pointer" title="All changed files"><MoreHorizontal size={10} /></button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="bottom" align="end" sideOffset={4} className="w-[280px] max-h-[300px] rounded-lg border border-[#1a1a1a] bg-[#0f0f0f] shadow-xl flex flex-col" style={{ zIndex: 99999 }}>
          <div className="flex items-center gap-1.5 px-2 h-[30px] border-b border-[#1a1a1a] shrink-0">
            <Search size={10} className="text-[#555] shrink-0" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search files..." className="flex-1 bg-transparent outline-none text-[10px] text-[#ccc] placeholder:text-[#444]" autoFocus onKeyDown={(e) => e.stopPropagation()} />
          </div>
          <div className="overflow-y-auto py-1 hide-scrollbar">
            {filtered.map((file) => (
              <button
                key={file.path}
                onClick={() => onOpen(file.path)}
                className="w-full flex items-center gap-2 px-3 h-[26px] text-[10px] text-[#999] hover:bg-[#1a1a1a] hover:text-[#fff] cursor-default outline-none font-mono"
              >
                <span className="truncate flex-1 text-left">{file.path}</span>
                <span className="shrink-0"><span className="text-success">+{file.additions}</span> <span className="text-error">-{file.deletions}</span></span>
              </button>
            ))}
            {filtered.length === 0 && <div className="px-3 py-2 text-[10px] text-[#444] text-center">No files found</div>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
