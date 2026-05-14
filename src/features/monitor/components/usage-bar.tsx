import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { BarChart3, Zap, Clock } from "lucide-react";
import { useUsageStore } from "../stores/usage-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { getClaudeSessionStats } from "@/features/chat/lib/claude-api";

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function UsageBar() {
  const inputTokensFallback = useUsageStore.use.inputTokens();
  const outputTokensFallback = useUsageStore.use.outputTokens();
  const totalCostFallback = useUsageStore.use.totalCost();
  const requestCountFallback = useUsageStore.use.requestCount();
  const sessionStart = useUsageStore.use.sessionStart();
  const [expanded, setExpanded] = useState(false);

  const activeTabId = useLayoutStore.use.activeTabId();
  const tabs = useLayoutStore.use.tabs();
  const sessions = useChatStore.use.sessions();
  const project = useProjectStore.use.currentProject();

  // Detect the active Claude Code session (only when the active tab is a chat in agent mode with a captured session id)
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const chatSession = activeTab?.type === "chat" ? sessions[activeTab.id] : undefined;
  const claudeSessionId =
    chatSession?.useClaude && chatSession.claudeSessionId ? chatSession.claudeSessionId : null;
  const cwd = project?.path ?? "";

  const queryClient = useQueryClient();
  const queryKey = ["claude-session-stats", cwd, claudeSessionId] as const;

  const { data: stats } = useQuery({
    queryKey,
    queryFn: () => getClaudeSessionStats(cwd, claudeSessionId as string),
    enabled: !!claudeSessionId && cwd.length > 0,
    staleTime: 2_000,
  });

  // Refresh stats during the stream, throttled, plus an immediate invalidate on done.
  useEffect(() => {
    let pendingInvalidate: number | null = null;
    const schedule = () => {
      if (pendingInvalidate !== null) return;
      pendingInvalidate = window.setTimeout(() => {
        pendingInvalidate = null;
        queryClient.invalidateQueries({ queryKey });
      }, 1500);
    };
    const p = listen<{ event_type: string }>("claude-stream", (e) => {
      const t = e.payload.event_type;
      if (t === "done") {
        if (pendingInvalidate !== null) {
          window.clearTimeout(pendingInvalidate);
          pendingInvalidate = null;
        }
        queryClient.invalidateQueries({ queryKey });
      } else if (t === "text" || t === "tool_use" || t === "session") {
        schedule();
      }
    });
    return () => {
      if (pendingInvalidate !== null) window.clearTimeout(pendingInvalidate);
      p.then((u) => u());
    };
  }, [queryClient, queryKey]);

  const display = useMemo(() => {
    if (claudeSessionId && stats) {
      return {
        inputTokens: stats.input_tokens,
        outputTokens: stats.output_tokens,
        cacheCreation: stats.cache_creation_tokens,
        cacheRead: stats.cache_read_tokens,
        totalCost: stats.total_cost_usd,
        requestCount: stats.request_count,
        model: stats.model,
        source: "claude" as const,
      };
    }
    return {
      inputTokens: inputTokensFallback,
      outputTokens: outputTokensFallback,
      cacheCreation: 0,
      cacheRead: 0,
      totalCost: totalCostFallback,
      requestCount: requestCountFallback,
      model: null as string | null,
      source: "provider" as const,
    };
  }, [
    claudeSessionId,
    stats,
    inputTokensFallback,
    outputTokensFallback,
    totalCostFallback,
    requestCountFallback,
  ]);

  const totalTokens = display.inputTokens + display.outputTokens + display.cacheCreation + display.cacheRead;
  const elapsed = Math.floor((Date.now() - sessionStart) / 60000);

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors font-mono cursor-pointer"
      >
        <Zap size={10} className="text-accent" />
        <span>{formatCount(totalTokens)} tokens</span>
        <span>·</span>
        <span>{display.requestCount} calls</span>
        <span>·</span>
        <span>${display.totalCost.toFixed(4)}</span>
        {display.model && (
          <>
            <span>·</span>
            <span className="truncate max-w-[120px]" title={display.model}>{display.model}</span>
          </>
        )}
      </button>

      {expanded && (
        <div
          className="absolute bottom-full right-0 mb-2 w-[280px] rounded-lg border border-border-default bg-bg-secondary shadow-lg p-3 space-y-2"
          style={{ zIndex: "var(--z-max)" as unknown as number }}
        >
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-secondary">
            <BarChart3 size={12} />
            {display.source === "claude" ? "Claude Code Session" : "Session Usage"}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <UsageStat label="Input" value={display.inputTokens.toLocaleString()} />
            <UsageStat label="Output" value={display.outputTokens.toLocaleString()} />
            {display.source === "claude" && (
              <>
                <UsageStat label="Cache write" value={display.cacheCreation.toLocaleString()} />
                <UsageStat label="Cache read" value={display.cacheRead.toLocaleString()} />
              </>
            )}
            <UsageStat label="Requests" value={String(display.requestCount)} />
            <UsageStat label="Cost" value={`$${display.totalCost.toFixed(4)}`} />
          </div>

          {display.model && (
            <div className="text-[9px] font-mono text-text-tertiary truncate" title={display.model}>
              model: {display.model}
            </div>
          )}

          <div className="flex items-center gap-1 text-[9px] text-text-tertiary pt-1 border-t border-border-subtle">
            <Clock size={9} />
            {display.source === "claude" ? "Live from .jsonl" : `Session: ${elapsed}m`}
          </div>
        </div>
      )}
    </div>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border-default bg-bg-primary px-2 py-1">
      <div className="text-[11px] font-mono text-text-primary">{value}</div>
      <div className="text-[8px] text-text-tertiary uppercase tracking-wide">{label}</div>
    </div>
  );
}
