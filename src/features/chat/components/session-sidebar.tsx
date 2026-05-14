import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  X,
  MessageSquare,
  Terminal,
  Search,
  PanelLeftClose,
  ListFilter,
  Plus,
  Loader2,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import {
  listClaudeSessions,
  readClaudeSession,
  deleteClaudeSession,
} from "../lib/claude-api";

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

type FilterKind = "all" | "agent" | "chat";

interface SidebarItem {
  id: string; // claudeSessionId for agent, tabId for chat
  kind: "agent" | "chat";
  title: string;
  subtitle: string | null;
  lastUpdated: string | null;
  messageCount: number;
  // agent-only
  filePath?: string;
  // chat-only
  tabId?: string;
}

interface SessionSidebarProps {
  tabId: string;
}

export function SessionSidebar({ tabId }: SessionSidebarProps) {
  const queryClient = useQueryClient();
  const project = useProjectStore.use.currentProject();
  const cwd = project?.path ?? "";

  const sessions = useChatStore.use.sessions();
  const activeSession = sessions[tabId];
  const activeClaudeId = activeSession?.claudeSessionId;

  const { replaceMessages, setClaudeSessionId, clearSession, setSessionTitle } =
    useChatStore.use.actions();

  const chatSidebar = useLayoutStore.use.chatSidebar();
  const { toggleChatSidebar, setChatSidebarWidth } = useLayoutStore.use.actions();

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");

  const queryKey = ["claude-sessions", cwd] as const;

  const runningArchive = useChatStore.use.runningArchive();
  // Refresh more frequently while any chat is actively streaming so the new
  // session's row appears (Claude Code writes the JSONL a tick after start).
  // Includes parked / archived sessions that are still running in background.
  const hasRunning = useMemo(
    () =>
      Object.values(sessions).some((s) => s.status === "running") ||
      Object.values(runningArchive).some((s) => s.status === "running"),
    [sessions, runningArchive]
  );
  const { data: agentList = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => listClaudeSessions(cwd),
    enabled: cwd.length > 0,
    staleTime: hasRunning ? 1_500 : 5_000,
    refetchInterval: hasRunning ? 1_500 : false,
  });

  useEffect(() => {
    const unlistenPromise = listen<{ event_type: string }>("claude-stream", (e) => {
      // `session` fires on the first event of each stream — refresh now so
      // a brand-new conversation pops into the sidebar with its running
      // spinner instead of waiting for the next 5s poll. `done` refreshes
      // again so titles / counts settle.
      if (e.payload.event_type === "session" || e.payload.event_type === "done") {
        queryClient.invalidateQueries({ queryKey });
      }
    });
    const onFocus = () => queryClient.invalidateQueries({ queryKey });
    window.addEventListener("focus", onFocus);
    return () => {
      unlistenPromise.then((u) => u());
      window.removeEventListener("focus", onFocus);
    };
  }, [queryClient, queryKey]);

  // Build the unified item list.
  const items = useMemo<SidebarItem[]>(() => {
    const agents: SidebarItem[] = agentList.map((s) => ({
      id: s.id,
      kind: "agent",
      title: s.preview,
      subtitle: null,
      lastUpdated: s.last_modified,
      messageCount: s.message_count,
      filePath: s.file_path,
    }));

    // Optimistic entries — agent sessions that are currently active in this
    // window but haven't appeared on disk yet (or haven't been polled in).
    // Surface them immediately so the live spinner is visible. We collect
    // from both the tab-bound sessions AND the background archive (parked
    // sessions that are still streaming after the user navigated away).
    const liveAgents = [
      ...Object.values(sessions).filter((s) => s.useClaude),
      ...Object.values(runningArchive),
    ];
    for (const s of liveAgents) {
      if (!s.claudeSessionId) continue;
      if (agents.some((a) => a.id === s.claudeSessionId)) continue;
      const firstUser = s.messages.find((m) => m.role === "user")?.content ?? "";
      agents.unshift({
        id: s.claudeSessionId,
        kind: "agent",
        title: s.title || firstUser.slice(0, 80) || "New session",
        subtitle: null,
        lastUpdated: s.updatedAt,
        messageCount: s.messages.filter((m) => m.role === "user").length,
        // filePath omitted — disk row will replace this once the JSONL is found.
      });
    }

    const chats: SidebarItem[] = Object.values(sessions)
      .filter((s) => !s.useClaude && s.messages.length > 0)
      .map((s) => ({
        id: s.id,
        kind: "chat",
        title: s.title || "Untitled chat",
        subtitle: null,
        lastUpdated: s.updatedAt,
        messageCount: s.messages.length,
        tabId: s.id,
      }));

    return [...agents, ...chats].sort((a, b) =>
      (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? "")
    );
  }, [agentList, sessions, runningArchive]);

  // Sessions currently running (used to show a spinner on the matching row).
  // Includes both tab-bound sessions and parked-in-background sessions.
  const runningKeys = useMemo(() => {
    const set = new Set<string>();
    for (const s of Object.values(sessions)) {
      if (s.status !== "running") continue;
      if (s.useClaude && s.claudeSessionId) set.add(`agent:${s.claudeSessionId}`);
      if (!s.useClaude) set.add(`chat:${s.id}`);
    }
    for (const s of Object.values(runningArchive)) {
      if (s.status === "running" && s.claudeSessionId) {
        set.add(`agent:${s.claudeSessionId}`);
      }
    }
    return set;
  }, [sessions, runningArchive]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (filter === "agent" && it.kind !== "agent") return false;
      if (filter === "chat" && it.kind !== "chat") return false;
      if (q && !it.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, filter, search]);

  const { archiveCurrent, restoreArchive } = useChatStore.use.actions();

  const handleNewChat = () => {
    // Park the current running thread (if any) so it keeps streaming in the
    // background; clear the tab for a fresh chat.
    archiveCurrent(tabId);
    clearSession(tabId);
  };

  const handleOpenAgent = async (item: SidebarItem) => {
    if (item.id === activeClaudeId) return;

    // Park the currently-bound running thread (if any) so we don't kill its
    // stream by clobbering the tab.
    archiveCurrent(tabId);

    // If the target session is currently running in the background archive,
    // restore it (no disk read needed) — keeps everything live.
    if (runningArchive[item.id]) {
      restoreArchive(tabId, item.id);
      return;
    }

    // Otherwise it's a historical session on disk — load it as before.
    if (!item.filePath) return;
    try {
      const messages = await readClaudeSession(item.filePath);
      clearSession(tabId);
      replaceMessages(
        tabId,
        messages.map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp ?? undefined,
          toolCalls: (m.tool_calls ?? []).map((tc) => ({
            toolName: tc.tool_name,
            arguments: tc.input as Record<string, unknown>,
          })),
        }))
      );
      setClaudeSessionId(tabId, item.id);
      setSessionTitle(tabId, item.title.slice(0, 40));
    } catch (err) {
      console.error("Failed to open session:", err);
    }
  };

  const handleDeleteAgent = async (e: React.MouseEvent, item: SidebarItem) => {
    e.stopPropagation();
    if (!item.filePath) return;
    try {
      await deleteClaudeSession(item.filePath);
      if (activeClaudeId === item.id) clearSession(tabId);
      queryClient.invalidateQueries({ queryKey });
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  };

  // --- Resize handle ---
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeStartXRef = useRef<number | null>(null);
  const resizeStartWidthRef = useRef<number>(0);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizeStartXRef.current = e.clientX;
      resizeStartWidthRef.current = chatSidebar.width;
      const onMove = (ev: MouseEvent) => {
        if (resizeStartXRef.current === null) return;
        const delta = ev.clientX - resizeStartXRef.current;
        setChatSidebarWidth(resizeStartWidthRef.current + delta);
      };
      const onUp = () => {
        resizeStartXRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [chatSidebar.width, setChatSidebarWidth]
  );

  if (!chatSidebar.visible) {
    return null;
  }

  const isActiveItem = (item: SidebarItem) => {
    if (item.kind === "agent") return item.id === activeClaudeId;
    return item.id === tabId && !activeSession?.useClaude;
  };

  const showEmpty = !isLoading && filtered.length === 0;

  return (
    <div
      ref={containerRef}
      style={{ width: chatSidebar.width }}
      className="relative shrink-0 h-full flex flex-col border-r border-[var(--border-default)] bg-[var(--bg-sidebar)]"
    >
      {/* Search + filter menu — full-width row matching the GitHub panel's search */}
      <div className="flex items-center gap-1.5 h-[32px] shrink-0 border-b border-border-default bg-bg-primary px-3">
        <Search size={11} className="text-text-tertiary shrink-0" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="flex-1 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary min-w-0"
        />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary cursor-pointer outline-none transition-colors shrink-0"
              title={`Filter: ${filter}`}
            >
              <ListFilter size={11} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)] py-1 min-w-[140px]"
              style={{ zIndex: 9999 }}
            >
              {(["all", "agent", "chat"] as const).map((f) => (
                <DropdownMenu.Item
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    "flex items-center justify-between gap-2 px-3 h-[26px] text-[11px] cursor-default outline-none capitalize",
                    filter === f
                      ? "text-[var(--text-primary)] bg-[var(--bg-selected)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  )}
                >
                  <span>{f}</span>
                  {filter === f && <span className="text-[10px] text-[var(--text-tertiary)]">●</span>}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto hide-scrollbar">
        {isLoading && (
          <div className="text-[11px] text-[var(--text-tertiary)] px-3 py-2">Loading…</div>
        )}
        {showEmpty && (
          <div className="text-[11px] text-[var(--text-tertiary)] px-3 py-3 leading-relaxed">
            {search.trim()
              ? "No sessions match your search."
              : filter === "agent"
              ? "No agent sessions yet."
              : filter === "chat"
              ? "No general chats yet."
              : "No prior sessions for this project."}
          </div>
        )}
        {filtered.map((item, idx) => {
          const active = isActiveItem(item);
          const isRunning = runningKeys.has(`${item.kind}:${item.id}`);
          const isLast = idx === filtered.length - 1;
          const Icon = item.kind === "agent" ? Terminal : MessageSquare;
          return (
            <div
              key={`${item.kind}-${item.id}`}
              onClick={() =>
                item.kind === "agent" ? handleOpenAgent(item) : undefined
              }
              className={cn(
                "group relative w-full text-left px-3 py-3 transition-colors flex flex-col gap-1 cursor-pointer select-none",
                active
                  ? "bg-[var(--bg-selected)] text-[var(--text-primary)] opacity-100"
                  : "text-[var(--text-secondary)] opacity-80 hover:opacity-100 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                !isLast && "border-b border-[var(--border-subtle)]"
              )}
            >
              <div className="flex items-center gap-2 min-w-0 pr-5">
                <span
                  className="shrink-0 inline-flex items-center justify-center"
                  title={item.kind === "agent" ? "Claude Code" : "AI Chat"}
                >
                  {isRunning ? (
                    <Loader2
                      size={11}
                      className="animate-spin text-[var(--accent-primary)]"
                    />
                  ) : (
                    <Icon
                      size={11}
                      className={cn(
                        item.kind === "agent"
                          ? "text-[var(--status-success)]"
                          : "text-[var(--accent-primary)]"
                      )}
                    />
                  )}
                </span>
                <span className="text-[11px] truncate flex-1">{item.title}</span>
              </div>
              <div className="flex items-center justify-between pl-[18px]">
                <span className="text-[9px] text-[var(--text-tertiary)]">
                  {timeAgo(item.lastUpdated)}
                </span>
                <span className="text-[9px] text-[var(--text-tertiary)]">
                  {item.messageCount} msg
                </span>
              </div>

              {item.kind === "agent" && (
                <button
                  onClick={(e) => handleDeleteAgent(e, item)}
                  className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 flex items-center justify-center w-4 h-4 rounded text-[var(--text-tertiary)] hover:text-[var(--status-error)] hover:bg-[var(--bg-elevated)] transition-opacity"
                  title="Delete session"
                >
                  <X size={10} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom mini-bar */}
      <div className="flex items-center justify-between px-1.5 h-7 border-t border-[var(--border-default)] bg-[var(--bg-sidebar)]">
        <button
          onClick={toggleChatSidebar}
          className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          title="Hide sidebar (⌘⌥J)"
        >
          <PanelLeftClose size={12} />
        </button>
        <button
          onClick={handleNewChat}
          className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          title="New chat"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Resize handle — subtle, matches main panel handles */}
      <div
        onMouseDown={onResizeStart}
        className="absolute top-0 -right-px w-px h-full bg-border-default hover:bg-accent transition-colors cursor-col-resize"
        title="Drag to resize"
      />
    </div>
  );
}
