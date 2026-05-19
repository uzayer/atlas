import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../stores/chat-store";
import { agents, ensureDefaultAgent } from "../lib/agents-api";
import type { SessionKey } from "@/types/agents";
import { composePrompt, type MentionData } from "../lib/mentions";
import { MessageInput } from "./message-input";
import { SessionSidebar } from "./session-sidebar";
import { MessagesList } from "./messages-list";
import { BashHistoryPanel } from "./bash-history-panel";
import { ChatSearchPalette } from "./chat-search-palette";
import { PermissionModal } from "./permission-modal";
import { Sparkles, User, TerminalSquare, ListFilter, Search, Loader2 } from "lucide-react";
import { Kbd, KbdGroup } from "@/ui/kbd";
import { logEvent } from "@/features/log/lib/log";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/features/project/stores/project-store";

interface ChatPanelProps {
  tabId: string;
}

export function ChatPanel({ tabId }: ChatPanelProps) {
  // Subscribe to ONLY this tab's session. Streaming chunks on other tabs
  // shouldn't repaint this panel — immer preserves reference equality for
  // unchanged sub-paths, so `s.sessions[tabId]` only changes when this tab
  // mutates.
  const session = useChatStore((s) => s.sessions[tabId]);
  const {
    createSession,
    addMessage,
    updateSessionStatus,
    setSessionTitle,
  } = useChatStore.use.actions();
  const [roleFilter, setRoleFilter] = useState<"all" | "user" | "assistant">("all");
  const [bashPanelOpen, setBashPanelOpen] = useState(false);
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const acpSessionId = session?.acpSessionId ?? "";

  useEffect(() => {
    if (!session) {
      createSession(tabId);
    }
  }, [tabId, session, createSession]);

  // Eagerly bind an ACP agent + session to this tab the moment the chat
  // mounts, so by the time the user types and hits Send the binding is
  // ready and `handleSend` doesn't need to await anything. Skipped when a
  // session is already bound (e.g. the sidebar resumed a historical thread,
  // or this is a re-mount of an active tab).
  useEffect(() => {
    if (!session) return;
    if (session.acpSessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const agent = await ensureDefaultAgent();
        if (cancelled) return;
        const project = useProjectStore.getState().currentProject;
        const cwd = project?.path ?? "/";
        // `agents.newSession` goes through atlas-agents — installs a
        // SessionState + per-session worker in Rust. The returned key is
        // (agent_id, session_id); we keep the same `setAcpBinding(tabId, ...)`
        // shape since the wire-form session id is interchangeable.
        const key = await agents.newSession(agent.agent_id, cwd);
        if (cancelled) return;
        useChatStore
          .getState()
          .actions.setAcpBinding(tabId, agent.agent_id, key.session_id);
        // Honor the tab's selected permission mode for this fresh session.
        const mode =
          useChatStore.getState().sessions[tabId]?.claudePermissionMode ??
          "default";
        if (mode !== "default") {
          agents
            .setMode(key, mode)
            .catch((err) =>
              console.warn("setMode at session create failed:", err)
            );
        }
      } catch (err) {
        console.warn("Eager agent session creation failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabId, session?.acpSessionId]);

  // Cmd+F → open the message-jump palette (ChatPanel only mounts when its tab is active).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSearchPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", handler, true); // capture phase to beat browser default
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // Shift+Tab → cycle the agent permission mode. Registered on the window in
  // capture phase so the browser's default focus traversal never steals it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const root = rootRef.current;
      const active = document.activeElement as HTMLElement | null;
      // Only intercept when focus is somewhere inside this chat panel.
      if (!root || !active || !root.contains(active)) return;
      e.preventDefault();
      e.stopPropagation();
      useChatStore.getState().actions.cycleClaudePermissionMode(tabId);
      // Propagate the new mode to the agent session so the agent actually
      // honours it (e.g. bypassPermissions stops emitting permission requests).
      const s = useChatStore.getState().sessions[tabId];
      if (s?.acpAgentId && s.acpSessionId) {
        const key: SessionKey = {
          agent_id: s.acpAgentId,
          session_id: s.acpSessionId,
        };
        agents
          .setMode(key, s.claudePermissionMode ?? "default")
          .catch((err) => console.warn("setMode failed:", err));
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [tabId]);

  // Drain the per-tab queue when the agent transitions back to idle.
  const prevStatusRef = useRef<string | null>(null);
  const handleSendRef = useRef<
    ((content: string, mentions: MentionData[]) => void) | null
  >(null);
  useEffect(() => {
    const cur = session?.status ?? "idle";
    const prev = prevStatusRef.current;
    prevStatusRef.current = cur;
    if (prev === "running" && cur !== "running") {
      const next = useChatStore.getState().actions.shiftQueue(tabId);
      if (next && handleSendRef.current) {
        // Defer one microtask so the React commit completes first.
        // Queued messages don't carry their original mentions yet — empty
        // array here is intentional (see MessageInput.submit).
        Promise.resolve().then(() => handleSendRef.current?.(next, []));
      }
    }
  }, [session?.status, tabId]);

  if (!session) return null;

  const handleStop = () => {
    const cs = useChatStore.getState();
    const s = cs.sessions[tabId];
    if (!s?.acpAgentId || !s.acpSessionId) return;
    // Optimistic: flip the UI to idle now. The agent's `cancelled`
    // stop_reason arrives shortly via the `atlas:agents` TurnFinished
    // delta, which also sets idle — a no-op at that point. Zed-style
    // instant feel.
    cs.actions.updateSessionStatus(tabId, "idle");
    cs.actions.clearQueue(tabId);
    const key: SessionKey = {
      agent_id: s.acpAgentId,
      session_id: s.acpSessionId,
    };
    agents.cancel(key).catch(() => {});
  };

  const handleSend = async (content: string, mentions: MentionData[]) => {
    const actualContent = content;

    // The user-visible message keeps the prose as the user typed it,
    // including the shortform mention references (`@file:src/foo.rs` etc).
    // The context block goes only to the agent, not the local transcript.
    addMessage(tabId, "user", actualContent);
    logEvent({
      source: "chat",
      kind: "send-agent",
      summary: actualContent.slice(0, 120),
      payload: { tabId, mentionCount: mentions.length },
    });

    if (session.messages.length === 0) {
      setSessionTitle(tabId, actualContent.slice(0, 40) + (actualContent.length > 40 ? "..." : ""));
    }

    // The mount effect binds an agent + session eagerly, so by the time the
    // user can hit Send the binding is ready. The only failure mode is
    // "binding never happened" — agent process couldn't spawn.
    const bound = useChatStore.getState().sessions[tabId];
    if (!bound?.acpAgentId || !bound.acpSessionId) {
      useChatStore
        .getState()
        .actions.addMessage(
          tabId,
          "assistant",
          "Agent session isn't ready yet — try again in a moment, or restart the chat."
        );
      return;
    }
    updateSessionStatus(tabId, "running");

    // Expand mentions into a trailing context block. composePrompt fetches
    // file/note/paper bodies via Tauri and appends them under a fenced
    // `## @ref` section — see `mentions.ts::composePrompt`.
    let wirePrompt: string;
    try {
      wirePrompt = await composePrompt(actualContent, mentions);
    } catch (err) {
      console.warn("composePrompt failed, sending raw text:", err);
      wirePrompt = actualContent;
    }

    // Non-blocking send: returns the instant the prompt is queued onto the
    // SessionWorker. The atlas:agents `turn_finished` delta flips status
    // back to idle + handles empty-turn placeholder via `applyAgentDelta`.
    const key: SessionKey = {
      agent_id: bound.acpAgentId,
      session_id: bound.acpSessionId,
    };
    try {
      await agents.send(key, wirePrompt);
      logEvent({
        source: "agent",
        kind: "stream-started",
        summary: `dispatched to ${bound.acpSessionId}`,
        payload: {
          tabId,
          acpSessionId: bound.acpSessionId,
          mentionCount: mentions.length,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useChatStore
        .getState()
        .actions.addMessage(tabId, "assistant", `agent send error: ${msg}`);
      useChatStore.getState().actions.updateSessionStatus(tabId, "error");
      logEvent({
        source: "agent",
        kind: "stream-error",
        summary: msg.slice(0, 160),
        payload: { tabId },
      });
    }
  };

  // Keep the queue-drain effect pointing at the latest handleSend closure.
  handleSendRef.current = handleSend;

  return (
    <div ref={rootRef} className="h-full flex">
      <PermissionModal tabId={tabId} />
      <SessionSidebar tabId={tabId} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Chat toolbar */}
        {session.messages.length > 0 && (
          <div className="flex items-center gap-2 px-3 h-[32px] border-b border-[var(--border-default)] shrink-0">
            <button
              onClick={() => setSearchPaletteOpen(true)}
              className="flex items-center gap-2 h-6.5 pl-2.5 pr-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer outline-none transition-colors min-w-[280px]"
              title="Search messages (⌘F)"
            >
              <Search size={11} />
              <span>Find in chat…</span>
              <span className="ml-auto">
              	<KbdGroup>
									<Kbd className="h-[16px] w-fit min-w-[16px]">⌘</Kbd>
                  <Kbd className="h-[16px] w-fit min-w-[16px]">F</Kbd>
                </KbdGroup>
              </span>
            </button>
            <div className="flex-1" />
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  className="flex items-center gap-1 px-2 h-6 rounded text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer outline-none transition-colors"
                  title="Filter messages"
                >
                  <ListFilter size={11} />
                  <span className="capitalize">{roleFilter}</span>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  className="rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)] py-1 min-w-[140px]"
                  style={{ zIndex: 9999 }}
                >
                  {(["all", "user", "assistant"] as const).map((f) => (
                    <DropdownMenu.Item
                      key={f}
                      onClick={() => setRoleFilter(f)}
                      className={cn(
                        "flex items-center gap-2 px-3 h-[26px] text-[11px] cursor-default outline-none capitalize",
                        roleFilter === f
                          ? "text-[var(--text-primary)] bg-[var(--bg-selected)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      )}
                    >
                      {f === "user" ? <User size={10} /> : f === "assistant" ? <Sparkles size={10} /> : <ListFilter size={10} />}
                      <span>{f}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <button
              onClick={() => setBashPanelOpen((v) => !v)}
              className={cn(
                "flex items-center gap-1 px-2 h-6 rounded text-[10px] cursor-pointer outline-none transition-colors",
                bashPanelOpen
                  ? "text-[var(--text-primary)] bg-[var(--bg-selected)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              )}
              title="Toggle bash call history"
            >
              <TerminalSquare size={11} />
              Bash
            </button>
          </div>
        )}

        {session.messages.length === 0 ? (
          <div className="flex-1 overflow-y-auto">
            {session.transcriptLoading ? (
              <LoadingTranscriptState />
            ) : (
              <WelcomeState />
            )}
          </div>
        ) : (
          <MessagesList
            tabId={tabId}
            acpSessionId={acpSessionId}
            messages={session.messages}
            roleFilter={roleFilter}
            isStreaming={session.status === "running"}
          />
        )}

        <div className="relative">
          {/* (The bottom fade lives inside MessagesList and is tied to the
              same showJumpToBottom state as the floating "scroll to bottom"
              button — no separate always-on fade here.) */}
          <MessageInput
            tabId={tabId}
            onSend={handleSend}
            onStop={handleStop}
            running={session.status === "running"}
          />
        </div>
      </div>

      {bashPanelOpen && (
        <BashHistoryPanel
          messages={session.messages}
          onJump={(idx) => {
            if (roleFilter !== "all") setRoleFilter("all");
            window.dispatchEvent(
              new CustomEvent("atlas:chat-jump", { detail: { index: idx } })
            );
          }}
          onClose={() => setBashPanelOpen(false)}
        />
      )}

      <ChatSearchPalette
        open={searchPaletteOpen}
        onOpenChange={setSearchPaletteOpen}
        messages={session.messages}
        onJump={(idx) =>
          window.dispatchEvent(new CustomEvent("atlas:chat-jump", { detail: { index: idx } }))
        }
      />
    </div>
  );
}

function LoadingTranscriptState() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
        <Loader2 size={12} className="animate-spin text-[var(--accent-primary)]" />
        <span>Loading transcript…</span>
      </div>
    </div>
  );
}

function WelcomeState() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center space-y-4 max-w-[400px] px-6">
        <div className="w-14 h-14 rounded-2xl bg-[var(--accent-primary-muted)] flex items-center justify-center mx-auto">
          <Sparkles size={28} className="text-[var(--accent-primary)]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            Atlas
          </h2>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Code with Claude. Tools, plans, and edits all live.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-left">
          {[
            "Analyze this codebase",
            "Create a new feature",
            "Review recent changes",
            "Write tests for...",
          ].map((prompt) => (
            <button
              key={prompt}
              className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors text-left"
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
