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
import { splitAtlasContext } from "../lib/atlas-context";
import { invoke } from "@tauri-apps/api/core";
import { extractPlanMarkdown, type PlanRecord } from "../lib/plans";

/** Convert an atlas-agents wire ToolCall into the in-store ChatMessage shape. */
function toChatToolCall(tc: AgentToolCall): ChatMessage["toolCalls"][number] {
  return {
    id: tc.id,
    toolName: tc.tool_name,
    // Preserve the ACP `kind` so bash/execute calls can be recognised
    // reliably (the bash-history panel + bash-styled cards key off it).
    kind: tc.kind ?? null,
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
  /**
   * Per-tab composer draft. Mirrors the CodeMirror text body so a tab
   * switch (which unmounts MessageInput) doesn't drop what the user was
   * typing. Cleared on submit. Plain text only — mentions live in the
   * editor's document and rebind to fresh chip nodes when the draft
   * reloads on remount.
   */
  drafts: Record<string, string>;
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
    /** Drop all chat sessions, queues, and pending permissions. Used when
     *  the user switches projects so dead acpSessionIds from the old
     *  project's `.atlas/` don't linger and cause ghost-bound tabs. */
    resetSessions: () => void;
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
        toolCalls?: Array<{
          toolName: string;
          kind?: string | null;
          arguments: Record<string, unknown>;
        }>;
      }>
    ) => void;
    /** Mirror the composer's plain text into the per-tab draft slot. */
    setDraft: (tabId: string, text: string) => void;
    /** Drop a draft (on submit, or when its tab closes). */
    clearDraft: (tabId: string) => void;
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
    /**
     * Apply a frame's worth of buffered events in a SINGLE immer pass.
     * On a "read 30 files" turn the adapter emits ~60 `tool_call` /
     * `tool_call_update` events plus a stream of text chunks. Calling
     * `applyAgentDelta` (which is its own `set(...)`) per event paid an
     * immer snapshot + subscriber notification per event — at 60 events
     * that's 60 full structural-share passes over `s.sessions[tid]`
     * and 60 `MessagesList` re-renders with `measureElement` work.
     * Batching collapses that to 1 immer pass + 1 re-render per frame.
     *
     * The caller (App.tsx::listenAgents) is expected to:
     *  - Dedupe `tool_call_upserted` by `(session, tool_call.id)` so
     *    only the latest state for each tool call lands.
     *  - Pass text/thought as merged-per-session strings (same as the
     *    old per-event RAF flush did).
     *  - Pass other deltas in wire order — they're applied verbatim.
     */
    applyAgentBatch: (batch: {
      texts: Array<{ sessionId: string; text: string }>;
      thoughts: Array<{ sessionId: string; text: string }>;
      deltas: AgentDelta[];
    }) => void;
    pushPermission: (req: PendingPermission) => void;
    popPermission: (acpSessionId: string, requestId: string) => void;
    clearPermissionsForAgent: (agentId: string) => void;
    /** Drop every pending permission for a specific ACP session.
     *  Called on Stop so a modal left over from the cancelled turn
     *  doesn't linger and trick the user into clicking Allow on a
     *  request the agent already abandoned. */
    clearPermissionsForSession: (acpSessionId: string) => void;
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
 * When a permission request carries a plan (Claude Code ExitPlanMode), persist
 * it to the per-project plans store together with the user message that
 * triggered it and a timestamp. Fire-and-forget; never blocks the permission
 * UI. Rust dedups by (session, plan) so a re-delivered permission is a no-op.
 */
