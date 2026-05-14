import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import {
  ArrowUp,
  AtSign,
  Settings,
  Terminal,
  Sparkles,
  Square,
  Pencil,
  X,
} from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { CLAUDE_PERMISSION_MODE_LABEL } from "@/types/agent";

interface MessageInputProps {
  tabId: string;
  /** Send a message right now (used when idle, or to dequeue). */
  onSend: (message: string) => void;
  /** Stop the current generation. */
  onStop?: () => void;
  /** True while the agent/LLM is producing a response. */
  running?: boolean;
  placeholder?: string;
  onSettingsClick?: () => void;
}

export function MessageInput({
  tabId,
  onSend,
  onStop,
  running = false,
  placeholder = "Message Atlas... (@ to mention, / for commands)",
  onSettingsClick,
}: MessageInputProps) {
  const providerConfig = useChatStore.use.providerConfig();
  const sessions = useChatStore.use.sessions();
  const queues = useChatStore.use.queues();
  const {
    toggleUseClaude,
    cycleClaudePermissionMode,
    enqueueMessage,
    removeQueueItem,
  } = useChatStore.use.actions();
  const session = sessions[tabId];
  const useClaude = session?.useClaude ?? true;
  const permissionMode = session?.claudePermissionMode ?? "default";
  const queue = queues[tabId] ?? [];

  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus the chat input whenever this panel mounts (tab switch back into chat).
  useEffect(() => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
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
      setValue((v) => `${quoted}\n\n${v}`);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.scrollTop = 0;
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    };
    window.addEventListener("atlas:chat-reply", handler);
    return () => window.removeEventListener("atlas:chat-reply", handler);
  }, []);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      // Empty + running → act as a stop button.
      if (running) onStop?.();
      return;
    }
    if (running) {
      enqueueMessage(tabId, trimmed);
    } else {
      onSend(trimmed);
    }
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, running, onSend, onStop, enqueueMessage, tabId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
    // Shift+Tab handled at chat-panel level.
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

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
                    setValue((cur) => (cur.trim() ? `${cur}\n${q}` : q));
                    removeQueueItem(tabId, i);
                    requestAnimationFrame(() => textareaRef.current?.focus());
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
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={
              running
                ? "Type to queue the next message…"
                : placeholder
            }
            rows={1}
            className={cn(
              "w-full bg-transparent resize-none px-4 pt-3 pb-1 text-sm leading-relaxed",
              "text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]",
              "outline-none",
              "min-h-[44px] max-h-[200px]"
            )}
          />
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <div className="flex items-center gap-1">
              <button
                onClick={() => toggleUseClaude(tabId)}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 h-6.5 rounded-full text-[10px] leading-none font-medium transition-colors border cursor-pointer",
                  useClaude
                    ? "bg-[var(--bg-elevated)] text-[var(--text-primary)] border-[var(--border-default)] hover:bg-[var(--bg-hover)]"
                    : "bg-[var(--accent-primary-muted)] text-[var(--accent-primary)] border-transparent hover:opacity-90"
                )}
                title="Toggle between Claude Code and LLM provider"
              >
                {useClaude ? <Terminal size={11} /> : <Sparkles size={11} />}
                {useClaude ? "Claude Code" : providerConfig.provider}
              </button>
              {useClaude && (
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
              )}
              {!useClaude && (
                <button
                  onClick={onSettingsClick}
                  className="px-2 h-6 rounded-md text-[11px] font-mono text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                  title="Model"
                >
                  {providerConfig.model}
                </button>
              )}
              <button
                className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                title="Mention"
              >
                <AtSign size={12} />
              </button>
              <button
                onClick={onSettingsClick}
                className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                title="Settings"
              >
                <Settings size={12} />
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
                    : useClaude
                    ? "Send to Claude Code (⌘↵)"
                    : "Send to LLM provider (⌘↵)"
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
