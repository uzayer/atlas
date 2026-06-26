import type { SessionMessage } from "@/types/agents";

/**
 * Map an atlas-agents `SessionMessage` (the rich Rust snapshot state returned by
 * `agents.snapshot()`) onto the wire shape `chat-store.replaceMessages` expects.
 *
 * Shared by the history sidebar (`session-sidebar.tsx`) and `openAgentSession`
 * (`open-agent-session.ts`) so the two resume/hydrate paths stay byte-identical —
 * previously each kept its own copy and they could drift.
 *
 * Carries `result` through so a resumed transcript shows each tool call's output
 * instead of an empty card (the snapshot persists it as `ToolCall.result`).
 */
export function snapshotMessageToWire(m: SessionMessage) {
  return {
    role: m.role === "system" ? ("system" as const) : m.role,
    content: m.content,
    timestamp: m.timestamp,
    toolCalls: m.tool_calls.map((tc) => ({
      toolName: tc.tool_name,
      kind: tc.kind ?? null,
      arguments: (tc.arguments ?? {}) as Record<string, unknown>,
      result: tc.result ?? null,
    })),
  };
}
