import { useState, memo } from "react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types/agent";
import {
  User,
  Sparkles,
  CheckCircle2,
  XCircle,
  Loader2,
  FileCode,
  Copy,
  Check,
  CornerUpLeft,
  Bookmark,
  Brain,
  ChevronRight,
  Paperclip,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { CachedMarkdown } from "@/lib/markdown-cache";

const FILE_PATH_KEYS = ["file_path", "path", "filename", "filePath"];

// User prompts composed via the @-mention picker carry a heavy
// "Atlas context" suffix. The split + block count are computed ONCE
// when the message is inserted into the chat-store (see
// `addMessage` / `replaceMessages` in chat-store.ts) and stored as
// `atlasProse` / `atlasContext` / `atlasContextBlockCount` fields on
// the ChatMessage. MessageItem just reads those — no regex per
// render. The lazy fallback at render time exists only for legacy
// messages saved before this metadata was added.
import {
  splitAtlasContext,
  type SplitContext,
} from "../lib/atlas-context";

function getAtlasSplit(message: ChatMessage): SplitContext {
  if (message.atlasContext !== undefined) {
    return {
      prose: message.atlasProse ?? message.content,
      context: message.atlasContext,
      blockCount: message.atlasContextBlockCount ?? 0,
    };
  }
  // No precomputed metadata. Either it's not a user message with an
  // Atlas-context suffix (cheap early return inside splitAtlasContext)
  // or it's a legacy message we never split. Compute lazily.
  return splitAtlasContext(message.content);
}

function getFilePathFromInput(input: Record<string, unknown>): string | null {
  for (const k of FILE_PATH_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function openFileInEditor(filePath: string) {
  useLayoutStore.getState().actions.addTab({
    id: `editor:${filePath}`,
    type: "editor",
    title: filePath.split("/").pop() ?? filePath,
    closable: true,
    dirty: false,
    data: { filePath },
  });
}

export const MessageItem = memo(function MessageItem({
  message,
  streaming = false,
  dividerAbove = false,
  compact = false,
  isLastInGroup = true,
}: {
  message: ChatMessage;
  streaming?: boolean;
  dividerAbove?: boolean;
  /**
   * When true, suppress the avatar + role/timestamp header so consecutive
   * messages from the same role render as one continuous turn — matches
   * Zed's grouped tool-call view. Also collapses TOP padding so this
   * message hugs the one above it.
   */
  compact?: boolean;
  /**
   * True when this is the final message of a consecutive same-role run.
   * Only the last message in the group renders the Reply/Save/Copy row,
   * and BOTTOM padding stays at the normal `py-6` value to anchor the
   * end of the turn. Middle messages collapse to a tight bottom so the
   * next sub-block (text → tool → text) hugs without visible gaps —
   * fixes the "orange line" inter-block gaps the user flagged.
   */
  isLastInGroup?: boolean;
}) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  // Only user messages carry the @-mention "Atlas context" suffix.
  // `getAtlasSplit` reads from precomputed fields when present (set by
  // chat-store on insert) and falls back to a one-time regex parse
  // for legacy messages — no regex per render in the hot path.
  const { prose, context, blockCount: contextBlockCount } = isUser
    ? getAtlasSplit(message)
    : { prose: message.content, context: null, blockCount: 0 };

  return (
    <div
      className={cn(
        "group px-6",
        // Top padding: tight when this message follows another from
        // the same role (compact), normal otherwise (start of a turn).
        compact ? "pt-1" : "pt-6",
        // Bottom padding: tight unless this is the last of the run —
        // then we anchor with normal spacing so the next user turn
        // doesn't crowd the action row.
        isLastInGroup ? "pb-6" : "pb-1",
        isUser && "bg-[var(--bg-primary)]",
        dividerAbove && "border-t border-dashed border-[var(--border-default)]"
      )}
    >
      <div className="flex gap-4 max-w-[760px] mx-auto">
        {/* Avatar gutter. For grouped (compact) sub-blocks we replace the
            avatar with a thin vertical rail centered in the same column,
            so a multi-block turn reads as one connected unit (Zed-style)
            without shifting the content. */}
        {compact ? (
          <div className="w-8 shrink-0 flex justify-center" aria-hidden>
            <div className="w-px h-full bg-[var(--border-subtle)]" />
          </div>
        ) : (
          <div
            className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5",
              isUser
                ? "bg-[var(--accent-primary-muted)]"
                : "bg-[var(--bg-elevated)] border border-[var(--border-default)]"
            )}
          >
            {isUser ? (
              <User size={14} className="text-[var(--accent-primary)]" />
            ) : (
              <Sparkles size={14} className="text-[var(--text-secondary)]" />
            )}
          </div>
        )}

        {/* Content */}
        <div className="relative flex-1 min-w-0 space-y-3">
          {/* Quick actions — revealed on row hover (Zed/Linear style),
              available on every settled message rather than only the
              last of a group. Floats at the top-right of the content
              column so it never reflows the text. */}
          {!streaming && message.content && (
            <MessageActions message={message} />
          )}
          {!compact && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
                {isUser ? "You" : isAssistant ? "Assistant" : message.role}
              </span>
              <span className="text-[10px] text-[var(--text-tertiary)] font-mono">
                {new Date(message.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          )}

          {/* Thinking indicator: streaming + nothing emitted yet (no text, no
              tool calls, no thoughts) */}
          {streaming &&
            !message.content &&
            message.toolCalls.length === 0 &&
            !message.thinking && (
              <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--text-secondary)]">
                <Loader2 size={13} className="animate-spin text-[var(--accent-primary)]" />
                <span>Working…</span>
              </div>
            )}

          {/* Thinking accordion — collapsible, default closed once stream
              settles; auto-open while actively streaming so the user sees
              progress. */}
          {message.mode === "thinking" && message.thinking && (
            <ThinkingAccordion thinking={message.thinking} streaming={streaming} />
          )}

          {/* Markdown text — render plain pre while streaming for speed; markdown once settled */}
          {prose && streaming ? (
            <pre className="text-sm text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap break-words select-text font-sans">
              {prose}
              {/* Blinking caret so a live turn reads like a terminal
                  cursor — the clearest "this is generating now" cue. */}
              <span className="atlas-stream-caret" aria-hidden />
            </pre>
          ) : null}
          {prose && !streaming && (
            <CachedMarkdown source={prose} className="text-sm" />
          )}

          {/* Heavy @-mention bodies (files / folders / repo READMEs / notes /
              papers) collapsed by default so the thread stays scannable. */}
          {context && (
            <AtlasContextAccordion
              context={context}
              blockCount={contextBlockCount}
            />
          )}

          {/* Tool calls */}
          {message.toolCalls.length > 0 && (
            <div className="space-y-1.5">
              {message.toolCalls.map((tc) => (
                <ToolCallCard key={tc.id} toolCall={tc} />
              ))}
            </div>
          )}

          {/* File changes */}
          {message.fileChanges.length > 0 && (
            <div className="space-y-1">
              {message.fileChanges.map((fc) => (
                <FileChangeCard key={fc.path} change={fc} />
              ))}
            </div>
          )}

          {/* Plan */}
          {message.plan && message.plan.length > 0 && (
            <PlanCard steps={message.plan} />
          )}

        </div>
      </div>
    </div>
  );
});

