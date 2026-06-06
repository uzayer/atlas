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
// `ChatInput` pulls in CodeMirror (~870 KB) via `cm-mention-extension`.
// We import it dynamically so the chunk is not in the initial preload set.
// The import is kicked off at module-evaluation time (below, outside the
// component) so the chunk starts downloading the moment this module is
// reached in the import graph — *before* MessageInput even mounts. Until
// the chunk resolves the composer renders a same-sized empty placeholder
// so the panel doesn't reflow when CM lands.
//
// `MentionPicker` only mounts when the user types `@`, so we let its chunk
// load purely on demand — no eager preload (that would add a wasted Vite
// roundtrip in dev for every MessageInput mount).
import type { ChatInput as ChatInputComponent, ChatInputHandle } from "./chat-input";
import type {
  MentionPicker as MentionPickerComponent,
  MentionPickerHandle,
} from "@/features/mentions/components/mention-picker";
import type {
  SlashCommandPicker as SlashCommandPickerComponent,
  SlashCommandPickerHandle,
  SlashCommand,
} from "./slash-command-picker";
import { commandRequiresArgs } from "./slash-command-picker";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useClaudeSetupStore } from "@/features/claude-setup/stores/claude-setup-store";
import type { MentionTrigger } from "../lib/cm-mention-extension";
import type { SlashTrigger } from "../lib/cm-slash-extension";
import { clearSlashRange } from "../lib/cm-slash-extension";
import type { MentionData } from "../lib/mentions";

// Start the CodeMirror chunk download at module-evaluation time. Vite still
// excludes it from `<link rel="modulepreload">` because the static analysis
// only sees a dynamic `import()`. The promise is reused by every MessageInput
// instance.
const chatInputPromise: Promise<typeof import("./chat-input")> =
  import("./chat-input");
const mentionPickerPromise: Promise<
  typeof import("@/features/mentions/components/mention-picker")
> = import("@/features/mentions/components/mention-picker");
const slashCommandPickerPromise: Promise<typeof import("./slash-command-picker")> =
  import("./slash-command-picker");

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
  /** Hard-disable the composer (e.g. Claude Code isn't installed/authed). */
  disabled?: boolean;
  /** Placeholder text when `disabled` is true. */
  disabledReason?: string;
  placeholder?: string;
}