async function capturePlanIfPresent(
  req: PendingPermission,
  sessions: Record<string, ChatSession>
): Promise<void> {
  const plan = extractPlanMarkdown(req.toolCall);
  if (!plan) return;

  const tabId = findTabByAcpSession(sessions, req.acpSessionId);
  const session = tabId ? sessions[tabId] : undefined;

  // Original user message = the most recent user message in the session.
  // Prefer the clean prose (atlas-context wrapper stripped) for display.
  let userMessage = "";
  if (session) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.role === "user") {
        userMessage = m.atlasProse ?? m.content;
        break;
      }
    }
  }

  const { useProjectStore } = await import(
    "@/features/project/stores/project-store"
  );
  const projectPath = useProjectStore.getState().currentProject?.path;
  if (!projectPath) return;

  const record: PlanRecord = {
    id: `plan-${req.requestId}`,
    sessionId: req.acpSessionId ?? null,
    sessionTitle: session?.title ?? null,
    userMessage,
    plan,
    timestamp: new Date().toISOString(),
  };

  try {
    await invoke("plans_append", { projectPath, record });
    // Let an open Plans panel refresh without re-opening.
    window.dispatchEvent(new CustomEvent("atlas:plan-saved"));
  } catch {
    /* non-fatal — persistence failure shouldn't affect the permission flow */
  }
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
    immer((set, get) => ({
      sessions: {},
      pendingPermissions: {},
      queues: {},
      drafts: {},
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
            // Pre-split for user-composed messages so MessageItem
            // doesn't run regex on every render. No-op for assistant /
            // system messages (they don't carry the Atlas-context
            // suffix).
            const split = role === "user" ? splitAtlasContext(content) : null;
            const msg: ChatMessage = {
              id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              role,
              content,
              toolCalls: [],
              fileChanges: [],
              plan: null,
              timestamp: new Date().toISOString(),
              ...(split && split.context !== null
                ? {
                    atlasProse: split.prose,
                    atlasContext: split.context,
                    atlasContextBlockCount: split.blockCount,
                  }
                : {}),
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
                  kind: null,
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
            session.messages = messages.map((m, i) => {
              const split = m.role === "user" ? splitAtlasContext(m.content) : null;
              return {
                id: `msg-${Date.now()}-${i}`,
                role: m.role,
                content: m.content,
                toolCalls: (m.toolCalls ?? []).map((tc, j) => ({
                  id: `tc-${Date.now()}-${i}-${j}`,
                  toolName: tc.toolName,
                  kind: tc.kind ?? null,
                  arguments: tc.arguments,
                  result: null,
                  status: "completed" as const,
                  duration: null,
                })),
                fileChanges: [],
                plan: null,
                timestamp: m.timestamp ?? new Date().toISOString(),
                ...(split && split.context !== null
                  ? {
                      atlasProse: split.prose,
                      atlasContext: split.context,
                      atlasContextBlockCount: split.blockCount,
                    }
                  : {}),
              };
            });
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
            delete s.drafts[sessionId];
            if (s.activeSessionId === sessionId) {
              const keys = Object.keys(s.sessions);
              s.activeSessionId = keys.length > 0 ? keys[0] : null;
            }
          }),
        resetSessions: () =>
          set((s) => {
            s.sessions = {};
            s.queues = {};
            s.drafts = {};
            s.pendingPermissions = {};
            s.activeSessionId = null;
          }),
        setDraft: (tabId, text) =>
          set((s) => {
            if (text.length === 0) delete s.drafts[tabId];
            else s.drafts[tabId] = text;
          }),
        clearDraft: (tabId) =>
          set((s) => {
            delete s.drafts[tabId];
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
            appendTextToDraft(s, acpSessionId, text);
          }),
        appendAssistantThought: (acpSessionId, text) =>
          set((s) => {
            appendThoughtToDraft(s, acpSessionId, text);
          }),
        applyAgentBatch: ({ texts, thoughts, deltas }) =>
          set((s) => {
            // Single immer pass for everything buffered in this frame.
            // Order is: text → thoughts → deltas. Within deltas, wire
            // order is preserved by the caller (App.tsx's RAF flush);
            // `tool_call_upserted` events are deduped there before
            // arriving so we never apply the same tool-call id twice.
            for (const { sessionId, text } of texts) {
              appendTextToDraft(s, sessionId, text);
            }
            for (const { sessionId, text } of thoughts) {
              appendThoughtToDraft(s, sessionId, text);
            }
            for (const env of deltas) {
              applyDeltaToDraft(s, env);
            }
          }),
        setAcpBinding: (tabId, agentId, acpSessionId) =>
          set((s) => {
            const session = s.sessions[tabId];
            if (!session) return;
            session.acpAgentId = agentId;
            session.acpSessionId = acpSessionId;
          }),
        pushPermission: (req) => {
          set((s) => {
            const list = s.pendingPermissions[req.acpSessionId] ?? [];
            s.pendingPermissions[req.acpSessionId] = [...list, req];
          });
          // Persist the plan (if this permission carries one) for the Plans
          // panel — captures every plan made, even if later rejected.
          void capturePlanIfPresent(req, get().sessions);
        },
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
        clearPermissionsForSession: (acpSessionId) =>
          set((s) => {
            delete s.pendingPermissions[acpSessionId];
          }),
        applyAgentDelta: (env) =>
          set((s) => {
            applyDeltaToDraft(s, env);
          }),
      },
    }))
  )
);

