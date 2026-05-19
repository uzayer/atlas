import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import {
  ArrowUp,
  AtSign,
  Square,
  Pencil,
  X,
} from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { CLAUDE_PERMISSION_MODE_LABEL } from "@/types/agent";
import { ChatInput, type ChatInputHandle } from "./chat-input";
import { MentionPicker, type MentionPickerHandle } from "./mention-picker";
import { useProjectStore } from "@/features/project/stores/project-store";
import type { MentionTrigger } from "../lib/cm-mention-extension";
import type { MentionData } from "../lib/mentions";

// Module-level frozen empty array so selectors that return a "default empty
// queue" hand back a stable reference instead of allocating per render.
const EMPTY_QUEUE: readonly string[] = Object.freeze([]);

interface MessageInputProps {
  tabId: string;
  /**
   * Send a message right now (used when idle, or to dequeue). Receives
   * both the plain prose text and the list of mention records the user
   * inserted — the panel-level handler composes the final wire prompt.
   */
  onSend: (message: string, mentions: MentionData[]) => void;
  /** Stop the current generation. */
  onStop?: () => void;
  /** True while the agent is producing a response. */
  running?: boolean;
  placeholder?: string;
}

export function MessageInput({
  tabId,
  onSend,
  onStop,
  running = false,
  placeholder = "Message Atlas... (@ to mention, / for commands)",
}: MessageInputProps) {
  const {
    cycleClaudePermissionMode,
    enqueueMessage,
    removeQueueItem,
  } = useChatStore.use.actions();
  // Narrow per-tab selectors — primitives only, no message-array refs. This
  // component otherwise would re-render on every streaming chunk because it
  // sits inside the active chat panel.
  const permissionMode = useChatStore(
    (s) => s.sessions[tabId]?.claudePermissionMode ?? "default"
  );
  const queue = useChatStore((s) => s.queues[tabId] ?? EMPTY_QUEUE);

  // The composer's plain-text content is mirrored into local state so the
  // submit button can react to emptiness without round-tripping through
  // CodeMirror on every keystroke. CodeMirror owns the document; this is a
  // shallow shadow for the submit button.
  const [value, setValue] = useState("");
  const inputRef = useRef<ChatInputHandle>(null);

  // ── Mention picker orchestration ──────────────────────────────────────
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const pickerRef = useRef<MentionPickerHandle>(null);
  const triggerRef = useRef<MentionTrigger | null>(null);
  triggerRef.current = trigger;

  const handleMentionSelect = useCallback(
    (mention: MentionData) => {
      const t = triggerRef.current;
      if (!t) return;
      inputRef.current?.insertMention(mention, t.from, t.to);
      // Trigger naturally closes when the doc no longer has an `@…` before
      // the caret; the plugin will fire the null transition for us.
    },
    []
  );

  // Forward Up/Down/Enter/Esc from CodeMirror to the picker when it's open.
  const keyInterceptor = useCallback(
    (key: "Up" | "Down" | "Enter" | "Escape") => {
      const p = pickerRef.current;
      if (!triggerRef.current || !p) return false;
      switch (key) {
        case "Up":
          p.moveUp();
          return true;
        case "Down":
          p.moveDown();
          return true;
        case "Enter":
          return p.commit();
        case "Escape":
          setTrigger(null);
          return true;
      }
    },
    []
  );

  // Auto-focus the chat input whenever this panel mounts (tab switch back into chat).
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [tabId]);

  // Listen for "Reply" clicks on message items — prepend a quote block.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ content: string }>).detail;
      if (!detail?.content) return;
      const quoted = detail.content
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      const cur = inputRef.current?.getValue() ?? "";
      const next = `${quoted}\n\n${cur}`;
      inputRef.current?.setValue(next);
      setValue(next);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("atlas:chat-reply", handler);
    return () => window.removeEventListener("atlas:chat-reply", handler);
  }, []);

  const submit = useCallback(() => {
    const text = inputRef.current?.getValue() ?? value;
    const trimmed = text.trim();
    if (!trimmed) {
      // Empty + running → act as a stop button.
      if (running) onStop?.();
      return;
    }
    const mentions = inputRef.current?.getMentions() ?? [];
    if (running) {
      // Queued messages don't carry mentions yet — the queue holds raw
      // strings and the agent will see whatever shortform text was in the
      // composer. Mentions are dropped here intentionally; promoting the
      // queue to a structured shape is a follow-up.
      enqueueMessage(tabId, trimmed);
    } else {
      onSend(trimmed, mentions);
    }
    inputRef.current?.clear();
    setValue("");
  }, [value, running, onSend, onStop, enqueueMessage, tabId]);

  const trimmed = value.trim();
  // Tri-state button:
  //   running + empty   → STOP
  //   running + text    → QUEUE
  //   not running + any → SEND
  type Mode = "send" | "queue" | "stop";
  const mode: Mode = running ? (trimmed ? "queue" : "stop") : "send";
  const buttonEnabled = mode === "stop" ? true : trimmed.length > 0;

  return (
    <div className="px-4 pb-4 pt-2 bg-transparent">
      <div className="max-w-[720px] mx-auto">
        {/* Queued messages above the input */}
        {queue.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] px-1">
              Queued · {queue.length}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {queue.map((q, i) => (
                <QueueChip
                  key={i}
                  text={q}
                  onEdit={() => {
                    const cur = inputRef.current?.getValue() ?? "";
                    const merged = cur.trim() ? `${cur}\n${q}` : q;
                    inputRef.current?.setValue(merged);
                    setValue(merged);
                    removeQueueItem(tabId, i);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                  onRemove={() => removeQueueItem(tabId, i)}
                />
              ))}
            </div>
          </div>
        )}

        <div
          className={cn(
            "rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)]",
            "shadow-[0_8px_24px_rgba(0,0,0,0.35)]",
            "focus-within:border-[var(--border-focus)] transition-colors"
          )}
        >
          <ChatInput
            ref={inputRef}
            placeholder={running ? "Type to queue the next message…" : placeholder}
            onChange={setValue}
            onSubmit={submit}
            onMentionTrigger={setTrigger}
            keyInterceptor={keyInterceptor}
          />
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <div className="flex items-center gap-1">
              <button
                onClick={() => cycleClaudePermissionMode(tabId)}
                className="flex items-center gap-1.5 px-2 h-6.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[10px] leading-none font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                title="Cycle permission mode (⇧⇥)"
              >
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full shrink-0",
                    permissionMode === "default" && "bg-[var(--text-tertiary)]",
                    permissionMode === "acceptEdits" && "bg-[var(--status-success)]",
                    permissionMode === "plan" && "bg-[var(--accent-primary)]",
                    permissionMode === "bypassPermissions" && "bg-[var(--status-error)]"
                  )}
                />
                {CLAUDE_PERMISSION_MODE_LABEL[permissionMode]}
              </button>
              <button
                onClick={() => {
                  // Insert a literal `@` at the caret and refocus the
                  // editor — the trigger plugin picks it up and opens
                  // the picker just like a typed `@`.
                  const view = inputRef.current?.view();
                  if (!view) return;
                  const head = view.state.selection.main.head;
                  view.dispatch({
                    changes: { from: head, to: head, insert: "@" },
                    selection: { anchor: head + 1 },
                  });
                  inputRef.current?.focus();
                }}
                className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                title="Mention (@)"
              >
                <AtSign size={12} />
              </button>
            </div>

            <div className="flex items-center">
              <button
                onClick={submit}
                disabled={!buttonEnabled}
                className={cn(
                  "flex items-center justify-center w-7 h-7 rounded-full transition-colors",
                  buttonEnabled
                    ? "bg-[var(--text-primary)] text-[var(--bg-primary)] hover:bg-[var(--text-secondary)] cursor-pointer"
                    : "bg-[var(--bg-elevated)] text-[var(--text-tertiary)] cursor-not-allowed"
                )}
                title={
                  mode === "stop"
                    ? "Stop generation"
                    : mode === "queue"
                    ? "Queue message (sends after current finishes)"
                    : "Send to agent (⌘↵)"
                }
              >
                {mode === "stop" ? (
                  <Square size={11} strokeWidth={3} fill="currentColor" />
                ) : (
                  <ArrowUp size={14} strokeWidth={2.5} />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
      <MentionPicker
        ref={pickerRef}
        open={trigger !== null}
        query={trigger?.query ?? ""}
        anchor={trigger?.anchor ?? null}
        projectPath={projectPath}
        onSelect={handleMentionSelect}
        onClose={() => setTrigger(null)}
      />
    </div>
  );
}

function QueueChip({
  text,
  onEdit,
  onRemove,
}: {
  text: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="group flex items-center gap-1 max-w-[260px] h-6 pl-2 pr-1 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[11px] text-[var(--text-secondary)]">
      <button
        onClick={onEdit}
        className="flex items-center gap-1 min-w-0 cursor-pointer hover:text-[var(--text-primary)]"
        title="Edit / merge into input"
      >
        <Pencil size={9} className="text-[var(--text-tertiary)] shrink-0" />
        <span className="truncate">{text.replace(/\s+/g, " ")}</span>
      </button>
      <button
        onClick={onRemove}
        className="flex items-center justify-center w-4 h-4 rounded-full hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--status-error)] cursor-pointer shrink-0"
        title="Remove from queue"
      >
        <X size={10} />
      </button>
    </div>
  );
}
