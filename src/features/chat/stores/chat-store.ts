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
import type { PendingPermission } from "@/types/acp";
import type { AgentDelta, ToolCall as AgentToolCall } from "@/types/agents";

/** Convert an atlas-agents wire ToolCall into the in-store ChatMessage shape. */
function toChatToolCall(tc: AgentToolCall): ChatMessage["toolCalls"][number] {
  return {
    id: tc.id,
    toolName: tc.tool_name,
    arguments: (tc.arguments ?? {}) as Record<string, unknown>,
    result: tc.result,
    status:
      tc.status === "pending"
        ? "pending"
        : tc.status === "running"
          ? "running"
          : tc.status === "failed"
            ? "failed"
            : "completed",
    duration: null,
  };
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
  activeSessionId: string | null;
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
    setTranscriptLoading: (sessionId: string, loading: boolean) => void;
    clearSession: (sessionId: string) => void;
    removeSession: (sessionId: string) => void;
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
    enqueueMessage: (sessionId: string, text: string) => void;
    removeQueueItem: (sessionId: string, index: number) => void;
    editQueueItem: (sessionId: string, index: number, text: string) => void;
    shiftQueue: (sessionId: string) => string | null;
    clearQueue: (sessionId: string) => void;
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
    /**
     * Apply an `atlas:agents` SessionDelta from the Rust-side manager. This
     * is the single bridge between the Rust SessionState and the chat-store —
     * status/turn lifecycle, text/thinking chunks, tool-call upserts, plan
     * updates, mode/model changes, available_commands. Permission requests
     * flow through `pushPermission` from the App.tsx listener.
     */
    applyAgentDelta: (env: AgentDelta) => void;
    /**
     * RAF-coalesced fast path for streaming text. Called by the global ACP
     * listener once per animation frame instead of per chunk.
     */
    appendAssistantText: (acpSessionId: string, text: string) => void;
    /** RAF-coalesced fast path for `agent_thought_chunk`. */
    appendAssistantThought: (acpSessionId: string, text: string) => void;
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

let messageCounter = 0;
function nextMessageId(): string {
  messageCounter += 1;
  return `msg-${Date.now()}-${messageCounter.toString(36)}`;
}

function makeAssistantTextMessage(content: string): ChatMessage {
  return {
    id: nextMessageId(),
    role: "assistant",
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: new Date().toISOString(),
    mode: "text",
  };
}

function makeAssistantThinkingMessage(thinking: string): ChatMessage {
  return {
    id: nextMessageId(),
    role: "assistant",
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: new Date().toISOString(),
    mode: "thinking",
    thinking,
  };
}

function makeAssistantToolMessage(toolCall: ChatMessage["toolCalls"][number]): ChatMessage {
  return {
    id: nextMessageId(),
    role: "assistant",
    content: "",
    toolCalls: [toolCall],
    fileChanges: [],
    plan: null,
    timestamp: new Date().toISOString(),
    mode: "tool",
  };
}

/** Find the message + tool call entry across all messages by toolCallId. */
function findToolCall(
  session: ChatSession,
  toolCallId: string
): { msg: ChatMessage; tc: ChatMessage["toolCalls"][number] } | null {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    const tc = m.toolCalls.find((t) => t.id === toolCallId);
    if (tc) return { msg: m, tc };
  }
  return null;
}