export function MessageInput({
  tabId,
  onSend,
  onStop,
  running = false,
  disabled = false,
  disabledReason,
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
  //
  // Initial seed reads the per-tab draft from chat-store so switching tabs
  // (which unmounts this component) doesn't drop what the user was typing.
  // `useState`'s lazy initializer runs once per mount with the tabId that
  // was current at mount time — that's exactly what we want.
  const [value, setValue] = useState(
    () => useChatStore.getState().drafts[tabId] ?? "",
  );
  const inputRef = useRef<ChatInputHandle>(null);

  // Mirror every doc change into the per-tab draft slot. Using an
  // effect (rather than wrapping each setValue callsite) means every
  // path that updates the composer — typing, slash insertion, queue
  // recall — keeps the store in sync without having to remember.
  const { setDraft } = useChatStore.use.actions();
  useEffect(() => {
    setDraft(tabId, value);
  }, [value, tabId, setDraft]);

  // The CM chunk started downloading at module-eval time (see the top of this
  // file). Mirror the resolution into component state so React re-renders
  // once the component class is available. We never render a textarea
  // fallback — instead the placeholder div below holds the layout slot at
  // the same height so the swap is invisible (no reflow, no mount/unmount
  // of an interactive element mid-typing).
  const [LazyChatInput, setLazyChatInput] =
    useState<typeof ChatInputComponent | null>(null);
  const [LazyMentionPicker, setLazyMentionPicker] =
    useState<typeof MentionPickerComponent | null>(null);
  const [LazySlashPicker, setLazySlashPicker] =
    useState<typeof SlashCommandPickerComponent | null>(null);

  useEffect(() => {
    let cancelled = false;
    void chatInputPromise.then((m) => {
      if (!cancelled) setLazyChatInput(() => m.ChatInput);
    });
    void mentionPickerPromise.then((m) => {
      if (!cancelled) setLazyMentionPicker(() => m.MentionPicker);
    });
    void slashCommandPickerPromise.then((m) => {
      if (!cancelled) setLazySlashPicker(() => m.SlashCommandPicker);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fire `atlas:chat-input-focused` the first time this composer takes focus.
  // ChatPanel listens for it to lazily bind an ACP session — deferring the
  // agent spawn until the user actually intends to chat keeps it off the cold
  // boot path. Reset per tab so re-focusing a fresh tab still binds.
  const focusedOnceRef = useRef(false);
  useEffect(() => {
    focusedOnceRef.current = false;
  }, [tabId]);
  const handleFocusCapture = useCallback(() => {
    if (focusedOnceRef.current) return;
    focusedOnceRef.current = true;
    window.dispatchEvent(
      new CustomEvent("atlas:chat-input-focused", { detail: { tabId } })
    );
  }, [tabId]);

  // ── Mention picker orchestration ──────────────────────────────────────
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const pickerRef = useRef<MentionPickerHandle>(null);
  const triggerRef = useRef<MentionTrigger | null>(null);
  triggerRef.current = trigger;

  // ── Slash-command picker orchestration ────────────────────────────────
  const [slashTrigger, setSlashTrigger] = useState<SlashTrigger | null>(null);
  const slashPickerRef = useRef<SlashCommandPickerHandle>(null);
  const slashTriggerRef = useRef<SlashTrigger | null>(null);
  slashTriggerRef.current = slashTrigger;
  const { openLoginDialog } = useClaudeSetupStore.use.actions();

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

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      const t = slashTriggerRef.current;
      const view = inputRef.current?.view();
      if (!t || !view) return;

      if (cmd.handler === "atlas-login") {
        // `/login` doesn't pass through to the agent — the adapter
        // filters it. Open Atlas's own dialog instead.
        clearSlashRange(view, t.from, t.to);
        setSlashTrigger(null);
        openLoginDialog();
        inputRef.current?.focus();
        return;
      }

      // Passthrough: every other command is sent verbatim to the agent.
      // claude-agent-acp's SDK processes the slash command client-side
      // and emits the result as `<local-command-*>` blocks via the
      // normal `agent_message_chunk` channel, so the response renders in
      // the chat thread alongside regular assistant output.
      //
      // Gate on `disabled` — passthrough requires a working ACP
      // connection, and sending a slash command to a not-yet-authed
      // agent would just surface an error. `/login` bypasses this gate
      // above because it's the path that fixes "not authed".
      if (disabled) {
        clearSlashRange(view, t.from, t.to);
        setSlashTrigger(null);
        return;
      }
      if (commandRequiresArgs(cmd)) {
        // Drop `/<name> ` into the composer and put the caret at the
        // end so the user can fill in the required args. Don't send
        // until they press Enter.
        const insertText = `/${cmd.name} `;
        view.dispatch({
          changes: { from: t.from, to: t.to, insert: insertText },
          selection: { anchor: t.from + insertText.length },
        });
        setSlashTrigger(null);
        inputRef.current?.focus();
        return;
      }

      // No required args — fire and forget. Clear the composer (the
      // user's `/query` doesn't need to linger) and dispatch via the
      // panel's normal send path.
      clearSlashRange(view, t.from, t.to);
      inputRef.current?.clear();
      setValue("");
      setSlashTrigger(null);
      onSend(`/${cmd.name}`, []);
    },
    [openLoginDialog, onSend, disabled]
  );

  // Forward Up/Down/Enter/Esc/Backspace from CodeMirror to whichever
  // picker is open. Slash and mention pickers are mutually exclusive in
  // practice (slash only fires at line start of an otherwise-empty
  // composer), but we still route deterministically.
  const keyInterceptor = useCallback(
    (key: "Up" | "Down" | "Enter" | "Escape" | "Backspace") => {
      // Slash takes precedence when both happen to be open.
      const sp = slashPickerRef.current;
      const st = slashTriggerRef.current;
      if (st && sp) {
        switch (key) {
          case "Up":
            sp.moveUp();
            return true;
          case "Down":
            sp.moveDown();
            return true;
          case "Enter":
            return sp.commit();
          case "Escape":
            setSlashTrigger(null);
            return true;
          case "Backspace":
            // Let CM delete a query char or the `/` itself (which closes
            // the picker via the trigger detector).
            return false;
        }
      }

      const p = pickerRef.current;
      const t = triggerRef.current;
      if (!t || !p) return false;
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
          // At a sublevel, Esc pops back. At the top level, it closes.
          if (p.goBack()) return true;
          setTrigger(null);
          return true;
        case "Backspace":
          // Only consume Backspace when at a sublevel AND the query is
          // empty — otherwise let CM delete a character in the query (or
          // the `@` itself, which closes the picker via the trigger
          // detector).
          if (t.query === "" && p.goBack()) return true;
          return false;
      }
    },
    []
  );

  // Auto-focus the composer whenever this panel mounts (tab switch back into
  // chat). If the CodeMirror chunk hasn't resolved yet, the next re-render
  // (driven by `LazyChatInput` flipping non-null) re-runs this effect and
  // focuses the real input as soon as it exists.
  useEffect(() => {
    if (!LazyChatInput) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [tabId, LazyChatInput]);

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

  // Prefill the composer with raw text (empty-state prompt chips). Unlike
  // "reply" this replaces the value verbatim (no quote block) and focuses.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string }>).detail;
      if (!detail?.text) return;
      inputRef.current?.setValue(detail.text);
      setValue(detail.text);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("atlas:chat-prefill", handler);
    return () => window.removeEventListener("atlas:chat-prefill", handler);
  }, []);

  // Append text to the composer (e.g. the KB bubble menu's "Send selection to
  // chat"). Unlike "prefill" this is NON-destructive (keeps any draft) and only
  // the ACTIVE session reacts, so it doesn't fan out to every mounted chat tab.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string }>).detail;
      if (!detail?.text) return;
      if (useChatStore.getState().activeSessionId !== tabId) return;
      const cur = inputRef.current?.getValue() ?? "";
      const next = cur.trim() ? `${cur}\n\n${detail.text}` : detail.text;
      inputRef.current?.setValue(next);
      setValue(next);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("atlas:chat-insert", handler);
    return () => window.removeEventListener("atlas:chat-insert", handler);
  }, [tabId]);

  const submit = useCallback(() => {
    // Hard gate: Claude Code missing or not authed — sending would just
    // surface a confusing ACP spawn error. The banner above tells the user
    // what to do instead.
    if (disabled) return;
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
    // The value→draft sync effect will collapse the empty value into a
    // `delete s.drafts[tabId]` on the next commit, so no explicit
    // clearDraft call is needed.
  }, [value, running, onSend, onStop, enqueueMessage, tabId, disabled]);

  const trimmed = value.trim();
  // Tri-state button:
  //   running + empty   → STOP
  //   running + text    → QUEUE
  //   not running + any → SEND
  type Mode = "send" | "queue" | "stop";
  const mode: Mode = running ? (trimmed ? "queue" : "stop") : "send";
  const buttonEnabled = disabled
    ? false
    : mode === "stop"
      ? true
      : trimmed.length > 0;

  const effectivePlaceholder = disabled
    ? (disabledReason ?? "Set up Claude Code to start chatting")
    : running
      ? "Type to queue the next message…"
      : placeholder;

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
            // Soft macOS-style "active field" glow on focus — a faint
            // accent ring on top of the border shift (the border alone is
            // near-invisible against the black surface).
            "transition-[border-color,box-shadow] duration-150",
            "focus-within:border-[var(--border-focus)]",
            "focus-within:ring-1 focus-within:ring-[var(--accent-primary)]/20",
            // Hard-disable when Claude Code isn't ready. `pointer-events-none`
            // also blocks the focus event so we never trigger the agent-bind
            // listener (which would try to spawn a session against a CLI
            // that isn't ready). The error tint makes the dead input
            // obviously dead rather than just dimmed on black.
            disabled &&
              "opacity-70 pointer-events-none border-[var(--status-error)]/25 bg-[var(--status-error)]/[0.04]",
          )}
          onFocusCapture={handleFocusCapture}
        >
          {LazyChatInput ? (
            <LazyChatInput
              ref={inputRef}
              initialValue={value}
              placeholder={effectivePlaceholder}
              onChange={setValue}
              onSubmit={submit}
              onMentionTrigger={setTrigger}
              onSlashTrigger={setSlashTrigger}
              keyInterceptor={keyInterceptor}
            />
          ) : (
            // Same-height empty slot so the panel layout doesn't reflow when
            // CodeMirror lands. Non-interactive — by the time the user can
            // visually find this region the chunk has typically resolved.
            <div
              aria-hidden="true"
              style={{ minHeight: 44 }}
              className="px-4 pt-3 pb-1"
            />
          )}
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
      {LazyMentionPicker && (
        <LazyMentionPicker
          ref={pickerRef}
          open={trigger !== null}
          query={trigger?.query ?? ""}
          anchor={trigger?.anchor ?? null}
          initialScope={trigger?.scope ?? null}
          projectPath={projectPath}
          onSelect={handleMentionSelect}
          onClose={() => setTrigger(null)}
        />
      )}
      {LazySlashPicker && (
        <LazySlashPicker
          ref={slashPickerRef}
          open={slashTrigger !== null}
          query={slashTrigger?.query ?? ""}
          anchor={slashTrigger?.anchor ?? null}
          onSelect={handleSlashSelect}
          onClose={() => setSlashTrigger(null)}
        />
      )}
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
