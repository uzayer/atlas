import { useMemo } from "react";
import { Inbox, Loader2, CheckCircle2, AlertCircle, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "../stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";

interface InboxItem {
  sessionId: string;
  sessionTitle: string;
  status: "running" | "done" | "error" | "idle";
  lastMessageRole: "user" | "assistant" | null;
  lastMessageContent: string;
  lastUpdated: string;
  claudeSessionId?: string;
}

function statusIcon(status: InboxItem["status"]) {
  if (status === "running")
    return <Loader2 size={11} className="animate-spin text-[var(--accent-primary)]" />;
  if (status === "error")
    return <AlertCircle size={11} className="text-[var(--status-error)]" />;
  if (status === "done")
    return <CheckCircle2 size={11} className="text-[var(--status-success)]" />;
  return <MessageSquare size={11} className="text-[var(--text-tertiary)]" />;
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function InboxPanel({ onClose }: { onClose: () => void }) {
  const sessions = useChatStore.use.sessions();
  const { setActiveTab } = useLayoutStore.use.actions();

  const items = useMemo<InboxItem[]>(() => {
    return Object.values(sessions)
      .map((s) => {
        const last = s.messages[s.messages.length - 1];
        return {
          sessionId: s.id,
          sessionTitle: s.title || "Untitled",
          status: s.status as InboxItem["status"],
          lastMessageRole: last ? (last.role as "user" | "assistant") : null,
          lastMessageContent: last?.content ?? "",
          lastUpdated: s.updatedAt,
          claudeSessionId: s.claudeSessionId,
        };
      })
      .sort((a, b) => (b.lastUpdated > a.lastUpdated ? 1 : -1));
  }, [sessions]);

  const grouped = useMemo(() => {
    const running = items.filter((i) => i.status === "running");
    const error = items.filter((i) => i.status === "error");
    const rest = items.filter((i) => i.status !== "running" && i.status !== "error");
    return { running, error, rest };
  }, [items]);

  const handleOpen = (item: InboxItem) => {
    setActiveTab(item.sessionId);
    onClose();
  };

  const renderSection = (label: string, list: InboxItem[]) => {
    if (list.length === 0) return null;
    return (
      <div className="py-1">
        <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-[var(--text-tertiary)]">
          {label}
        </div>
        {list.map((item) => (
          <button
            key={item.sessionId}
            onClick={() => handleOpen(item)}
            className={cn(
              "w-full text-left px-3 py-1.5 flex items-start gap-2",
              "hover:bg-[var(--bg-hover)] transition-colors"
            )}
          >
            <span className="mt-0.5 shrink-0">{statusIcon(item.status)}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-[var(--text-primary)] truncate">
                  {item.sessionTitle}
                </span>
                <span className="text-[9px] text-[var(--text-tertiary)] shrink-0">
                  {timeAgo(item.lastUpdated)}
                </span>
              </div>
              {item.lastMessageContent && (
                <div className="text-[10px] text-[var(--text-tertiary)] truncate">
                  {item.lastMessageRole === "user" ? "› " : ""}
                  {item.lastMessageContent.replace(/\n/g, " ").slice(0, 80)}
                </div>
              )}
            </div>
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="w-[320px] max-h-[420px] flex flex-col">
      <div className="flex items-center gap-2 px-3 h-[32px] border-b border-[var(--border-default)]">
        <Inbox size={12} className="text-[var(--text-tertiary)]" />
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          Inbox
        </span>
        <span className="text-[10px] text-[var(--text-tertiary)] ml-auto">
          {items.length} {items.length === 1 ? "session" : "sessions"}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto hide-scrollbar">
        {items.length === 0 ? (
          <div className="px-3 py-6 text-[11px] text-[var(--text-tertiary)] text-center">
            No active sessions. Start a chat to see tasks here.
          </div>
        ) : (
          <>
            {renderSection("Running", grouped.running)}
            {renderSection("Failed", grouped.error)}
            {renderSection("Recent", grouped.rest)}
          </>
        )}
      </div>
    </div>
  );
}