export const useChatStore = createSelectors(
  create<ChatState & ChatActions>()(
    immer((set) => ({
      sessions: {},
      pendingPermissions: {},
      queues: {},
      activeSessionId: null,
      actions: {
        createSession: (tabId) =>
          set((s) => {
            if (s.sessions[tabId]) return;
            s.sessions[tabId] = {
              id: tabId,
              title: "New Chat",
              messages: [],
              agentType: "claude-code",
              model: "",
              status: "idle",
              workingDirectory: "",
              tasks: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
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
            if (role === "user") {
              if (!session.firstUserContent) session.firstUserContent = content;
              session.userMessageCount = (session.userMessageCount ?? 0) + 1;
            }
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
        setTranscriptLoading: (sessionId, loading) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) session.transcriptLoading = loading;
          }),
        clearSession: (sessionId) =>
          set((s) => {
            const session = s.sessions[sessionId];
            if (session) {
              session.messages = [];
              session.tasks = [];
              session.status = "idle";
              session.acpAgentId = undefined;
              session.acpSessionId = undefined;
              session.title = "New Chat";
              session.firstUserContent = undefined;
              session.userMessageCount = 0;
            }
            delete s.queues[sessionId];
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
            // Recompute the cached preview/count from the loaded transcript
            // so the sidebar doesn't have to scan messages on every chunk.
            session.firstUserContent =
              messages.find((m) => m.role === "user")?.content;
            session.userMessageCount = messages.reduce(
              (n, m) => n + (m.role === "user" ? 1 : 0),
              0
            );
            // Intentionally NOT touching `updatedAt`. This action is called
            // when loading a historical transcript from disk into a tab —
            // viewing isn't activity, so it shouldn't bump the sort order
            // in the sidebar. Real activity (addMessage, applyAcpEvent's
            // streaming chunks, etc.) bumps it elsewhere.
          }),
        removeSession: (sessionId) =>
          set((s) => {
            delete s.sessions[sessionId];
            if (s.activeSessionId === sessionId) {
              const keys = Object.keys(s.sessions);
              s.activeSessionId = keys.length > 0 ? keys[0] : null;
            }
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

        appendAssistantText: (acpSessionId, text) =>
          set((s) => {
            if (!text) return;
            const tid = findTabByAcpSession(s.sessions, acpSessionId);
            if (!tid) return;
            const session = s.sessions[tid];
            const last = session.messages[session.messages.length - 1];
            // Append into the trailing text-mode message; otherwise start a
            // new one so a preceding tool/thinking block isn't merged with
            // unrelated narration.
            //
            // NOTE: deliberately not bumping `updatedAt` here. Streaming
            // chunks fire dozens of times per second; touching `updatedAt`
            // each time used to invalidate the sidebar's `hasRunning`/sort
            // memos and re-render every top-level chat consumer per chunk.
            // The sidebar sort still updates correctly via `addMessage`
            // (user send) and the turn-end status flip.
            if (
              last &&
              last.role === "assistant" &&
              (last.mode === "text" || last.mode === undefined) &&
              last.toolCalls.length === 0
            ) {
              last.content += text;
              return;
            }
            session.messages.push(makeAssistantTextMessage(text));
          }),
        appendAssistantThought: (acpSessionId, text) =>
          set((s) => {
            if (!text) return;
            const tid = findTabByAcpSession(s.sessions, acpSessionId);
            if (!tid) return;
            const session = s.sessions[tid];
            const last = session.messages[session.messages.length - 1];
            if (last && last.role === "assistant" && last.mode === "thinking") {
              last.thinking = (last.thinking ?? "") + text;
              return;
            }
            session.messages.push(makeAssistantThinkingMessage(text));
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
        applyAgentDelta: (env) =>
          set((s) => {
            const tid = findTabByAcpSession(s.sessions, env.session_id);
            if (!tid) return;
            const session = s.sessions[tid];
            switch (env.kind) {
              case "status": {
                session.status =
                  env.status === "idle"
                    ? "idle"
                    : env.status === "running"
                      ? "running"
                      : env.status === "waiting"
                        ? "waiting"
                        : "error";
                return;
              }
              case "turn_finished": {
                // Empty-turn detection: if no assistant content arrived
                // between the last user message and turn-end, insert a
                // placeholder so the UI doesn't show a vanishing spinner.
                let lastUserIdx = -1;
                for (let i = session.messages.length - 1; i >= 0; i--) {
                  if (session.messages[i].role === "user") {
                    lastUserIdx = i;
                    break;
                  }
                }
                const responded = session.messages
                  .slice(lastUserIdx + 1)
                  .some(
                    (m) =>
                      m.role === "assistant" &&
                      ((m.content && m.content.length > 0) ||
                        m.toolCalls.length > 0 ||
                        (m.thinking && m.thinking.length > 0))
                  );
                if (!responded && env.stop_reason !== "cancelled") {
                  const label =
                    env.stop_reason === "end_turn"
                      ? "(no response — the agent ended its turn without output)"
                      : `(no response — stop_reason: ${env.stop_reason})`;
                  session.messages.push(makeAssistantTextMessage(label));
                }
                session.status =
                  env.stop_reason === "end_turn" ||
                  env.stop_reason === "cancelled"
                    ? "idle"
                    : "error";
                return;
              }
              case "turn_failed": {
                session.messages.push(
                  makeAssistantTextMessage(`ACP error: ${env.error}`)
                );
                session.status = "error";
                return;
              }
              case "text_chunk": {
                // Rust pre-decides "new message vs append" — every text_chunk
                // refers to the trailing text-mode assistant message. We just
                // append; MessageAppended events handle the "new message"
                // case ahead of this.
                const last = session.messages[session.messages.length - 1];
                if (
                  last &&
                  last.role === "assistant" &&
                  (last.mode === "text" || last.mode === undefined) &&
                  last.toolCalls.length === 0
                ) {
                  last.content += env.delta;
                } else {
                  session.messages.push(makeAssistantTextMessage(env.delta));
                }
                return;
              }
              case "thinking_chunk": {
                const last = session.messages[session.messages.length - 1];
                if (last && last.role === "assistant" && last.mode === "thinking") {
                  last.thinking = (last.thinking ?? "") + env.delta;
                } else {
                  session.messages.push(makeAssistantThinkingMessage(env.delta));
                }
                return;
              }
              case "message_appended": {
                // Convert the Rust-shaped message into a ChatMessage and push.
                // Rust already decided this is a new message; the frontend
                // mirrors without re-deciding.
                const m = env.message;
                session.messages.push({
                  id: m.id,
                  role: m.role,
                  content: m.content,
                  thinking: m.thinking ?? "",
                  toolCalls: m.tool_calls.map(toChatToolCall),
                  fileChanges: [],
                  plan: m.plan
                    ? m.plan.map((e, idx) => ({
                        id: `plan-${idx}`,
                        description: e.content,
                        status:
                          (e.status as "pending" | "in_progress" | "completed") ??
                          "pending",
                      }))
                    : null,
                  timestamp: m.timestamp,
                  mode: m.mode,
                });
                return;
              }
              case "tool_call_upserted": {
                const found = findToolCall(session, env.tool_call.id);
                if (found) {
                  Object.assign(found.tc, toChatToolCall(env.tool_call));
                  return;
                }
                session.messages.push(
                  makeAssistantToolMessage(toChatToolCall(env.tool_call))
                );
                return;
              }
              case "plan_updated": {
                const last = session.messages[session.messages.length - 1];
                const planSteps = env.plan.map((e, idx) => ({
                  id: `plan-${idx}`,
                  description: e.content,
                  status:
                    (e.status as "pending" | "in_progress" | "completed") ??
                    "pending",
                }));
                if (last && last.role === "assistant") {
                  last.plan = planSteps;
                } else {
                  const fresh = makeAssistantTextMessage("");
                  fresh.plan = planSteps;
                  session.messages.push(fresh);
                }
                return;
              }
              case "available_commands": {
                session.availableCommands = env.commands;
                return;
              }
              case "mode_changed": {
                session.acpCurrentMode = env.mode_id;
                return;
              }
              case "model_changed": {
                session.acpCurrentModel = env.model_id;
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
