import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  X,
  MessageSquare,
  Search,
  PanelLeftClose,
  Plus,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ClaudeIcon, CodexIcon } from "@/components/agent-icons";
import { AtlasLoader } from "@/components/atlas-loader";
import { timeAgo } from "@/lib/time-ago";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import {
  listClaudeSessions,
  deleteClaudeSession,
} from "../lib/claude-api";
import {
  agents,
  ensureAgent,
  getAgentSync,
  CODEX_PLUGIN_ID,
  DEFAULT_PLUGIN_ID,
} from "../lib/agents-api";
import type { SessionMessage } from "@/types/agents";

// Module-level click-token table per target tab id. Each call to
// `handleOpenAgent` bumps the token for its target; in-flight async work
// for older tokens bails before mutating state or hitting the agent. Prevents
// rapid sidebar clicks from stacking N concurrent `loadSession` calls on the
// same agent process (which froze the app at 5-6 clicks).
const loadTokens: Record<string, number> = {};

// Map an atlas-agents `SessionMessage` (rich Rust state) onto the wire
// shape `replaceMessages` expects. Used to hydrate the chat-store from a
// `agents.snapshot()` payload.
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

interface SidebarItem {
  id: string; // acpSessionId for agent rows, tabId for chat rows
  kind: "agent" | "chat";
  title: string;
  subtitle: string | null;
  lastUpdated: string | null;
  messageCount: number;
  /** Which coding agent ran this session (drives the row icon). Defaults to
   *  "claude" — historical Claude-only sessions + anything without metadata. */
  agent: "claude" | "codex";
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

  // Stable signature string of the slim per-tab fields the sidebar reads.
  // Returning a primitive means zustand's default Object.is equality short-
  // circuits cleanly — the sidebar only re-runs its render when one of the
  // tracked fields actually changes, NOT on every streaming chunk (those
  // mutate `messages[].content` and don't touch any field in the signature).
  //
  // The earlier `useShallow(... -> Record<TabId, { nested }> ...)` version
  // looked sensible but blew up: useShallow only does one-level shallow eq,
  // and the inner objects were freshly allocated per call → never equal →
  // infinite-loop re-render via useSyncExternalStore.
  const sessionsSignature = useChatStore((s) => {
    const keys = Object.keys(s.sessions).sort();
    let sig = "";
    for (const k of keys) {
      const x = s.sessions[k];
      sig +=
        k +
        "|" +
        x.title +
        "|" +
        x.status +
        "|" +
        (x.acpAgentId ?? "") +
        "|" +
        (x.acpSessionId ?? "") +
        "|" +
        x.updatedAt +
        "|" +
        (x.firstUserContent ?? "") +
        "|" +
        (x.userMessageCount ?? 0) +
        "|" +
        (x.agentType ?? "claude-code") +
        "|" +
        (x.workingDirectory ?? "") +
        "|" +
        (x.messages.length > 0 ? 1 : 0) +
        "\n";
    }
    return sig;
  });
  const tabSummaries = useMemo(() => {
    // Pull current state non-reactively. The signature above is what gates
    // recomputation; `getState()` here just gives us the rich object form.
    const sessions = useChatStore.getState().sessions;
    const out: Record<
      string,
      {
        id: string;
        title: string;
        status: string;
        acpAgentId: string | undefined;
        acpSessionId: string | undefined;
        updatedAt: string;
        firstUserContent: string;
        userMessageCount: number;
        agentType: string;
        workingDirectory: string;
        hasAnyMessage: boolean;
      }
    > = {};
    for (const [tid, sess] of Object.entries(sessions)) {
      out[tid] = {
        id: sess.id,
        title: sess.title,
        status: sess.status,
        acpAgentId: sess.acpAgentId,
        acpSessionId: sess.acpSessionId,
        updatedAt: sess.updatedAt,
        firstUserContent: sess.firstUserContent ?? "",
        userMessageCount: sess.userMessageCount ?? 0,
        agentType: sess.agentType ?? "claude-code",
        workingDirectory: sess.workingDirectory ?? "",
        hasAnyMessage: sess.messages.length > 0,
      };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsSignature]);
  const activeSession = tabSummaries[tabId];
  const activeAcpId = activeSession?.acpSessionId;

  const {
    replaceMessages,
    setAcpBinding,
    clearSession,
    setSessionTitle,
    setTranscriptLoading,
    createSession,
  } = useChatStore.use.actions();

  const chatSidebar = useLayoutStore.use.chatSidebar();
  const {
    toggleChatSidebar,
    setChatSidebarWidth,
    addTab,
    setActiveTab,
  } = useLayoutStore.use.actions();

  const [search, setSearch] = useState("");

  const queryKey = ["claude-sessions", cwd] as const;

  // Polling-free listing. The Rust-side watcher (started below) emits
  // `atlas:sessions-changed` whenever the project's JSONL directory mutates,
  // so we refetch on event rather than every 1.5–5s. The cost of the disk
  // walk only pays off when something actually changed.
  const { data: agentList = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => listClaudeSessions(cwd),
    enabled: cwd.length > 0,
    staleTime: 30_000,
    refetchInterval: false,
  });