function MessageActions({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleReply = () => {
    window.dispatchEvent(
      new CustomEvent("atlas:chat-reply", { detail: { content: message.content } })
    );
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  const handleSave = async () => {
    const project = useProjectStore.getState().currentProject;
    if (!project) {
      toast.error("No project open");
      return;
    }
    const id = `chat/${new Date().toISOString().replace(/[:.]/g, "-")}-${message.role}`;
    const md = [
      `# ${message.role === "user" ? "Question" : "Answer"} · ${new Date(
        message.timestamp
      ).toLocaleString()}`,
      "",
      message.content,
    ].join("\n");
    try {
      await invoke("save_knowledge_note", {
        projectPath: project.path,
        id,
        content: md,
      });
      setSaved(true);
      toast.success("Saved to knowledge base");
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div
      className={cn(
        "absolute right-0 -top-1 z-10 flex items-center gap-0.5 rounded-md",
        "border border-[var(--border-default)] bg-[var(--bg-elevated)] p-0.5",
        "shadow-[var(--shadow-sm)]",
        // Hidden until the message row is hovered (the `.group` wrapper
        // lives on MessageItem). Fade only — no layout shift.
        "opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100",
      )}
    >
      <ActionButton onClick={handleCopy} title="Copy markdown">
        {copied ? (
          <Check size={12} className="text-[var(--text-primary)] animate-scale-in" />
        ) : (
          <Copy size={12} />
        )}
      </ActionButton>
      <ActionButton onClick={handleReply} title="Reply with this as reference">
        <CornerUpLeft size={12} />
      </ActionButton>
      <ActionButton onClick={handleSave} title="Save to knowledge base">
        {saved ? (
          <Check size={12} className="text-[var(--text-primary)] animate-scale-in" />
        ) : (
          <Bookmark size={12} />
        )}
      </ActionButton>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer transition-colors"
    >
      {children}
    </button>
  );
}

const AtlasContextAccordion = memo(function AtlasContextAccordion({
  context,
  blockCount,
}: {
  context: string;
  blockCount: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="group rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)]"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={12}
          className={cn(
            "transition-transform text-[var(--text-tertiary)]",
            open && "rotate-90"
          )}
        />
        <Paperclip size={12} className="text-[var(--text-tertiary)]" />
        <span className="font-mono">
          Atlas context
          {blockCount > 0 && (
            <span className="text-[var(--text-tertiary)]"> · {blockCount}</span>
          )}
        </span>
      </summary>
      <div className="border-t border-[var(--border-default)] px-3 py-2">
        <CachedMarkdown
          source={context}
          className="text-[12px] text-[var(--text-tertiary)]"
        />
      </div>
    </details>
  );
});

const ThinkingAccordion = memo(function ThinkingAccordion({
  thinking,
  streaming,
}: {
  thinking: string;
  streaming: boolean;
}) {
  // Auto-open while streaming so the live thought shows; collapse by default
  // once the message is settled. Uses native <details> for zero-dep
  // semantics + a11y; styled to match the AMOLED palette.
  const [open, setOpen] = useState(streaming);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="group rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)]"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={12}
          className={cn(
            "transition-transform text-[var(--text-tertiary)]",
            open && "rotate-90"
          )}
        />
        {streaming ? (
          <Loader2 size={12} className="animate-spin text-[var(--accent-primary)]" />
        ) : (
          <Brain size={12} className="text-[var(--text-tertiary)]" />
        )}
        <span className="font-mono">
          {streaming ? "Thinking…" : "Thought process"}
        </span>
      </summary>
      <div className="border-t border-[var(--border-default)] px-3 py-2">
        <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-[var(--text-tertiary)] select-text">
          {thinking}
        </pre>
      </div>
    </details>
  );
});

const ToolCallCard = memo(function ToolCallCard({
  toolCall,
}: {
  toolCall: ChatMessage["toolCalls"][number];
}) {
  const [copied, setCopied] = useState(false);

  const args = toolCall.arguments as Record<string, unknown>;
  const isBash = toolCall.toolName.toLowerCase() === "bash";
  const filePath = getFilePathFromInput(args);

  // Status icon — check for success, cross for failure, spinner while running.
  const isRunning =
    toolCall.status === "running" || toolCall.status === "pending";
  const statusLabel =
    toolCall.status === "failed" ? "Failed" : isRunning ? "Running" : "Done";
  const statusIcon =
    toolCall.status === "failed" ? (
      <XCircle size={12} className="text-[var(--status-error)]" />
    ) : isRunning ? (
      <Loader2 size={12} className="animate-spin text-[var(--accent-primary)]" />
    ) : (
      <CheckCircle2 size={12} className="text-[var(--status-success)]" />
    );

  // Title text — for Bash, show the command directly; for other tools, show "<Tool> <path|pattern|args>".
  let title: string;
  if (isBash) {
    title =
      (args.command as string) ??
      (args.cmd as string) ??
      toolCall.toolName;
  } else if (filePath) {
    title = `${toolCall.toolName} ${filePath}`;
  } else if (typeof args.pattern === "string") {
    title = `${toolCall.toolName} ${args.pattern}`;
  } else {
    title = toolCall.toolName;
  }

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const payload = isBash
      ? `${(args.command as string) ?? ""}${toolCall.result ? `\n\n${toolCall.result}` : ""}`
      : `${toolCall.toolName} ${JSON.stringify(args)}${toolCall.result ? `\n\n${toolCall.result}` : ""}`;
    try {
      await navigator.clipboard.writeText(payload);
      toast.success("Copied", { duration: 1200 });
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const handleRowClick = () => {
    if (filePath) openFileInEditor(filePath);
  };

  const showError = toolCall.status === "failed" && toolCall.result;

  return (
    <div
      className={cn(
        // A status-tinted left edge (Zed-style run block): accent while
        // running, error red on failure, quiet otherwise.
        "rounded-md border border-l-2 bg-[var(--bg-secondary)] overflow-hidden",
        toolCall.status === "failed"
          ? "border-[var(--status-error)]/40 border-l-[var(--status-error)]"
          : isRunning
            ? "border-[var(--border-default)] border-l-[var(--accent-primary)]"
            : "border-[var(--border-default)] border-l-[var(--border-strong)]"
      )}
    >
      <div
        onClick={handleRowClick}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5",
          filePath && "cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
        )}
      >
        <span className="shrink-0" title={statusLabel} aria-label={statusLabel}>
          {statusIcon}
        </span>
        <span className="text-[11px] font-mono text-[var(--text-secondary)] flex-1 min-w-0 truncate">
          {title}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer transition-colors shrink-0"
          title="Copy Command + Output"
        >
          {copied ? (
            <Check size={11} className="text-[var(--text-primary)] animate-scale-in" />
          ) : (
            <Copy size={11} />
          )}
        </button>
      </div>
      {showError && (
        <div className="border-t border-[var(--status-error)]/30 bg-[var(--status-error)]/5 px-3 py-1.5">
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-[var(--status-error)] select-text">
            {toolCall.result}
          </pre>
        </div>
      )}
    </div>
  );
});

const FileChangeCard = memo(function FileChangeCard({
  change,
}: {
  change: ChatMessage["fileChanges"][number];
}) {
  const statusColors = {
    added: "text-[var(--diff-added-text)]",
    modified: "text-[var(--status-warning)]",
    deleted: "text-[var(--diff-removed-text)]",
  };

  return (
    <button
      onClick={() => openFileInEditor(change.path)}
      className="w-full flex items-center gap-2 px-3 h-[28px] rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] cursor-pointer transition-colors"
      title={`Open ${change.path}`}
    >
      <FileCode size={12} className={statusColors[change.status]} />
      <span className="text-[11px] font-mono text-[var(--text-secondary)] flex-1 truncate text-left">
        {change.path}
      </span>
      {change.additions > 0 && (
        <span className="text-[10px] font-mono text-[var(--diff-added-text)]">
          +{change.additions}
        </span>
      )}
      {change.deletions > 0 && (
        <span className="text-[10px] font-mono text-[var(--diff-removed-text)]">
          -{change.deletions}
        </span>
      )}
    </button>
  );
});

const PlanCard = memo(function PlanCard({
  steps,
}: {
  steps: ChatMessage["plan"];
}) {
  if (!steps) return null;
  const completed = steps.filter((s) => s.status === "completed").length;

  return (
    <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 space-y-1.5">
      <div className="text-[10px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">
        Plan {completed}/{steps.length}
      </div>
      {steps.map((step) => (
        <div key={step.id} className="flex items-start gap-2">
          <span className="mt-0.5">
            {step.status === "completed" ? (
              <CheckCircle2 size={12} className="text-[var(--status-success)]" />
            ) : step.status === "in_progress" ? (
              <Loader2 size={12} className="animate-spin text-[var(--accent-primary)]" />
            ) : (
              <div className="w-3 h-3 rounded-full border border-[var(--border-strong)]" />
            )}
          </span>
          <span
            className={cn(
              "text-[11px]",
              step.status === "completed"
                ? "text-[var(--text-tertiary)] line-through"
                : "text-[var(--text-secondary)]"
            )}
          >
            {step.description}
          </span>
        </div>
      ))}
    </div>
  );
});
