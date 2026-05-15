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
import type { AcpEventEnvelope, PendingPermission } from "@/types/acp";

interface ProviderConfig {
  provider: "anthropic" | "openai" | "google";
  model: string;
  apiKey: string;
  system: string;
}

interface ChatState {
  sessions: Record<string, ChatSession>;
  /**
   * Pending ACP permission requests, keyed by acpSessionId. Each list is
   * FIFO — the modal renders the head. Cleared on respond / agent_disconnect.
   */
  pendingPermissions: Record<string, PendingPermission[]>;
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
    // ── ACP bindings ────────────────────────────────────────────────────
    setAcpBinding: (
      tabId: string,
      agentId: string,
      acpSessionId: string
    ) => void;
    /**
     * Apply one `atlas:acp` event to whichever chat tab owns its acpSessionId.
     * Phase-1 handles `agent_message_chunk` (text) and `tool_call`; everything
     * else is silently ignored until phase-2 widgets land.
     */
    applyAcpEvent: (env: AcpEventEnvelope) => void;
    pushPermission: (req: PendingPermission) => void;
    popPermission: (acpSessionId: string, requestId: string) => void;
    clearPermissionsForAgent: (agentId: string) => void;
  };
}

function findTabByAcpSession(
  sessions: Record<string, ChatSession>,
  acpSessionId: string
): string | null {
  for (const [tid, s] of Object.entries(sessions)) {
    if (s.acpSessionId === acpSessionId) return tid;
  }
  return null;
}

/**
 * The canonical Claude Code agent sometimes ships `input` as a stringified JSON
 * blob, sometimes as a real object. Normalise to a plain record.
 */
function parseToolInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { raw };
    } catch {
      return { raw };
    }
  }
  return {};
}

/**
 * ACP tool_call_update `content` is `Vec<ToolCallContent>` — text chunks,
 * diffs, terminals. Format it as a single readable string for the existing
 * ToolCallCard "result" display. Returns null when there's nothing to add.
 */
function formatToolContent(content: unknown): string | null {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => formatToolContent(item))
      .filter((s): s is string => s !== null && s.length > 0);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (typeof content === "object") {
    const o = content as Record<string, unknown>;
    if (typeof o.content === "object" || typeof o.content === "string") {
      const inner = formatToolContent(o.content);
      if (inner !== null) return inner;
    }
    if (typeof o.text === "string") return o.text;
    if (typeof o.output === "string") return o.output;
    if (typeof o.path === "string" && (o.oldText || o.newText)) {
      // Best-effort diff summary.
      return `${o.path}`;
    }
  }
  return null;
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
      pendingPermissions: {},
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
        setAcpBinding: (tabId, agentId, acpSessionId) =>
          set((s) => {
            const session = s.sessions[tabId];
            if (!session) return;
            session.acpAgentId = agentId;
            session.acpSessionId = acpSessionId;
          }),
        pushPermission: (req) =>
          set((s) => {
            const list = s.pendingPermissions[req.acpSessionId] ?? [];
            s.pendingPermissions[req.acpSessionId] = [...list, req];
          }),
        popPermission: (acpSessionId, requestId) =>
          set((s) => {
            const list = s.pendingPermissions[acpSessionId];
            if (!list) return;
            const next = list.filter((r) => r.requestId !== requestId);
            if (next.length === 0) delete s.pendingPermissions[acpSessionId];
            else s.pendingPermissions[acpSessionId] = next;
          }),
        clearPermissionsForAgent: (agentId) =>
          set((s) => {
            for (const sid of Object.keys(s.pendingPermissions)) {
              const list = s.pendingPermissions[sid].filter(
                (r) => r.agentId !== agentId
              );
              if (list.length === 0) delete s.pendingPermissions[sid];
              else s.pendingPermissions[sid] = list;
            }
          }),
        applyAcpEvent: (env) =>
          set((s) => {
            if (env.kind !== "session_update") return;
            const tid = findTabByAcpSession(s.sessions, env.session_id);
            if (!tid) return;
            const session = s.sessions[tid];
            const update = env.update;

            switch (update.sessionUpdate) {
              case "agent_message_chunk": {
                const block = update.content;
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  block.type === "text" &&
                  "text" in block &&
                  typeof block.text === "string"
                ) {
                  // Append chunk to the trailing assistant message.
                  for (let i = session.messages.length - 1; i >= 0; i--) {
                    if (session.messages[i].role === "assistant") {
                      session.messages[i].content += block.text;
                      session.updatedAt = new Date().toISOString();
                      return;
                    }
                  }
                }
                return;
              }
              case "tool_call": {
                for (let i = session.messages.length - 1; i >= 0; i--) {
                  if (session.messages[i].role === "assistant") {
                    session.messages[i].toolCalls.push({
                      id: update.toolCallId,
                      toolName: update.title ?? update.kind ?? "tool",
                      arguments: parseToolInput(update.input),
                      result: null,
                      status:
                        update.status === "completed"
                          ? "completed"
                          : update.status === "failed"
                            ? "failed"
                            : "running",
                      duration: null,
                    });
                    session.updatedAt = new Date().toISOString();
                    return;
                  }
                }
                return;
              }
              case "tool_call_update": {
                for (let i = session.messages.length - 1; i >= 0; i--) {
                  if (session.messages[i].role === "assistant") {
                    const tc = session.messages[i].toolCalls.find(
                      (t) => t.id === update.toolCallId
                    );
                    if (!tc) return;
                    if (typeof update.status === "string") {
                      tc.status =
                        update.status === "completed"
                          ? "completed"
                          : update.status === "failed"
                            ? "failed"
                            : update.status === "in_progress"
                              ? "running"
                              : tc.status;
                    }
                    const formatted = formatToolContent(update.content);
                    if (formatted !== null) {
                      tc.result = tc.result
                        ? tc.result + formatted
                        : formatted;
                    }
                    session.updatedAt = new Date().toISOString();
                    return;
                  }
                }
                return;
              }
              case "plan": {
                // Attach plan to the trailing assistant message. Entries map
                // 1:1 to our internal PlanStep shape.
                for (let i = session.messages.length - 1; i >= 0; i--) {
                  if (session.messages[i].role === "assistant") {
                    session.messages[i].plan = update.entries.map(
                      (e, idx) => ({
                        id: `plan-${idx}`,
                        description: e.content,
                        status: e.status,
                      })
                    );
                    session.updatedAt = new Date().toISOString();
                    return;
                  }
                }
                return;
              }
              case "available_commands_update": {
                session.availableCommands = update.availableCommands;
                return;
              }
              case "current_mode_update": {
                session.acpCurrentMode = update.currentModeId;
                return;
              }
              case "current_model_update": {
                session.acpCurrentModel = update.currentModelId;
                return;
              }
              default:
                return;
            }
          }),
      },
    }))
  )
);