  // Start (or replace) the Rust file watcher for this cwd. The single
  // `atlas:sessions-changed` listener below dispatches against `queryKey`
  // closed over the current cwd, so the listener doesn't have to be
  // reattached on every cwd change.
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    invoke("sessions_watch_open", { cwd }).catch((err) => {
      if (!cancelled) console.warn("sessions watcher failed to start:", err);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    // Rebuild the key from `cwd` INSIDE the effect. Depending on the
    // `queryKey` array (a fresh literal every render) made this effect
    // re-subscribe on every render; because `listen()` is async, each render
    // opened a teardown→reattach gap where an `atlas:sessions-changed` event
    // could land with no listener attached → the refresh was silently dropped
    // and the history list went stale until something else forced a refetch.
    // Now it attaches once per `cwd` and stays attached.
    const key = ["claude-sessions", cwd] as const;
    const invalidate = () => queryClient.invalidateQueries({ queryKey: key });
    const unlistenPromise = listen<{ cwd: string }>(
      "atlas:sessions-changed",
      (e) => {
        if (e.payload.cwd !== cwd) return;
        invalidate();
      }
    );
    window.addEventListener("focus", invalidate);
    return () => {
      unlistenPromise.then((u) => u());
      window.removeEventListener("focus", invalidate);
    };
  }, [queryClient, cwd]);

  // Build the unified item list. Two sources, merged by session id:
  //   1. disk JSONL rows (agentList, from list_claude_sessions polling)
  //   2. live in-store sessions (chat-store, mutated optimistically)
  //
  // We MERGE rather than concat-and-dedup. When both sources have the same id
  // the live row's title wins because the chat-store updates synchronously
  // and is the source of truth for whatever's currently happening; the disk
  // row contributes `filePath` (needed by handleOpenAgent to reload by id)
  // and serves as the fallback `preview` for older sessions that aren't in
  // the live store at all.
  //
  // Net effect: the row's title NEVER flips during the window where a disk
  // row arrives mid-stream — it's always the live `session.title` for as
  // long as the session is in the chat-store.
  const items = useMemo<SidebarItem[]>(() => {
    // Only sessions the user has actually messaged belong in history. A new
    // chat that merely got an ACP session bound (no message yet) must NOT
    // appear — that was the "empty chat I can't remove" bug. The first user
    // message is what promotes a chat into the history list (and becomes its
    // title below).
    // Scope to THIS project: the chat-store is global (it holds every mounted
    // workspace's sessions), so without the cwd filter a session from another
    // open project leaks into this project's history list.
    const liveAgents = Object.values(tabSummaries).filter(
      (s) =>
        (s.userMessageCount > 0 || s.hasAnyMessage) &&
        (s.workingDirectory === cwd || s.workingDirectory === ""),
    );
    const liveById = new Map(
      liveAgents.map((s) => {
        const id = s.acpSessionId ?? `live-${s.id}`;
        return [id, s] as const;
      })
    );
    const diskById = new Map(agentList.map((d) => [d.id, d] as const));

    const allIds = new Set<string>([
      ...liveById.keys(),
      ...diskById.keys(),
    ]);

    const agents: SidebarItem[] = Array.from(allIds, (id) => {
      const live = liveById.get(id);
      const disk = diskById.get(id);
      const firstUser = live?.firstUserContent ?? "";
      const diskPreview =
        disk?.preview && disk.preview !== "(no user message)"
          ? disk.preview
          : "";
      const title =
        (live?.title && live.title !== "New Chat" ? live.title : "") ||
        firstUser.slice(0, 80) ||
        diskPreview ||
        live?.title ||
        "New session";
      const lastUpdated =
        live?.status === "running"
          ? (live.updatedAt ?? disk?.last_modified ?? null)
          : (disk?.last_modified ?? live?.updatedAt ?? null);
      return {
        id,
        kind: "agent" as const,
        title,
        subtitle: null,
        lastUpdated,
        messageCount: live
          ? live.userMessageCount
          : (disk?.message_count ?? 0),
        // Agent metadata comes from the live session (Codex only persists
        // in-session for now); disk-backed Claude sessions default to claude.
        agent: live?.agentType === "codex" ? "codex" : "claude",
        filePath: disk?.file_path,
      };
    });

    // Drop empty rows (disk JSONLs that exist but hold no messages, or any live
    // session that slipped through) so history only ever shows messaged chats.
    return agents
      .filter((a) => a.messageCount > 0)
      .sort((a, b) => (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? ""));
  }, [agentList, tabSummaries]);