// ── Draft-mutating helpers ────────────────────────────────────────────────
//
// The chat-store hot path applies AgentDeltas inside an immer draft. To
// support both the single-event `applyAgentDelta` and the RAF-coalesced
// `applyAgentBatch` (which runs many events in ONE immer pass for a
// large perf win on tool-heavy turns), the per-event logic lives in
// these standalone functions instead of being inlined into `set(...)`.
// They take the writable draft directly and mutate in place — no
// `set(...)` inside, no return value.

type ChatDraft = ChatState & ChatActions;

function appendTextToDraft(s: ChatDraft, acpSessionId: string, text: string): void {
  if (!text) return;
  const tid = findTabByAcpSession(s.sessions, acpSessionId);
  if (!tid) return;
  const session = s.sessions[tid];
  // Find the last message that actually renders something, skipping the
  // empty `thinking` markers claude-agent-acp emits between text chunks.
  // Without this, one continuous narration split by such a marker becomes
  // two text messages and the markdown between them (a bold span, a
  // sentence, even mid-word) parses as two broken fragments.
  let last: (typeof session.messages)[number] | undefined;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    const rendersNothing =
      !m.content?.trim() &&
      !m.thinking?.trim() &&
      m.toolCalls.length === 0 &&
      m.fileChanges.length === 0 &&
      !(m.plan && m.plan.length > 0);
    if (!rendersNothing) {
      last = m;
      break;
    }
  }
  // Append into the trailing text-mode message; otherwise start a new
  // one so a preceding tool/thinking block isn't merged with unrelated
  // narration.
  //
  // NOTE: deliberately not bumping `updatedAt` here. Streaming chunks
  // fire dozens of times per second; touching `updatedAt` each time
  // used to invalidate the sidebar's `hasRunning`/sort memos and
  // re-render every top-level chat consumer per chunk. The sidebar
  // sort still updates correctly via `addMessage` (user send) and the
  // turn-end status flip.
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
}

function appendThoughtToDraft(s: ChatDraft, acpSessionId: string, text: string): void {
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
}

function applyDeltaToDraft(s: ChatDraft, env: AgentDelta): void {
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
      // Resolve any tool calls still in pending/running state. After
      // Stop, the driver gate drops further updates from the agent
      // for this session, so an in-flight tool would otherwise spin
      // forever. Mark them failed so the user sees a clear terminal
      // state instead of a phantom loader.
      if (env.stop_reason === "cancelled") {
        for (const msg of session.messages) {
          for (const tc of msg.toolCalls) {
            if (tc.status === "pending" || tc.status === "running") {
              tc.status = "failed";
            }
          }
        }
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
      // append; MessageAppended events handle the "new message" case
      // ahead of this.
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
      // Collapse consecutive tool calls into ONE assistant message
      // so the thread doesn't render N separate message-item boxes
      // (each with its own padding) for every Find/Read/Bash the
      // agent emits in a single turn. If the trailing message is
      // already an assistant tool-mode message, just append the new
      // tool call to its `toolCalls` array; the MessageItem renders
      // all cards in one stacked group with tight internal
      // `space-y-1.5`. Only when the trailing message ISN'T a tool
      // message (text/thinking intervened) do we start a fresh tool
      // message.
      const last = session.messages[session.messages.length - 1];
      if (
        last &&
        last.role === "assistant" &&
        last.mode === "tool"
      ) {
        last.toolCalls.push(toChatToolCall(env.tool_call));
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
}
