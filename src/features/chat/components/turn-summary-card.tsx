import { memo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Workflow,
  Loader2,
  Sparkles,
  Gauge,
  Clock,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { openFile } from "@/lib/open-file";
import { openGitDiff } from "@/features/git/lib/git-diff-api";
import { useGitStore, type GitFileStatus } from "@/features/git/stores/git-store";
import type { ChatMessage, TurnFile } from "@/types/agent";

/** Compact token count: 1.2k / 42.1k / 1.0M. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

/** "Jul 8, 2:58 PM" — the turn's timestamp, shown in the card's left slot when
 *  there's no token/context data to display there. Empty on an invalid date. */
function fmtTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Git-standard status letter for a turn file: A(dded) / M(odified) / R(ead). */
function FileStatusBadge({ file }: { file: TurnFile }) {
  let letter = "R";
  let color = "text-[var(--text-tertiary)]";
  if (file.kind === "edit") {
    if (file.created) {
      letter = "A";
      color = "text-[var(--status-success)]";
    } else {
      letter = "M";
      color = "text-[#e0af68]";
    }
  }
  return (
    <span
      className={cn(
        "w-3 shrink-0 text-center font-mono text-[10px] font-semibold",
        color,
      )}
    >
      {letter}
    </span>
  );
}
import { useChatStore } from "../stores/chat-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useCanvasAiStore } from "@/features/canvas/stores/canvas-ai-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { resolveByok } from "../lib/byok-resolve";
import { stripNextSteps } from "../lib/next-steps";
import { CommitFlow } from "./commit-flow";

function buildThreadMarkdown(sessionId: string): string | null {
  const session = useChatStore.getState().sessions[sessionId];
  if (!session) return null;
  const lines: string[] = [`# Agent chat — ${session.title || "Untitled"}`, ""];
  for (const m of session.messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = stripNextSteps(m.atlasProse ?? m.content ?? "").trim();
    if (!text) continue;
    lines.push(`## ${m.role === "user" ? "User" : "Assistant"}`, "", text, "");
  }
  return lines.length > 2 ? lines.join("\n") : null;
}

/**
 * Adaptive per-turn footer, attached to the trailing assistant message of a
 * completed turn (see `chat-store.ts` turn_finished freeze). Surfaces what the
 * turn touched, what to do next, and turn-level actions. Never rendered
 * mid-stream (gated on `!streaming` + `turnSummary` only lands at turn end).
 */
export const TurnSummaryCard = memo(function TurnSummaryCard({
  message,
  tabId,
}: {
  message: ChatMessage;
  tabId: string;
}) {
  const summary = message.turnSummary;
  const chips = message.suggestions?.chips ?? [];
  const loadingChips = message.suggestions?.status === "loading";
  const [filesOpen, setFilesOpen] = useState(false);
  const repoPath = useGitStore.use.repoPath();
  const gitFiles = useGitStore.use.files();

  const files = summary?.files ?? [];
  const reads = files.filter((f) => f.kind === "read");
  const edits = files.filter((f) => f.kind === "edit");
  const totalAdded = edits.reduce((s, f) => s + f.added, 0);
  const totalRemoved = edits.reduce((s, f) => s + f.removed, 0);

  const ctx = message.contextUsage;
  if (files.length === 0 && chips.length === 0 && !loadingChips && !ctx)
    return null;

  const saveToKb = async () => {
    const project = useProjectStore.getState().currentProject;
    if (!project) {
      toast.error("No project open");
      return;
    }
    const md = buildThreadMarkdown(tabId);
    if (!md) {
      toast.error("Nothing to save yet");
      return;
    }
    const id = `chat/${new Date().toISOString().replace(/[:.]/g, "-")}-thread`;
    try {
      await invoke("save_knowledge_note", {
        projectPath: project.path,
        id,
        content: md,
      });
      toast.success("Thread saved to knowledge base");
    } catch (e) {
      toast.error(`Failed to save: ${e}`);
    }
  };

  const drawDiagram = () => {
    const byok = resolveByok();
    if (!byok) {
      toast.error("Pick a BYOK model in the composer first to draw diagrams");
      return;
    }
    const projectPath =
      useProjectStore.getState().currentProject?.path ?? "/";
    const editedPaths = edits.map((f) => f.path);
    const prompt = [
      "Draw a clear architecture/flow diagram of the changes just made" +
        (editedPaths.length ? " to these files:" : ":"),
      ...editedPaths.map((p) => `- ${p}`),
      "",
      message.content.slice(0, 2000),
    ].join("\n");

    const canvas = useCanvasStore.getState().actions;
    canvas.createPage();
    const anchor = { x: 0, y: 0 };
    const groupId = canvas.createAiGroup(anchor, byok.provider, byok.model);
    void useCanvasAiStore
      .getState()
      .actions.generate({
        groupId,
        anchor,
        prompt,
        provider: byok.provider,
        model: byok.model,
        projectPath,
      });
    // Reveal the Spaces tab so the user watches it draw.
    const layout = useLayoutStore.getState().actions;
    layout.addTab({
      id: "canvas",
      type: "canvas",
      title: "Spaces",
      closable: true,
      dirty: false,
      data: {},
    });
    layout.setActiveTab("canvas");
    toast.success("Drawing a diagram in Spaces…");
  };

  const canDiagram = edits.length > 0 && resolveByok() !== null;

  return (
    <div className="mt-2 space-y-2">
      {files.length > 0 && (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]">
          <button
            type="button"
            onClick={() => setFilesOpen((o) => !o)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
          >
            {filesOpen ? (
              <ChevronDown size={12} className="text-[var(--text-tertiary)]" />
            ) : (
              <ChevronRight size={12} className="text-[var(--text-tertiary)]" />
            )}
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">
              {edits.length > 0 && `${edits.length} modified`}
              {edits.length > 0 && reads.length > 0 && " · "}
              {reads.length > 0 && `${reads.length} read`}
            </span>
            {(totalAdded > 0 || totalRemoved > 0) && (
              <span className="ml-auto font-mono text-[10px]">
                {totalAdded > 0 && (
                  <span className="text-[var(--status-success)]">
                    +{totalAdded}
                  </span>
                )}
                {totalRemoved > 0 && (
                  <span className="ml-1 text-[var(--status-error)]">
                    −{totalRemoved}
                  </span>
                )}
              </span>
            )}
          </button>
          {filesOpen && (
            <div className="border-t border-[var(--border-default)] px-3 py-1.5">
              {files.map((f) => (
                <FileRow
                  key={`${f.kind}:${f.path}`}
                  file={f}
                  repoPath={repoPath}
                  gitFiles={gitFiles}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {loadingChips && chips.length === 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
          <Loader2 size={11} className="animate-spin" />
          Thinking of next steps…
        </div>
      )}

      {chips.length > 0 && (
        <div className="space-y-1 py-3">
          <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
            <Sparkles size={10} className="text-[var(--accent-primary)]" />
            Suggestions
          </div>
          <div className="flex flex-wrap gap-1.5">
            {chips.map((chip, i) => (
            <button
              key={i}
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("atlas:chat-send", { detail: { text: chip } }),
                )
              }
              className={cn(
                "group flex items-center gap-1.5 rounded-full border border-[var(--border-default)]",
                "bg-[var(--bg-secondary)] px-3 py-1 text-[11px] text-[var(--text-secondary)]",
                "transition-colors hover:border-[var(--border-focus)] hover:text-[var(--text-primary)]",
              )}
            >
              <span className="max-w-[280px] truncate">{chip}</span>
              <ArrowRight
                size={11}
                className="shrink-0 text-[var(--text-tertiary)] group-hover:text-[var(--accent-primary)]"
              />
            </button>
            ))}
          </div>
        </div>
      )}

      {/* Turn-level actions. Divider color matches the message's left rail
          (`--border-subtle`); it bleeds left (`-ml-8`) to meet that rail. */}
      <div className="-ml-8 mt-3 flex flex-wrap items-center justify-end gap-1.5 border-t border-[var(--border-subtle)] pt-3 pl-8">
        {ctx && (ctx.used > 0 || ctx.size > 0) ? (
          <span
            className="mr-auto flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] tabular-nums select-none"
            title={`${ctx.used.toLocaleString()} of ${ctx.size.toLocaleString()} context tokens used${
              ctx.cost > 0 ? ` · est. $${ctx.cost.toFixed(4)}` : ""
            }`}
          >
            <Gauge size={10} className="text-[var(--text-tertiary)]" />
            {fmtTokens(ctx.used)}
            {ctx.size > 0 && ` / ${fmtTokens(ctx.size)}`}
            {ctx.cost > 0 && ` · $${ctx.cost.toFixed(ctx.cost < 1 ? 4 : 2)}`}
          </span>
        ) : (
          // No gauge (ACP) or token data — fall back to the turn timestamp so
          // the left slot is never empty. Native-agent tokens live in the
          // separate UsageFooter above the card, not this slot.
          fmtTimestamp(message.timestamp) && (
            <span className="mr-auto flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] tabular-nums select-none">
              <Clock size={10} className="text-[var(--text-tertiary)]" />
              {fmtTimestamp(message.timestamp)}
            </span>
          )
        )}
        <ActionButton
          icon={
            <span className="inline-block h-2 w-2 rounded-full bg-white" />
          }
          label="Save to KB"
          onClick={saveToKb}
        />
        {canDiagram && (
          <ActionButton
            icon={<Workflow size={12} />}
            label="Draw diagram"
            onClick={drawDiagram}
          />
        )}
        <CommitFlow
          editedPaths={edits.map((f) => f.path)}
          turnText={message.content}
        />
      </div>
    </div>
  );
});

/** One file the turn touched, with per-file open actions revealed on hover
 *  (Zed/Linear style). Reads open in the editor or Finder; edits open in the
 *  git diff when the file is under source control, else the editor / Finder. */
function FileRow({
  file,
  repoPath,
  gitFiles,
}: {
  file: TurnFile;
  repoPath: string | null;
  gitFiles: GitFileStatus[];
}) {
  const isEdit = file.kind === "edit";

  // Resolve the file's path relative to the repo root, then find its git-status
  // entry — an edit is "in source control" only when git actually tracks a
  // change for it (so we can open the correct staged/worktree diff).
  const rel =
    repoPath && file.path.startsWith(repoPath + "/")
      ? file.path.slice(repoPath.length + 1)
      : null;
  const scEntry = rel ? gitFiles.find((g) => g.path === rel) : undefined;
  const inSourceControl = isEdit && !!scEntry && !!repoPath && !!rel;

  const openInEditor = () => {
    void openFile(file.path);
  };
  const openInFinder = async () => {
    try {
      await revealItemInDir(file.path);
    } catch (err) {
      toast.error(
        `Couldn't reveal in Finder: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const openInDiff = () => {
    if (repoPath && rel) openGitDiff(repoPath, rel, scEntry?.staged ?? false, null);
  };

  return (
    <div className="group flex items-center gap-2 py-0.5 text-[11px]">
      <FileStatusBadge file={file} />
      <span className="truncate text-[var(--text-secondary)]">{file.path}</span>

      {/* Actions — hidden until the row is hovered. */}
      <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2 opacity-0 transition-opacity group-hover:opacity-100">
        {inSourceControl ? (
          <FileAction label="Diff" onClick={openInDiff} />
        ) : (
          <FileAction label="Editor" onClick={openInEditor} />
        )}
        <FileAction label="Finder" onClick={openInFinder} />
      </span>

      {isEdit && (file.added > 0 || file.removed > 0) && (
        <span className="shrink-0 font-mono text-[10px]">
          {file.added > 0 && (
            <span className="text-[var(--status-success)]">+{file.added}</span>
          )}
          {file.removed > 0 && (
            <span className="ml-1 text-[var(--status-error)]">−{file.removed}</span>
          )}
        </span>
      )}
    </div>
  );
}

/** A tiny text link used for a per-file open action (underline on hover). */
function FileAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="cursor-pointer text-[10px] text-[var(--text-tertiary)] underline-offset-2 transition-colors hover:text-[var(--text-primary)] hover:underline"
    >
      {label}
    </button>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)]",
        "bg-[var(--bg-elevated)] px-3 py-1.5 text-[11px] font-medium leading-none text-[var(--text-secondary)]",
        "cursor-pointer transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
      )}
    >
      <span className="text-[var(--text-tertiary)]">{icon}</span>
      {label}
    </button>
  );
}
