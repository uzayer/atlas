import { toast } from "sonner";
import type { SessionMessage } from "@/types/agents";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { agents, ensureDefaultAgent, getDefaultAgentSync } from "./agents-api";

/** Map an atlas-agents `SessionMessage` onto the chat-store wire shape. */
function snapshotMessageToWire(m: SessionMessage) {
  return {
    role: m.role === "system" ? ("system" as const) : m.role,
    content: m.content,
    timestamp: m.timestamp,
    toolCalls: m.tool_calls.map((tc) => ({
      toolName: tc.tool_name,
      kind: tc.kind ?? null,
      arguments: (tc.arguments ?? {}) as Record<string, unknown>,
    })),
  };
}

interface OpenOpts {
  /** ACP session id to open — the canonical per-session identity. If absent,
   *  just opens an empty chat. NOTE: do NOT key on a chat tab id; a tab (e.g.
   *  `welcome-chat`) hosts many sessions over its life, so focusing by tab id
   *  lands on whatever that tab currently shows, not the clicked session. */
  acpSessionId?: string;
  title: string;
  /** Project root for `loadSession`. */
  cwd: string;
}

function freshTabId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Open the agent chat focused on a specific ACP session, reloading its
 * transcript from disk. Assumes the target workspace is already active (the
 * caller switches workspaces first). Mirrors `session-sidebar.handleOpenAgent`'s
 * load flow (focus-if-open, reuse-idle-tab-else-new) so it can be invoked from
 * anywhere (e.g. the workspace switcher's Chats section).
 */
export async function openAgentSession({ acpSessionId, title, cwd }: OpenOpts): Promise<void> {
  const chat = useChatStore.getState();
  const layout = useLayoutStore.getState();
  const { addTab, setActiveTab } = layout.actions;
  const {
    createSession,
    setAcpBinding,
    setSessionTitle,
    clearSession,
    setTranscriptLoading,
    replaceMessages,
  } = chat.actions;

  // 1. Already open in some tab → focus it (covers re-clicks + running chats).
  if (acpSessionId) {
    for (const [tid, s] of Object.entries(chat.sessions)) {
      if (s.acpSessionId === acpSessionId) {
        setActiveTab(tid);
        return;
      }
    }
  }

  // 2. Pick a target chat tab: reuse the active chat tab only if its session is
  //    idle (load in place — the "open in the agent chat tab" behaviour);
  //    otherwise open a FRESH tab so we never overwrite a running/other session.
  const activeId = layout.activeTabId;
  const activeTab = activeId ? layout.tabs.find((t) => t.id === activeId) : undefined;
  const activeSession = activeId ? chat.sessions[activeId] : undefined;
  const reuse =
    activeTab?.type === "chat" && (!activeSession || activeSession.status === "idle");
  const targetTabId = reuse && activeId ? activeId : freshTabId();

  if (targetTabId !== activeId) {
    addTab({
      id: targetTabId,
      type: "chat",
      title: title.slice(0, 40) || "Chat",
      closable: true,
      dirty: false,
      data: {},
    });
    createSession(targetTabId);
  }
  setActiveTab(targetTabId);

  // No session to restore (a never-messaged chat) → leave the empty tab.
  if (!acpSessionId) return;

  // Optimistic bind + spinner, then hydrate from the (cached) Rust session.
  clearSession(targetTabId);
  setSessionTitle(targetTabId, title.slice(0, 40));
  const cached = getDefaultAgentSync();
  if (cached) setAcpBinding(targetTabId, cached.agent_id, acpSessionId, cwd);
  setTranscriptLoading(targetTabId, true);
  try {
    const agent = await ensureDefaultAgent();
    const key = await agents.loadSession(agent.agent_id, acpSessionId, cwd);
    const snapshot = await agents.snapshot(key);
    replaceMessages(targetTabId, snapshot.messages.map(snapshotMessageToWire));
    setAcpBinding(targetTabId, agent.agent_id, acpSessionId, cwd);
    setTranscriptLoading(targetTabId, false);
  } catch (err) {
    setTranscriptLoading(targetTabId, false);
    toast.error(
      `Couldn't open session: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
