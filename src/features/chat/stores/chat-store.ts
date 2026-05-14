import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import type {
  ChatSession,
  ChatMessage,
  AgentStatus,
  MessageRole,
  ClaudePermissionMode,
} from "@/types/agent";
import { CLAUDE_PERMISSION_MODES } from "@/types/agent";

interface ProviderConfig {
  provider: "anthropic" | "openai" | "google";
  model: string;
  apiKey: string;
  system: string;
}

interface ChatState {
  sessions: Record<string, ChatSession>;
  /**
   * Per-tab queue of pending user messages. Filled when the user types while
   * the agent is still streaming; auto-drained when the stream finishes.
   */
  queues: Record<string, string[]>;
  /**
   * Sessions that were displaced from a tab because the user navigated to a
   * different history item while the stream was still running. Keyed by the
   * Claude Code session id so the stream listener can keep updating them in
   * the background; restored back into a tab when the user revisits them.
   */
  runningArchive: Record<string, ChatSession>;
  activeSessionId: string | null;
  providerConfig: ProviderConfig;
}

interface ChatActions {
  actions: {
    createSession: (tabId: string) => void;
    setActiveSession: (id: string | null) => void;
    addMessage: (
      sessionId: string,
      role: MessageRole,
      content: string
    ) => void;
    appendToolCall: (
      sessionId: string,
      toolName: string,
      input: Record<string, unknown>
    ) => void;
    updateLastAssistantMessage: (sessionId: string, content: string) => void;
    updateSessionStatus: (sessionId: string, status: AgentStatus) => void;
    setSessionTitle: (sessionId: string, title: string) => void;
    clearSession: (sessionId: string) => void;
    removeSession: (sessionId: string) => void;
    setClaudeSessionId: (sessionId: string, claudeId: string | undefined) => void;
    toggleUseClaude: (sessionId: string) => void;
    cycleClaudePermissionMode: (sessionId: string) => void;
    setClaudePermissionMode: (
      sessionId: string,
      mode: ClaudePermissionMode
    ) => void;
    replaceMessages: (
      sessionId: string,
      messages: Array<{
        role: MessageRole;
        content: string;
        timestamp?: string;
        toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
      }>
    ) => void;
    setProvider: (provider: ProviderConfig["provider"]) => void;
    setModel: (model: string) => void;
    setApiKey: (key: string) => void;
    setSystem: (system: string) => void;
    enqueueMessage: (sessionId: string, text: string) => void;
    removeQueueItem: (sessionId: string, index: number) => void;
    editQueueItem: (sessionId: string, index: number, text: string) => void;
    shiftQueue: (sessionId: string) => string | null;
    clearQueue: (sessionId: string) => void;
    // Background archive — keeps in-flight Claude sessions alive when a tab
    // navigates away to view a different historical thread.
    archiveCurrent: (tabId: string) => string | null;
    restoreArchive: (tabId: string, claudeSessionId: string) => boolean;
    dropArchive: (claudeSessionId: string) => void;
    updateArchivedAssistant: (claudeSessionId: string, content: string) => void;
    appendArchivedToolCall: (
      claudeSessionId: string,
      toolName: string,
      input: Record<string, unknown>
    ) => void;
    setArchivedStatus: (claudeSessionId: string, status: AgentStatus) => void;
    setArchivedTitle: (claudeSessionId: string, title: string) => void;
    setSessionStreamId: (sessionId: string, streamId: string | undefined) => void;
    setArchivedStreamId: (
      claudeSessionId: string,
      streamId: string | undefined
    ) => void;
  };
}

const initialProviderConfig: ProviderConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6-20250514",
  apiKey: "",
  system: "You are Atlas, an AI assistant integrated into a second-brain IDE. Be concise and helpful.",
};

