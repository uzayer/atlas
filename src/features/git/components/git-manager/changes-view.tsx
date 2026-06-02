import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Plus,
  Minus,
  Undo2,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useGitStore, type GitFileStatus } from "../../stores/git-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { DiffView } from "../diff-view";

function statusBadge(status: string): { letter: string; cls: string } {
  const s = status.toLowerCase();
  if (s.includes("delet")) return { letter: "D", cls: "text-error" };
  if (s.includes("add") || s.includes("new") || s.includes("untrack"))
    return { letter: "A", cls: "text-success" };
  if (s.includes("renam")) return { letter: "R", cls: "text-[var(--status-info)]" };
  if (s.includes("conflict") || s.includes("unmerg"))
    return { letter: "!", cls: "text-error" };
  return { letter: "M", cls: "text-[var(--status-warning)]" };
}

function FileRow({
  file,
  selected,
  onSelect,
  action,
  onAction,
  onDiscard,
}: {
  file: GitFileStatus;
  selected: boolean;
  onSelect: () => void;
  action: "stage" | "unstage";
  onAction: () => void;
  onDiscard?: () => void;
}) {
  const badge = statusBadge(file.status);
  const name = file.path.split("/").pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - name.length);
  return (
    <div
      onClick={onSelect}
      className={cn(
        "group flex items-center gap-1.5 h-[24px] px-2 cursor-pointer text-[11px]",
        selected ? "bg-bg-selected" : "hover:bg-bg-hover",
      )}
    >
      <span className={cn("shrink-0 w-3 text-center font-mono text-[10px] font-semibold", badge.cls)}>
        {badge.letter}
      </span>
      <span className="truncate flex-1 min-w-0 font-mono">
        {dir && <span className="text-text-tertiary">{dir}</span>}
        <span className="text-text-secondary group-hover:text-text-primary">{name}</span>
      </span>
      <div className="flex items-center opacity-0 group-hover:opacity-100 shrink-0">
        {onDiscard && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDiscard();
            }}
            className="p-0.5 rounded text-text-tertiary hover:text-[var(--status-error)]"
            title="Discard changes"
          >
            <Undo2 size={11} />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAction();
          }}
          className="p-0.5 rounded text-text-tertiary hover:text-text-primary"
          title={action === "stage" ? "Stage" : "Unstage"}
        >
          {action === "stage" ? <Plus size={12} /> : <Minus size={12} />}
        </button>
      </div>
    </div>
  );
}

