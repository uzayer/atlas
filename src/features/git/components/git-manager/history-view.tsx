import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { toast } from "sonner";
import {
  ArrowLeft,
  Copy,
  Undo2,
  GitGraph,
  RotateCcw,
  Tag,
  Check,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useGitStore } from "../../stores/git-store";
import { useReviewStore } from "@/features/review-agents/stores/review-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { DiffView } from "../diff-view";

export function HistoryView() {
  const repoPath = useGitStore.use.repoPath();
  const log = useGitStore.use.log();
  const selected = useGitStore.use.selectedCommit();
  const actions = useGitStore.use.actions();
  const [copied, setCopied] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [tagName, setTagName] = useState("");

  useEffect(() => {
    if (repoPath) void actions.loadLog(repoPath);
  }, [repoPath, actions]);

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      toast.error(String(e));
    }
  };

  // ── Commit detail ──────────────────────────────────────────────
  if (selected) {
    return (
      <div className="h-full flex flex-col">
        <div className="shrink-0 border-b border-border-default">
          <div className="flex items-center gap-2 px-2 h-[30px]">
            <button
              onClick={() => actions.clearSelectedCommit()}
              className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
              title="Back to history"
            >
              <ArrowLeft size={13} />
            </button>
            <span className="font-mono text-[11px] text-text-secondary">{selected.shortHash}</span>
            <div className="ml-auto flex items-center gap-0.5">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(selected.hash).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
                className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
                title="Copy SHA"
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              </button>
              <button
                onClick={() => run(() => actions.cherryPick(selected.hash))}
                className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
                title="Cherry-pick onto current branch"
              >
                <GitGraph size={12} />
              </button>
              <button
                onClick={() => run(() => actions.revert(selected.hash))}
                className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
                title="Revert this commit"
              >
                <Undo2 size={12} />
              </button>
              <ResetMenu onReset={(mode) => run(() => actions.reset(selected.hash, mode))} />
              <button
                onClick={() => {
                  useReviewStore.getState().actions.requestReview("commit", selected.hash);
                  const layout = useLayoutStore.getState();
                  layout.actions.setRightSection("review-agents");
                  if (!layout.rightPanel.visible) layout.actions.toggleRightPanel();
                }}
                className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
                title="Review this commit with AI"
              >
                <ShieldCheck size={12} />
              </button>
              <button
                onClick={() => setTagging((v) => !v)}
                className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
                title="Tag this commit"
              >
                <Tag size={12} />
              </button>
            </div>
          </div>
          {tagging && (
            <div className="px-2 pb-2">
              <input
                value={tagName}
                onChange={(e) => setTagName(e.target.value)}
                autoFocus
                placeholder="tag name → Enter"
                className="w-full h-7 rounded border border-border-default bg-bg-input px-2 text-[11px] font-mono text-text-primary outline-none focus:border-border-focus"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagName.trim()) {
                    void run(() => actions.createTag(tagName.trim(), selected.hash));
                    setTagging(false);
                    setTagName("");
                  } else if (e.key === "Escape") {
                    setTagging(false);
                    setTagName("");
                  }
                }}
              />
            </div>
          )}
          <div className="px-3 pb-2">
            <div className="text-[12px] text-text-primary font-medium">{selected.subject}</div>
            {selected.body && (
              <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[11px] text-text-tertiary">
                {selected.body}
              </pre>
            )}
            <div className="mt-1 text-[10px] text-text-tertiary">
              {selected.author} · {selected.date}
            </div>
          </div>
        </div>
        <DiffView diff={selected.diff} className="flex-1 min-h-0" emptyLabel="No file changes" />
      </div>
    );
  }

  // ── Commit list ────────────────────────────────────────────────
  return (
    <div className="h-full overflow-y-auto hide-scrollbar">
      {log.length === 0 ? (
        <div className="px-3 py-8 text-center text-[11px] text-text-tertiary">No history</div>
      ) : (
        log.map((c) => (
          <button
            key={c.hash}
            onClick={() => void actions.loadCommit(c.hash)}
            className="w-full text-left flex flex-col gap-0.5 px-3 py-1.5 border-b border-border-subtle hover:bg-bg-hover group"
          >
            <span className="text-[11px] text-text-secondary group-hover:text-text-primary truncate">
              {c.message}
            </span>
            <span className="text-[9px] text-text-tertiary font-mono">
              {c.short_hash} · {c.author} · {c.date}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

function ResetMenu({ onReset }: { onReset: (mode: "soft" | "mixed" | "hard") => void }) {
  const [open, setOpen] = useState(false);
  const item = (mode: "soft" | "mixed" | "hard", label: string, desc: string) => (
    <button
      onClick={() => {
        onReset(mode);
        setOpen(false);
      }}
      className="w-full text-left px-3 py-1.5 hover:bg-bg-hover"
    >
      <div className="text-[11px] text-text-primary">{label}</div>
      <div className="text-[9px] text-text-tertiary">{desc}</div>
    </button>
  );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className={cn("p-1 rounded hover:bg-bg-hover", open ? "text-text-primary" : "text-text-tertiary hover:text-text-primary")}
          title="Reset current branch to this commit"
        >
          <RotateCcw size={12} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={4}
          className="w-[200px] rounded-lg border border-border-default bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)] py-1"
          style={{ zIndex: 99999 }}
        >
          <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-text-tertiary">
            Reset to here
          </div>
          {item("soft", "Soft", "keep changes staged")}
          {item("mixed", "Mixed", "keep changes unstaged")}
          {item("hard", "Hard", "discard all changes")}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
