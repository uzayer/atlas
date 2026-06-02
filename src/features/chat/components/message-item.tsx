import { useState, memo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
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
  Maximize2,
  X,
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
  model,
  timeGapAbove,
}: {
  message: ChatMessage;
  streaming?: boolean;
  dividerAbove?: boolean;
  /** Session model (e.g. "claude-opus-4-7") — shown as a subtle badge on
   *  the assistant turn header so multi-model sessions are legible. */
  model?: string | null;
  /** When set (e.g. "2h"), render a faint time-gap divider above this
   *  message to mark a real pause between turns. */
  timeGapAbove?: string | null;
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
      {/* Time-gap divider — marks a real pause between turns (iMessage
          style) so a thread reads in sessions, not one endless scroll. */}
      {timeGapAbove && (
        <div className="flex items-center gap-2 max-w-[760px] mx-auto mb-4 text-[9px] uppercase tracking-wider text-[var(--text-tertiary)] select-none">
          <span className="h-px flex-1 bg-[var(--border-subtle)]" />
          <span>{timeGapAbove} ago</span>
          <span className="h-px flex-1 bg-[var(--border-subtle)]" />
        </div>
      )}
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

        {/* Content. The actions cluster is rendered OUTSIDE the
            `space-y-3` stack (as a sibling of it) — otherwise it counts
            as the first space-y child and pushes a 12px top margin onto
            the real first block of every message. */}
        <div className="relative flex-1 min-w-0">
          {/* Quick actions — revealed on row hover (Zed/Linear style),
              available on every settled message rather than only the
              last of a group. Floats at the top-right of the content
              column so it never reflows the text. */}
          {!streaming && message.content && (
            <MessageActions message={message} />
          )}
          <div className="space-y-3">
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
              {isAssistant && model && (
                <span
                  className="ml-auto shrink-0 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] px-1.5 py-px text-[9px] font-mono text-[var(--text-tertiary)]"
                  title={`Model: ${model}`}
                >
                  {model}
                </span>
              )}
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

// ── Edit-diff extraction ─────────────────────────────────────────────
// Agent file edits arrive as tool arguments (Claude Code: Edit →
// old_string/new_string, Write → content, MultiEdit → edits[]). We render
// the diff straight from those args — no file read, no backend.
const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "create_file",
  "create",
  "str_replace",
  "str_replace_editor",
  "apply_patch",
]);

interface EditPart {
  old: string;
  neu: string;
}

const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

function getEditParts(toolName: string, args: Record<string, unknown>): EditPart[] {
  const parts: EditPart[] = [];
  const edits = args.edits;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (e && typeof e === "object") {
        const o = e as Record<string, unknown>;
        const old = asStr(o.old_string) ?? asStr(o.oldString) ?? asStr(o.old_str) ?? "";
        const neu = asStr(o.new_string) ?? asStr(o.newString) ?? asStr(o.new_str) ?? "";
        if (old || neu) parts.push({ old, neu });
      }
    }
    if (parts.length) return parts;
  }
  const old = asStr(args.old_string) ?? asStr(args.oldString) ?? asStr(args.old_str);
  const neu = asStr(args.new_string) ?? asStr(args.newString) ?? asStr(args.new_str);
  if (old != null || neu != null) return [{ old: old ?? "", neu: neu ?? "" }];
  // Whole-file write/create — only when the tool is actually an editor.
  if (EDIT_TOOLS.has(toolName.toLowerCase())) {
    const content =
      asStr(args.content) ?? asStr(args.new_content) ?? asStr(args.text) ?? asStr(args.file_text);
    if (content != null) return [{ old: "", neu: content }];
  }
  return parts;
}

interface DiffRow {
  type: "context" | "add" | "remove";
  text: string;
}

const DIFF_CONTEXT = 2;