export const useChatStore = createSelectors(
  create<ChatState & ChatActions>()(
    immer((set) => ({
      sessions: {},
      queues: {},
      runningArchive: {},
      activeSessionId: null,
      providerConfig: initialProviderConfig,
      actions: {
        createSession: (tabId) =>
          set((s) => {
            if (s.sessions[tabId]) return;
            s.sessions[tabId] = {
              id: tabId,
              title: "New Chat",
              messages: [],
              agentType: "claude-code",
              model: s.providerConfig.model,
              status: "idle",
              workingDirectory: "",
              tasks: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              claudeSessionId: undefined,
              useClaude: true,
              claudePermissionMode: "default",
            };
            s.activeSessionId = tabId;
          }),
        setActiveSession: (id) =>
          set((s) => {
            s.activeSessionId = id;
          }),
        addMessage: (sessionId, role, content) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            const msg: ChatMessage = {
              id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              role,
              content,
              toolCalls: [],
              fileChanges: [],
              plan: null,
              timestamp: new Date().toISOString(),
            };
            session.messages.push(msg);
            session.updatedAt = new Date().toISOString();
          }),
        appendToolCall: (sessionId, toolName, input) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            for (let i = session.messages.length - 1; i >= 0; i--) {
              if (session.messages[i].role === "assistant") {
                session.messages[i].toolCalls.push({
                  id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  toolName,
                  arguments: input,
                  result: null,
                  status: "completed",
                  duration: null,
                });
                break;
              }
            }
          }),
        updateLastAssistantMessage: (sessionId, content) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            for (let i = session.messages.length - 1; i >= 0; i--) {
              if (session.messages[i].role === "assistant") {
                session.messages[i].content = content;
                break;
              }
            }
          }),
        updateSessionStatus: (sessionId, status) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.status = status;
          }),
        setSessionTitle: (sessionId, title) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.title = title;
          }),
        clearSession: (sessionId) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) {
              session.messages = [];
              session.tasks = [];
              session.status = "idle";
              session.claudeSessionId = undefined;
              session.title = "New Chat";
            }
            delete s.queues[sessionId];
          }),
        setClaudeSessionId: (sessionId, claudeId) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.claudeSessionId = claudeId;
          }),
        cycleClaudePermissionMode: (sessionId) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            const cur = session.claudePermissionMode ?? "default";
            const i = CLAUDE_PERMISSION_MODES.indexOf(cur);
            const next =
              CLAUDE_PERMISSION_MODES[(i + 1) % CLAUDE_PERMISSION_MODES.length];
            session.claudePermissionMode = next;
          }),
        setClaudePermissionMode: (sessionId, mode) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.claudePermissionMode = mode;
          }),
        toggleUseClaude: (sessionId) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            // Each mode owns its own thread — toggling resets to a fresh chat
            // so we don't carry agent-streamed messages into the general view
            // (or vice-versa) and the UI starts clean.
            session.useClaude = !session.useClaude;
            session.messages = [];
            session.tasks = [];
            session.status = "idle";
            session.claudeSessionId = undefined;
            session.title = "New Chat";
            delete s.queues[sessionId];
          }),
        replaceMessages: (sessionId, messages) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (!session) return;
            session.messages = messages.map((m, i) => ({
              id: `msg-${Date.now()}-${i}`,
              role: m.role,
              content: m.content,
              toolCalls: (m.toolCalls ?? []).map((tc, j) => ({
                id: `tc-${Date.now()}-${i}-${j}`,
                toolName: tc.toolName,
                arguments: tc.arguments,
                result: null,
                status: "completed" as const,
                duration: null,
              })),
              fileChanges: [],
              plan: null,
              timestamp: m.timestamp ?? new Date().toISOString(),
            }));
            session.updatedAt = new Date().toISOString();
          }),
        removeSession: (sessionId) =>
          set((s) => {
            delete s.sessions[sessionId];
            if (s.activeSessionId === sessionId) {
              const keys = Object.keys(s.sessions);
              s.activeSessionId = keys.length > 0 ? keys[0] : null;
            }
          }),
        setProvider: (provider) =>
          set((s) => {
            s.providerConfig.provider = provider;
          }),
        setModel: (model) =>
          set((s) => {
            s.providerConfig.model = model;
          }),
        setApiKey: (key) =>
          set((s) => {
            s.providerConfig.apiKey = key;
          }),
        setSystem: (system) =>
          set((s) => {
            s.providerConfig.system = system;
          }),
        enqueueMessage: (sessionId, text) =>
          set((s) => {
            const cur = s.queues[sessionId] ?? [];
            s.queues[sessionId] = [...cur, text];
          }),
        removeQueueItem: (sessionId, index) =>
          set((s) => {
            const cur = s.queues[sessionId];
            if (!cur) return;
            const next = cur.filter((_, i) => i !== index);
            if (next.length === 0) delete s.queues[sessionId];
            else s.queues[sessionId] = next;
          }),
        editQueueItem: (sessionId, index, text) =>
          set((s) => {
            const cur = s.queues[sessionId];
            if (!cur || index < 0 || index >= cur.length) return;
            const next = [...cur];
            next[index] = text;
            s.queues[sessionId] = next;
          }),
        shiftQueue: (sessionId) => {
          let head: string | null = null;
          set((s) => {
            const cur = s.queues[sessionId];
            if (!cur || cur.length === 0) return;
            head = cur[0];
            const rest = cur.slice(1);
            if (rest.length === 0) delete s.queues[sessionId];
            else s.queues[sessionId] = rest;
          });
          return head;
        },
        clearQueue: (sessionId) =>
          set((s) => {
            delete s.queues[sessionId];
          }),

        // ── Background archive ────────────────────────────────────────────
        archiveCurrent: (tabId) => {
          let archivedSid: string | null = null;
          set((s) => {
            const cur = s.sessions[tabId];
            if (!cur || !cur.useClaude || !cur.claudeSessionId) return;
            // Park a deep-ish copy so the stream listener can keep updating
            // it independently of whatever the tab is now showing.
            s.runningArchive[cur.claudeSessionId] = {
              ...cur,
              messages: cur.messages.map((m) => ({
                ...m,
                toolCalls: m.toolCalls.map((tc) => ({ ...tc })),
                fileChanges: [...m.fileChanges],
              })),
            };
            archivedSid = cur.claudeSessionId;
          });
          return archivedSid;
        },
        restoreArchive: (tabId, claudeSessionId) => {
          let ok = false;
          set((s) => {
            const archived = s.runningArchive[claudeSessionId];
            if (!archived) return;
            const cur = s.sessions[tabId];
            if (!cur) return;
            // Preserve per-tab UI prefs that don't belong to the thread.
            s.sessions[tabId] = {
              ...archived,
              id: tabId,
              useClaude: cur.useClaude,
              claudePermissionMode: cur.claudePermissionMode,
            } as ChatSession;
            delete s.runningArchive[claudeSessionId];
            ok = true;
          });
          return ok;
        },
        dropArchive: (claudeSessionId) =>
          set((s) => {
            delete s.runningArchive[claudeSessionId];
          }),
        updateArchivedAssistant: (claudeSessionId, content) =>
          set((s) => {
            const a = s.runningArchive[claudeSessionId];
            if (!a) return;
            for (let i = a.messages.length - 1; i >= 0; i--) {
              if (a.messages[i].role === "assistant") {
                a.messages[i].content = content;
                a.updatedAt = new Date().toISOString();
                return;
              }
            }
          }),
        appendArchivedToolCall: (claudeSessionId, toolName, input) =>
          set((s) => {
            const a = s.runningArchive[claudeSessionId];
            if (!a) return;
            for (let i = a.messages.length - 1; i >= 0; i--) {
              if (a.messages[i].role === "assistant") {
                a.messages[i].toolCalls.push({
                  id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  toolName,
                  arguments: input,
                  result: null,
                  status: "completed",
                  duration: null,
                });
                a.updatedAt = new Date().toISOString();
                return;
              }
            }
          }),
        setArchivedStatus: (claudeSessionId, status) =>
          set((s) => {
            const a = s.runningArchive[claudeSessionId];
            if (a) a.status = status;
          }),
        setArchivedTitle: (claudeSessionId, title) =>
          set((s) => {
            const a = s.runningArchive[claudeSessionId];
            if (a) a.title = title;
          }),
        setSessionStreamId: (sessionId, streamId) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.streamId = streamId;
          }),
        setArchivedStreamId: (claudeSessionId, streamId) =>
          set((s) => {
            const a = s.runningArchive[claudeSessionId];
            if (a) a.streamId = streamId;
          }),
      },
    }))
  )
);