  // Sessions currently running (used to show a spinner on the matching row).
  // Keys MUST match the `id`s used when constructing `items` above, otherwise
  // the spinner never lights up. Once an agent session is bound we key by
  // `acpSessionId`; while it's still spawning we use the synthetic
  // `live-${tabId}` placeholder.
  const runningKeys = useMemo(() => {
    const set = new Set<string>();
    for (const s of Object.values(tabSummaries)) {
      if (s.status !== "running") continue;
      const liveId = s.acpSessionId ?? `live-${s.id}`;
      set.add(`agent:${liveId}`);
    }
    return set;
  }, [tabSummaries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.title.toLowerCase().includes(q));
  }, [items, search]);

  const handleNewChat = () => {
    const current = useChatStore.getState().sessions[tabId];
    const hasConversation =
      !!current &&
      ((current.userMessageCount ?? 0) > 0 || current.messages.length > 0);

    // If the current tab is empty there's nothing to lose — reuse it. Reset it
    // to pristine and focus the composer so the click visibly does something;
    // previously this branch just cleared an already-empty session and bailed,
    // which read as "I click + and nothing happens".
    if (!hasConversation) {
      clearSession(tabId);
      window.dispatchEvent(
        new CustomEvent("atlas:chat-focus", { detail: { tabId } }),
      );
      return;
    }

    // Otherwise PRESERVE the current conversation by opening a brand-new chat
    // tab/session instead of wiping this one in place. Wiping was the
    // "New Chat deletes my last session" bug: `clearSession` resets the live
    // row to empty, so it dropped out of the history list immediately — and in
    // a fresh workspace its JSONL hadn't been written yet, so there was no
    // disk-backed row to fall back to and the conversation vanished. Keeping
    // the old tab open leaves it as a live (and clickable) history row.
    const newId = `chat-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    addTab({
      id: newId,
      type: "chat",
      title: "New Chat",
      closable: true,
      dirty: false,
      data: {},
    });
    createSession(newId, current.agentType === "codex" ? "codex" : "claude-code");
    setActiveTab(newId);
  };

  const handleOpenAgent = (item: SidebarItem) => {
    // Resumable when we have a disk-backed JSONL OR a real (bound) ACP session
    // id. Codex sessions never live in Claude's `~/.claude/projects` JSONL dir,
    // so they only ever arrive as live rows with no `filePath` — gating on
    // `filePath` alone made every Codex history row a dead click. Synthetic
    // `live-<tabId>` ids aren't resumable (that's the current empty tab itself),
    // so those still bail.
    const isSynthetic = item.id.startsWith("live-");
    if (!item.filePath && isSynthetic) return;

    // Pick the agent that actually ran this session. This was hardcoded to the
    // default (Claude), so clicking a Codex row tried to resume it through the
    // Claude process → `loadSession` failed → it fell back to a blank session.
    const pluginId = item.agent === "codex" ? CODEX_PLUGIN_ID : DEFAULT_PLUGIN_ID;

    const storeSnapshot = useChatStore.getState().sessions;

    // De-dup #1: if THIS tab is already pointing at the same session id,
    // it's a no-op (covers re-clicks + clicks-while-loading).
    if (storeSnapshot[tabId]?.acpSessionId === item.id) return;

    // De-dup #2: if ANOTHER open tab is already bound to this session id,
    // just focus that tab instead of opening a new one. Keeps tabs from
    // multiplying when the user re-clicks a row they already have open.
    for (const [tid, s] of Object.entries(storeSnapshot)) {
      if (s.acpSessionId === item.id) {
        setActiveTab(tid);
        return;
      }
    }

    // Decide target tab. If the current tab's session is mid-flight
    // (status === "running"), we MUST NOT overwrite it — the agent is
    // still streaming back into that session and the user needs to see
    // it keep running. Open the clicked history in a new chat tab
    // instead. Otherwise replace in-place (idle tab is fair game).
    const currentRunning = storeSnapshot[tabId]?.status === "running";
    const targetTabId = currentRunning
      ? `chat-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 6)}`
      : tabId;

    if (currentRunning) {
      addTab({
        id: targetTabId,
        type: "chat",
        title: item.title.slice(0, 40) || "Chat",
        closable: true,
        dirty: false,
        data: {},
      });
      // Pre-create the chat-store session before the ChatPanel mounts so
      // the optimistic binding below has something to attach to.
      createSession(targetTabId);
      setActiveTab(targetTabId);
    }

    const project = useProjectStore.getState().currentProject;
    // Empty-string fallback (not "/") to stay consistent with the component
    // default and the sidebar filter (`workingDirectory === cwd || === ""`);
    // a session stamped "/" would match neither arm and vanish from history.
    const cwd = project?.path ?? "";

    // OPTIMISTIC SYNCHRONOUS UI: clear + retitle + bind the historical
    // session id IMMEDIATELY when the default agent is already cached
    // (App.tsx pre-spawns it at startup, so it almost always is).
    clearSession(targetTabId);
    setSessionTitle(targetTabId, item.title.slice(0, 40));
    const cachedAgent = getAgentSync(pluginId);
    if (cachedAgent) {
      setAcpBinding(targetTabId, cachedAgent.agent_id, item.id, cwd);
    }
    // Always flag loading at this point — the chat panel renders a spinner
    // instead of the welcome state until the snapshot lands. On a Rust-cache
    // hit the snapshot returns in ~1ms so the spinner is barely visible; on
    // a miss it covers the JSONL replay window.
    setTranscriptLoading(targetTabId, true);

    // Click-token cancellation: each click bumps the token for this tab.
    // Every subsequent await re-checks the token and bails if a newer click
    // has taken over — prevents 5-6 rapid clicks from piling up 5-6 in-flight
    // `loadSession` calls against the same agent.
    const myToken = (loadTokens[targetTabId] ?? 0) + 1;
    loadTokens[targetTabId] = myToken;
    const isStale = () => loadTokens[targetTabId] !== myToken;

    void (async () => {
      // Yield once so multiple clicks in the same event-loop tick collapse:
      // every click after this microtask resumes with a stale token and
      // bails before doing any IPC.
      await Promise.resolve();
      if (isStale()) return;

      let agent;
      try {
        agent = await ensureAgent(pluginId);
      } catch (err) {
        if (!isStale()) {
          setTranscriptLoading(targetTabId, false);
          toast.error(
            `Agent not available: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return;
      }
      if (isStale()) return;

      // atlas-agents owns the cache. `loadSession` is idempotent: the second
      // visit to the same session is a `DashMap::get` away from instant —
      // no JSONL replay, no ACP round-trip. First visit replays the JSONL
      // into a `SessionState` inside the manager and tells the agent to
      // resume; that state stays loaded for the rest of the process.
      let key;
      try {
        key = await agents.loadSession(agent.agent_id, item.id, cwd);
      } catch (err) {
        if (isStale()) return;
        console.warn("loadSession failed, falling back to new session:", err);
        toast.message(
          "Couldn't resume the old session — continuing in a new one.",
          {
            description:
              err instanceof Error
                ? err.message.slice(0, 120)
                : String(err).slice(0, 120),
          }
        );
        try {
          const newKey = await agents.newSession(agent.agent_id, cwd);
          if (isStale()) return;
          setAcpBinding(targetTabId, agent.agent_id, newKey.session_id, cwd);
          setTranscriptLoading(targetTabId, false);
        } catch (newErr) {
          if (!isStale()) {
            setTranscriptLoading(targetTabId, false);
            toast.error(
              `Couldn't open agent session: ${newErr instanceof Error ? newErr.message : String(newErr)}`
            );
          }
        }
        return;
      }
      if (isStale()) return;

      // Pull the rich state Rust holds for this session and hydrate the
      // chat-store from it. On a cache hit this is ~1ms; on a miss it
      // already has the JSONL-replayed messages baked in.
      let snapshot;
      try {
        snapshot = await agents.snapshot(key);
      } catch (err) {
        if (!isStale()) {
          setTranscriptLoading(targetTabId, false);
          toast.error(
            `Couldn't load session: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return;
      }
      if (isStale()) return;

      replaceMessages(targetTabId, snapshot.messages.map(snapshotMessageToWire));
      setAcpBinding(targetTabId, agent.agent_id, item.id, cwd);
      setTranscriptLoading(targetTabId, false);
    })();
  };

  const handleDeleteAgent = async (e: React.MouseEvent, item: SidebarItem) => {
    e.stopPropagation();
    if (!item.filePath) return;
    try {
      await deleteClaudeSession(item.filePath);
      if (activeAcpId === item.id) clearSession(tabId);
    } catch (err) {
      console.error("Failed to delete session:", err);
      toast.error(
        `Couldn't delete session: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Always refetch so the list reflects on-disk truth — whether the delete
      // succeeded (row gone) or failed (row stays). Was inside `try`, so a
      // failed delete never re-synced.
      queryClient.invalidateQueries({ queryKey });
    }
  };

  // --- Resize handle ---
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeStartXRef = useRef<number | null>(null);
  const resizeStartWidthRef = useRef<number>(0);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      // Guard against a second drag starting before the first's mouseup
      // cleanup runs (e.g. rapid double-mousedown) — that would stack two
      // `mousemove` listeners and move the handle double-distance per pixel.
      if (resizeStartXRef.current !== null) return;
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
    if (item.kind === "agent") return item.id === activeAcpId;
    return item.id === tabId;
  };

  const showEmpty = !isLoading && filtered.length === 0;

  return (
    <div
      ref={containerRef}
      style={{ width: chatSidebar.width }}
      className="relative shrink-0 h-full flex flex-col border-r border-[var(--border-default)] bg-[var(--bg-sidebar)]"
    >
      {/* Search — full-width row matching the GitHub panel's search */}
      <div className="flex items-center gap-1.5 h-[32px] shrink-0 border-b border-border-default bg-bg-primary px-3">
        <Search size={11} className="text-text-tertiary shrink-0" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search sessions"
          placeholder="Search…"
          className="flex-1 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary min-w-0"
        />
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
              : "No prior sessions for this project."}
          </div>
        )}
        {filtered.map((item, idx) => {
          const active = isActiveItem(item);
          const isRunning = runningKeys.has(`${item.kind}:${item.id}`);
          const isLast = idx === filtered.length - 1;
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
                !isLast && "border-b border-[var(--border-default)]"
              )}
            >
              <div className="flex items-start gap-2 min-w-0 pr-5">
                <span
                  className="shrink-0 inline-flex h-[15px] items-center justify-center text-[var(--text-secondary)]"
                  title={
                    item.kind !== "agent"
                      ? "AI Chat"
                      : item.agent === "codex"
                        ? "Codex"
                        : "Claude Code"
                  }
                >
                  {isRunning ? (
                    <AtlasLoader size={8} className="text-[var(--accent-primary)]" />
                  ) : item.kind === "agent" ? (
                    item.agent === "codex" ? (
                      <CodexIcon className="size-3" />
                    ) : (
                      <ClaudeIcon className="size-3" />
                    )
                  ) : (
                    <MessageSquare size={11} className="text-[var(--accent-primary)]" />
                  )}
                </span>
                <span className="text-[11px] leading-snug line-clamp-2 flex-1">
                  {item.title}
                </span>
              </div>
              <div className="pl-[18px]">
                <span className="text-[9px] text-[var(--text-tertiary)]">
                  {timeAgo(item.lastUpdated, { suffix: true })}
                </span>
              </div>

              {item.kind === "agent" && (
                <button
                  onClick={(e) => handleDeleteAgent(e, item)}
                  aria-label="Delete session"
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

      {/* Bottom mini-bar. Height matches the left panel's collapsed Git
          strip (a 28px button + its 1px top border = 29px) so this
          footer's top border lines up horizontally with the Git strip's. */}
      <div className="flex items-center justify-between px-1.5 h-[29px] border-t border-[var(--border-default)] bg-[var(--bg-sidebar)]">
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