// Trim common leading/trailing lines so the diff shows the change plus a
// little context, not the whole quoted block.
function diffRows(oldStr: string, neu: string): DiffRow[] {
  const o = oldStr.split("\n");
  const n = neu.split("\n");
  let start = 0;
  while (start < o.length && start < n.length && o[start] === n[start]) start++;
  let eo = o.length;
  let en = n.length;
  while (eo > start && en > start && o[eo - 1] === n[en - 1]) {
    eo--;
    en--;
  }
  const rows: DiffRow[] = [];
  for (const t of o.slice(Math.max(start - DIFF_CONTEXT, 0), start))
    rows.push({ type: "context", text: t });
  for (let i = start; i < eo; i++) rows.push({ type: "remove", text: o[i] });
  for (let i = start; i < en; i++) rows.push({ type: "add", text: n[i] });
  for (const t of o.slice(eo, Math.min(eo + DIFF_CONTEXT, o.length)))
    rows.push({ type: "context", text: t });
  return rows;
}

function EditDiffView({ parts }: { parts: EditPart[] }) {
  return (
    <div className="border-t border-[var(--border-default)] max-h-[320px] overflow-auto hide-scrollbar">
      {parts.map((p, i) => (
        <div key={i}>
          {parts.length > 1 && (
            <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-[var(--text-tertiary)] bg-[var(--bg-base)] sticky top-0">
              Edit {i + 1}
            </div>
          )}
          {diffRows(p.old, p.neu).map((r, j) => (
            <div
              key={j}
              className={cn(
                "flex font-mono text-[11px] leading-[18px]",
                r.type === "add" && "bg-[#0d2211]",
                r.type === "remove" && "bg-[#220d0d]",
                r.type === "context" && "text-[var(--text-tertiary)]",
              )}
            >
              <span className="w-4 shrink-0 text-center select-none text-[var(--text-tertiary)]">
                {r.type === "add" ? "+" : r.type === "remove" ? "−" : ""}
              </span>
              <span className="flex-1 whitespace-pre-wrap break-words pr-2 select-text">
                {r.text || " "}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ToolOutputDialog({
  open,
  onOpenChange,
  title,
  result,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  result: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[80vh] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-md",
            "border border-border-default bg-bg-elevated shadow-[var(--shadow-overlay)] animate-scale-in",
          )}
        >
          <div className="flex items-center gap-2 border-b border-border-default px-4 py-2.5">
            <Dialog.Title className="flex-1 min-w-0 truncate font-mono text-[12px] text-text-secondary">
              {title}
            </Dialog.Title>
            <Dialog.Close
              className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
              aria-label="Close"
            >
              <X size={13} />
            </Dialog.Close>
          </div>
          <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11px] leading-snug text-text-secondary select-text">
            {result}
          </pre>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const ToolCallCard = memo(function ToolCallCard({
  toolCall,
}: {
  toolCall: ChatMessage["toolCalls"][number];
}) {
  const [copied, setCopied] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);

  const args = toolCall.arguments as Record<string, unknown>;
  const isBash = toolCall.toolName.toLowerCase() === "bash";
  const filePath = getFilePathFromInput(args);
  const editParts = getEditParts(toolCall.toolName, args);
  const hasDiff = editParts.length > 0;
  const hasOutput = !!toolCall.result && toolCall.result.trim().length > 0;

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
        {hasDiff && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setDiffOpen((v) => !v);
            }}
            className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer transition-colors shrink-0"
            title={diffOpen ? "Hide diff" : "Show diff"}
          >
            <ChevronRight
              size={13}
              className={cn("transition-transform", diffOpen && "rotate-90")}
            />
          </button>
        )}
        {hasOutput && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOutputOpen(true);
            }}
            className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer transition-colors shrink-0"
            title="View output"
          >
            <Maximize2 size={11} />
          </button>
        )}
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
      {/* Inline diff — expands in the thread (the virtualizer re-measures
          the row, so it stays correctly positioned). Bounded height so a
          huge edit can't blow the row up. */}
      {hasDiff && diffOpen && <EditDiffView parts={editParts} />}
      {showError && (
        <div className="border-t border-[var(--status-error)]/30 bg-[var(--status-error)]/5 px-3 py-1.5">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-[var(--status-error)] select-text">
            {toolCall.result}
          </pre>
        </div>
      )}
      {hasOutput && (
        <ToolOutputDialog
          open={outputOpen}
          onOpenChange={setOutputOpen}
          title={title}
          result={toolCall.result ?? ""}
        />
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
