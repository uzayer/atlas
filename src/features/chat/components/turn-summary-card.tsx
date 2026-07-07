import { memo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Workflow,
  Loader2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ChatMessage, TurnFile } from "@/types/agent";

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
import { CommitFlow } from "./commit-flow";

function buildThreadMarkdown(sessionId: string): string | null {
  const session = useChatStore.getState().sessions[sessionId];
  if (!session) return null;
  const lines: string[] = [`# Agent chat — ${session.title || "Untitled"}`, ""];
  for (const m of session.messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = (m.atlasProse ?? m.content ?? "").trim();
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

  const files = summary?.files ?? [];
  const reads = files.filter((f) => f.kind === "read");
  const edits = files.filter((f) => f.kind === "edit");
  const totalAdded = edits.reduce((s, f) => s + f.added, 0);
  const totalRemoved = edits.reduce((s, f) => s + f.removed, 0);

  if (files.length === 0 && chips.length === 0 && !loadingChips) return null;

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
                <div
                  key={`${f.kind}:${f.path}`}
                  className="flex items-center gap-2 py-0.5 text-[11px]"
                >
                  <FileStatusBadge file={f} />
                  <span className="truncate text-[var(--text-secondary)]">
                    {f.path}
                  </span>
                  {f.kind === "edit" && (f.added > 0 || f.removed > 0) && (
                    <span className="ml-auto shrink-0 font-mono text-[10px]">
                      {f.added > 0 && (
                        <span className="text-[var(--status-success)]">
                          +{f.added}
                        </span>
                      )}
                      {f.removed > 0 && (
                        <span className="ml-1 text-[var(--status-error)]">
                          −{f.removed}
                        </span>
                      )}
                    </span>
                  )}
                </div>
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
      )}

      {/* Turn-level actions */}
      <div className="flex flex-wrap items-center gap-1.5">
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
