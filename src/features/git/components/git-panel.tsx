import { useState } from "react";
import { cn } from "@/lib/utils";
import { useGitStore } from "../stores/git-store";
import { useExplorerStore } from "@/features/explorer/stores/explorer-store";
import { ScrollArea } from "@/ui/scroll-area";
import {
  GitBranch,
  RefreshCw,
  Plus,
  Minus,
  FileEdit,
  FileQuestion,
  FileMinus,
  Check,
  Send,
} from "lucide-react";

const STATUS_ICONS: Record<string, React.ElementType> = {
  M: FileEdit,
  A: Plus,
  D: FileMinus,
  "?": FileQuestion,
  R: FileEdit,
};

const STATUS_COLORS: Record<string, string> = {
  M: "text-[var(--status-warning)]",
  A: "text-[var(--diff-added-text)]",
  D: "text-[var(--diff-removed-text)]",
  "?": "text-text-tertiary",
  R: "text-[var(--status-warning)]",
};

export function GitPanel() {
  const rootPath = useExplorerStore.use.rootPath();
  const isRepo = useGitStore.use.isRepo();
  const branch = useGitStore.use.branch();
  const files = useGitStore.use.files();
  const ahead = useGitStore.use.ahead();
  const behind = useGitStore.use.behind();
  const loading = useGitStore.use.loading();
  const { loadStatus, stageFiles, unstageFiles, commit } =
    useGitStore.use.actions();
  const [commitMsg, setCommitMsg] = useState("");

  // Git status is triggered by project-store.openProject(), not auto on mount

  if (!rootPath) {
    return (
      <div className="px-3 py-4 text-[11px] text-text-tertiary text-center">
        No folder open
      </div>
    );
  }

  if (!isRepo) {
    return (
      <div className="px-3 py-4 text-[11px] text-text-tertiary text-center">
        Not a git repository
      </div>
    );
  }

  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged);

  const handleCommit = async () => {
    if (!commitMsg.trim()) return;
    try {
      await commit(commitMsg.trim());
      setCommitMsg("");
    } catch {
      // error
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Branch header */}
      <div className="flex items-center justify-between px-3 h-[28px] shrink-0">
        <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
          <GitBranch size={12} className="text-accent" />
          <span className="font-mono font-medium">{branch}</span>
          {(ahead > 0 || behind > 0) && (
            <span className="text-[10px] text-text-tertiary">
              {ahead > 0 && `↑${ahead}`}
              {behind > 0 && `↓${behind}`}
            </span>
          )}
        </div>
        <button
          onClick={() => loadStatus(rootPath)}
          className={cn(
            "p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors",
            loading && "animate-spin"
          )}
        >
          <RefreshCw size={11} />
        </button>
      </div>

      <ScrollArea className="flex-1 px-2">
        {/* Staged files */}
        {staged.length > 0 && (
          <div className="mb-2">
            <div className="flex items-center justify-between px-1 py-1">
              <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wide">
                Staged ({staged.length})
              </span>
              <button
                onClick={() => unstageFiles(staged.map((f) => f.path))}
                className="text-[10px] text-text-tertiary hover:text-text-secondary"
              >
                <Minus size={10} />
              </button>
            </div>
            {staged.map((file) => (
              <FileStatusRow
                key={file.path}
                file={file}
                onToggle={() => unstageFiles([file.path])}
                toggleIcon={<Minus size={10} />}
              />
            ))}
          </div>
        )}

        {/* Unstaged files */}
        {unstaged.length > 0 && (
          <div className="mb-2">
            <div className="flex items-center justify-between px-1 py-1">
              <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wide">
                Changes ({unstaged.length})
              </span>
              <button
                onClick={() => stageFiles(unstaged.map((f) => f.path))}
                className="text-[10px] text-text-tertiary hover:text-text-secondary"
              >
                <Plus size={10} />
              </button>
            </div>
            {unstaged.map((file) => (
              <FileStatusRow
                key={file.path}
                file={file}
                onToggle={() => stageFiles([file.path])}
                toggleIcon={<Plus size={10} />}
              />
            ))}
          </div>
        )}

        {files.length === 0 && (
          <div className="px-2 py-4 text-[11px] text-text-tertiary text-center">
            <Check size={14} className="inline mr-1" />
            Working tree clean
          </div>
        )}
      </ScrollArea>

      {/* Commit input */}
      {staged.length > 0 && (
        <div className="p-2 border-t border-border-subtle">
          <div className="flex gap-1.5">
            <input
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  handleCommit();
                }
              }}
              placeholder="Commit message..."
              className="flex-1 h-7 rounded border border-border-default bg-bg-secondary px-2 text-[11px] text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-border-focus"
            />
            <button
              onClick={handleCommit}
              disabled={!commitMsg.trim()}
              className={cn(
                "h-7 w-7 rounded flex items-center justify-center transition-colors",
                commitMsg.trim()
                  ? "bg-accent text-text-inverse hover:bg-accent-hover"
                  : "text-text-tertiary cursor-not-allowed"
              )}
            >
              <Send size={11} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FileStatusRow({
  file,
  onToggle,
  toggleIcon,
}: {
  file: { path: string; status: string; staged: boolean };
  onToggle: () => void;
  toggleIcon: React.ReactNode;
}) {
  const Icon = STATUS_ICONS[file.status] ?? FileQuestion;
  const color = STATUS_COLORS[file.status] ?? "text-text-tertiary";

  return (
    <div className="group flex items-center gap-1.5 px-1 h-[24px] rounded hover:bg-bg-hover">
      <Icon size={12} className={color} />
      <span className="text-[11px] font-mono text-text-secondary truncate flex-1">
        {file.path}
      </span>
      <span className={cn("text-[10px] font-mono w-3 text-center", color)}>
        {file.status}
      </span>
      <button
        onClick={onToggle}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-bg-active text-text-tertiary transition-opacity"
      >
        {toggleIcon}
      </button>
    </div>
  );
}