export function ChangesView() {
  const files = useGitStore.use.files();
  const diff = useGitStore.use.diff();
  const inProgress = useGitStore.use.inProgress();
  const repoPath = useGitStore.use.repoPath();
  const actions = useGitStore.use.actions();
  const { addTab } = useLayoutStore.use.actions();
  const currentProject = useProjectStore.use.currentProject();

  const [selected, setSelected] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [showDesc, setShowDesc] = useState(false);

  const staged = useMemo(() => files.filter((f) => f.staged), [files]);
  const unstaged = useMemo(() => files.filter((f) => !f.staged), [files]);

  // Load the selected file's diff (falls back to the full working diff).
  useEffect(() => {
    if (!selected || !repoPath) {
      setFileDiff(null);
      return;
    }
    let cancelled = false;
    void invoke<string>("git_diff_file", { path: repoPath, file: selected })
      .then((d) => {
        if (!cancelled) setFileDiff(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selected, repoPath, files]);

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const doCommit = () =>
    run(async () => {
      if (!summary.trim()) return;
      await actions.commit(summary.trim(), description.trim() || undefined, amend);
      setSummary("");
      setDescription("");
      setAmend(false);
      setShowDesc(false);
    });

  const openFile = (p: string) => {
    if (!currentProject) return;
    const full = `${currentProject.path}/${p}`;
    addTab({ id: `editor-${full}`, type: "editor", title: p.split("/").pop() ?? p, closable: true, dirty: false, data: { filePath: full } });
  };

  const inProgressLabel = inProgress
    ? inProgress.merge
      ? "merge"
      : inProgress.rebase
        ? "rebase"
        : inProgress.cherryPick
          ? "cherry-pick"
          : "revert"
    : null;
  const opKind: "merge" | "rebase" | "cherry-pick" | "revert" =
    inProgress?.merge
      ? "merge"
      : inProgress?.rebase
        ? "rebase"
        : inProgress?.cherryPick
          ? "cherry-pick"
          : "revert";

  const canCommit = (staged.length > 0 || amend) && summary.trim().length > 0;

  return (
    <div className="h-full flex flex-col">
      {inProgressLabel && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 text-[11px]">
          <AlertTriangle size={12} className="text-[var(--status-warning)] shrink-0" />
          <span className="flex-1 text-text-secondary">
            Resolving <span className="font-medium text-text-primary">{inProgressLabel}</span>
          </span>
          <button
            onClick={() => run(() => actions.opControl(opKind, "continue"))}
            className="px-2 h-6 rounded text-[10px] font-medium bg-[var(--accent-primary)] text-[var(--bg-base)] hover:bg-[var(--accent-primary-hover)]"
          >
            Continue
          </button>
          <button
            onClick={() => run(() => actions.opControl(opKind, "abort"))}
            className="px-2 h-6 rounded text-[10px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          >
            Abort
          </button>
        </div>
      )}

      {/* File lists — bounded so the diff region below gets room. */}
      <div className="shrink-0 max-h-[45%] overflow-y-auto hide-scrollbar border-b border-border-default">
        {/* Staged */}
        {staged.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-2 h-[24px] sticky top-0 bg-[var(--bg-sidebar)] border-b border-border-subtle">
              <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
                Staged ({staged.length})
              </span>
              <button
                onClick={() => run(() => actions.unstageFiles(staged.map((f) => f.path)))}
                className="text-[10px] text-text-tertiary hover:text-text-primary"
              >
                Unstage all
              </button>
            </div>
            {staged.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                selected={selected === f.path}
                onSelect={() => setSelected(f.path)}
                action="unstage"
                onAction={() => run(() => actions.unstageFiles([f.path]))}
              />
            ))}
          </div>
        )}

        {/* Unstaged */}
        <div>
          <div className="flex items-center justify-between px-2 h-[24px] sticky top-0 bg-[var(--bg-sidebar)] border-b border-border-subtle">
            <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
              Changes ({unstaged.length})
            </span>
            {unstaged.length > 0 && (
              <button
                onClick={() => run(() => actions.stageFiles(unstaged.map((f) => f.path)))}
                className="text-[10px] text-text-tertiary hover:text-text-primary"
              >
                Stage all
              </button>
            )}
          </div>
          {unstaged.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              selected={selected === f.path}
              onSelect={() => setSelected(f.path)}
              action="stage"
              onAction={() => run(() => actions.stageFiles([f.path]))}
              onDiscard={() => run(() => actions.discard([f.path]))}
            />
          ))}
          {files.length === 0 && (
            <div className="px-3 py-6 text-center text-[11px] text-text-tertiary">
              No changes — working tree clean
            </div>
          )}
        </div>
      </div>

      {/* Diff of the selected file (or the full working diff, with the
          changed-file filter/sort/language header). */}
      <DiffView
        diff={fileDiff ?? diff}
        onOpenFile={openFile}
        onRefresh={() => run(() => actions.loadDiff())}
        filters={!selected}
        emptyLabel={selected ? "No diff for this file" : "No changes"}
        className="flex-1"
      />

      {/* Commit form */}
      <div className="shrink-0 border-t border-border-default p-2 space-y-1.5">
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder={amend ? "Amend commit message" : "Summary (required)"}
          className="w-full h-7 rounded-md border border-border-default bg-bg-input px-2 text-[11px] text-text-primary outline-none focus:border-border-focus"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) doCommit();
          }}
        />
        {showDesc ? (
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={3}
            className="w-full rounded-md border border-border-default bg-bg-input px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-border-focus resize-none"
          />
        ) : (
          <button
            onClick={() => setShowDesc(true)}
            className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary"
          >
            <ChevronDown size={10} /> Add description
          </button>
        )}
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10px] text-text-tertiary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={amend}
              onChange={(e) => setAmend(e.target.checked)}
              className="accent-[var(--accent-primary)]"
            />
            Amend last commit
          </label>
          <button
            onClick={doCommit}
            disabled={!canCommit}
            className={cn(
              "ml-auto px-3 h-7 rounded-md text-[11px] font-medium transition-colors",
              canCommit
                ? "bg-[var(--accent-primary)] text-[var(--bg-base)] hover:bg-[var(--accent-primary-hover)]"
                : "bg-bg-elevated text-text-tertiary cursor-not-allowed",
            )}
          >
            {amend ? "Amend" : "Commit"}
          </button>
        </div>
      </div>
    </div>
  );
}
