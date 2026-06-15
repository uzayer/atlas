import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  GitBranch,
  FolderPlus,
  Plus,
  Folder,
  FolderOpen,
  X,
  ScrollText,
  Settings,
  Bot,
  Pin,
  PinOff,
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  MoreHorizontal,
  Search,
  MessageSquare,
  Loader2,
} from "lucide-react";
import {
  useWorkspaceStore,
  type Workspace,
  type WorkspaceGroup,
} from "../stores/workspace-store";
import { pickAndAddWorkspace } from "../lib/pick-workspace";
import { useRunningByPath } from "../lib/agent-activity";
import { useRecentChatsStore, type RecentChat } from "../stores/recent-chats-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { AtlasIcon } from "@/components/atlas-icon";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { cn } from "@/lib/utils";

interface GitSummary {
  isRepo: boolean;
  branch: string;
  headSubject: string;
  dirty: boolean;
  additions: number;
  deletions: number;
}

// Slot heights (include the inter-row gap so the virtualizer spaces rows out);
// the visible card is a few px shorter than its slot.
const WS_H = 50;
const WS_CARD = 44;
const ROW_H = 27;
const ROW_CARD = 26;
const CHAT_H = 46;
const CHAT_CARD = 40;
const HEADER_H = 26;

/** Git status dot: green = clean tree, yellow = dirty, gray = non-repo/unknown. */
function GitDot({ summary }: { summary?: GitSummary }) {
  const color = !summary || !summary.isRepo
    ? "var(--text-tertiary)"
    : summary.dirty
      ? "var(--status-warning, #CD9731)"
      : "var(--accent-positive, #3fb950)";
  return (
    <span
      title={!summary?.isRepo ? "Not a git repo" : summary.dirty ? "Working tree dirty" : "Working tree clean"}
      className="shrink-0 h-2 w-2 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

function NumStatPill({ summary, agentCount }: { summary?: GitSummary; agentCount: number }) {
  const hasStat = summary && (summary.additions > 0 || summary.deletions > 0);
  if (!hasStat && agentCount === 0) return null;
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-[var(--bg-elevated)] px-1.5 py-[1px] font-mono text-[9px] shrink-0">
      {agentCount > 0 && (
        <span className="flex items-center gap-0.5 text-[var(--accent-primary)]">
          <Bot size={9} />
          {agentCount}
        </span>
      )}
      {summary && summary.additions > 0 && (
        <span className="text-[var(--accent-positive,#3fb950)]">+{summary.additions}</span>
      )}
      {summary && summary.deletions > 0 && (
        <span className="text-[var(--accent-negative,#f85149)]">−{summary.deletions}</span>
      )}
    </span>
  );
}

function WorkspaceRow({
  ws,
  active,
  agentCount,
  summary,
  groups,
  indented,
}: {
  ws: Workspace;
  active: boolean;
  agentCount: number;
  summary?: GitSummary;
  groups: WorkspaceGroup[];
  indented?: boolean;
}) {
  const { switchTo, closeWorkspace, pin, unpin, setGroup, addGroup } = useWorkspaceStore.use.actions();
  const branchLine = summary?.isRepo
    ? `${summary.branch || "—"}${summary.headSubject ? `  ${summary.headSubject}` : ""}`
    : "no source control";
  return (
    <div
      onClick={() => void switchTo(ws.id)}
      style={{ height: WS_CARD, paddingLeft: indented ? 16 : 6 }}
      className={cn(
        "group relative flex items-center gap-2 pr-2 rounded-md cursor-pointer transition-colors",
        active ? "bg-[var(--bg-active)]" : "hover:bg-[var(--bg-hover)]",
      )}
      title={ws.path}
    >
      <GitDot summary={summary} />
      <div className="flex-1 min-w-0">
        <span
          className={cn(
            "block truncate text-[12px] leading-tight pr-16",
            active ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-secondary)]",
          )}
        >
          {ws.name}
        </span>
        <div className="flex items-center gap-1 mt-1 text-[10px] text-[var(--text-tertiary)] leading-tight">
          {summary?.isRepo && <GitBranch size={9} className="shrink-0" />}
          <span className="truncate font-mono pr-12">{branchLine}</span>
        </div>
      </div>

      {/* +/- (and agent count) pill — absolute TOP-RIGHT. */}
      <div className="absolute top-1.5 right-2 pointer-events-none">
        <NumStatPill summary={summary} agentCount={agentCount} />
      </div>

      {/* Pin + more — absolute BOTTOM-RIGHT, on hover (pin stays if pinned). */}
      <div className="absolute bottom-1 right-1.5 flex items-center gap-0.5">
        <button
          onClick={(e) => { e.stopPropagation(); if (ws.pinned) unpin(ws.id); else pin(ws.id); }}
          className={cn(
            "p-0.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-tertiary)] transition-opacity",
            ws.pinned ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          title={ws.pinned ? "Unpin" : "Pin"}
        >
          {ws.pinned ? <PinOff size={11} /> : <Pin size={11} />}
        </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            onClick={(e) => e.stopPropagation()}
            className="p-0.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity outline-none"
            title="More"
          >
            <MoreHorizontal size={12} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} onClick={(e) => e.stopPropagation()}
            className="z-[var(--z-max)] min-w-[160px] rounded-md border border-[var(--border-default)] bg-[var(--bg-overlay)] py-1 shadow-lg text-[12px] text-[var(--text-secondary)]">
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className="flex items-center justify-between px-3 h-7 outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default">
                Move to group <ChevronRight size={12} />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="z-[var(--z-max)] min-w-[150px] rounded-md border border-[var(--border-default)] bg-[var(--bg-overlay)] py-1 shadow-lg">
                  {groups.map((g) => (
                    <DropdownMenu.Item key={g.id} onSelect={() => setGroup(ws.id, g.id)}
                      className="px-3 h-7 flex items-center outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default">
                      {g.name}
                    </DropdownMenu.Item>
                  ))}
                  <DropdownMenu.Item onSelect={() => { const gid = addGroup("New Group"); setGroup(ws.id, gid); }}
                    className="px-3 h-7 flex items-center gap-1.5 outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default">
                    <FolderPlus size={11} /> New group
                  </DropdownMenu.Item>
                  {ws.groupId && (
                    <>
                      <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-default)]" />
                      <DropdownMenu.Item onSelect={() => setGroup(ws.id, null)}
                        className="px-3 h-7 flex items-center outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default">
                        Remove from group
                      </DropdownMenu.Item>
                    </>
                  )}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-default)]" />
            <DropdownMenu.Item onSelect={() => void closeWorkspace(ws.id)}
              className="px-3 h-7 flex items-center gap-1.5 outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--status-error,#f44)] cursor-default">
              <X size={11} /> Remove from list
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      </div>
    </div>
  );
}

function GroupHeaderRow({ group, count, collapsed, onToggle }: { group: WorkspaceGroup; count: number; collapsed: boolean; onToggle: () => void }) {
  const { pinGroup, unpinGroup, removeGroup, renameGroup } = useWorkspaceStore.use.actions();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const commit = () => { if (name.trim()) renameGroup(group.id, name.trim()); setEditing(false); };
  return (
    <div style={{ height: HEADER_H }} className="group/h flex items-center gap-1 pl-1 pr-1.5 rounded-md cursor-pointer hover:bg-[var(--bg-hover)]" onClick={onToggle}>
      {collapsed ? <ChevronRight size={12} className="text-[var(--text-tertiary)]" /> : <ChevronDown size={12} className="text-[var(--text-tertiary)]" />}
      <Folder size={11} className="text-[var(--text-tertiary)] shrink-0" />
      {editing ? (
        <input autoFocus value={name} onClick={(e) => e.stopPropagation()} onChange={(e) => setName(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          className="flex-1 min-w-0 bg-transparent outline-none text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]" />
      ) : (
        <span onDoubleClick={(e) => { e.stopPropagation(); setName(group.name); setEditing(true); }}
          className="flex-1 min-w-0 truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
          {group.name}
        </span>
      )}
      <span className="text-[9px] text-[var(--text-tertiary)] tabular-nums">{count}</span>
      <button onClick={(e) => { e.stopPropagation(); if (group.pinned) unpinGroup(group.id); else pinGroup(group.id); }}
        className={cn("p-0.5 rounded hover:bg-[var(--bg-elevated)] transition-opacity", group.pinned ? "opacity-100 text-[var(--accent-primary)]" : "opacity-0 group-hover/h:opacity-100 text-[var(--text-tertiary)]")}
        title={group.pinned ? "Unpin group" : "Pin group"}>
        {group.pinned ? <PinOff size={10} /> : <Pin size={10} />}
      </button>
      <button onClick={(e) => { e.stopPropagation(); removeGroup(group.id); }}
        className="p-0.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-tertiary)] opacity-0 group-hover/h:opacity-100 transition-opacity" title="Delete group">
        <X size={10} />
      </button>
    </div>
  );
}

function SectionHeaderRow({ label, collapsed, onToggle }: { label: string; collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      style={{ height: HEADER_H }}
      className="group/s w-full flex items-center gap-1 px-1.5 rounded-md hover:bg-[var(--bg-hover)] outline-none"
    >
      {collapsed ? (
        <ChevronRight size={12} className="text-[var(--text-tertiary)]" />
      ) : (
        <ChevronDown size={12} className="text-[var(--text-tertiary)]" />
      )}
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{label}</span>
    </button>
  );
}

function RecentProjectRow({ name, path, onOpen }: { name: string; path: string; onOpen: () => void }) {
  return (
    <div onClick={onOpen} style={{ height: ROW_CARD, paddingLeft: 10 }}
      className="group flex items-center gap-2.5 pr-1.5 rounded-md cursor-pointer hover:bg-[var(--bg-hover)]" title={path}>
      <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-[var(--text-secondary)]" />
      <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--text-secondary)]">{name}</span>
    </div>
  );
}

function ChatRow({ chat, onOpen }: { chat: RecentChat; onOpen: () => void }) {
  const running = chat.status === "running" || chat.status === "waiting";
  return (
    <div onClick={onOpen} style={{ height: CHAT_CARD, paddingLeft: 6 }}
      className="group flex items-center gap-2 pr-1.5 rounded-md cursor-pointer hover:bg-[var(--bg-hover)]" title={chat.projectPath}>
      {running ? <Loader2 size={12} className="shrink-0 text-[var(--accent-primary)] animate-spin" /> : <MessageSquare size={12} className="shrink-0 text-[var(--text-tertiary)]" />}
      <div className="flex-1 min-w-0">
        <div className="truncate text-[12px] text-[var(--text-secondary)] leading-tight">{chat.title}</div>
        <div className="truncate text-[10px] text-[var(--text-tertiary)] leading-tight font-mono">{chat.projectName}</div>
      </div>
    </div>
  );
}

type Row =
  | { kind: "section"; id: string; label: string; key: string }
  | { kind: "group"; group: WorkspaceGroup; count: number; key: string }
  | { kind: "ws"; ws: Workspace; indented: boolean; key: string }
  | { kind: "recent"; name: string; path: string; key: string }
  | { kind: "chat"; chat: RecentChat; key: string };

export function WorkspaceSidebar() {
  const workspaces = useWorkspaceStore.use.workspaces();
  const groups = useWorkspaceStore.use.groups();
  const activeWorkspaceId = useWorkspaceStore.use.activeWorkspaceId();
  const { addWorkspace } = useWorkspaceStore.use.actions();
  const { addTab, setActiveTab } = useLayoutStore.use.actions();
  const recentProjects = useProjectStore.use.recentProjects();
  const recentChats = useRecentChatsStore.use.items();
  const runningByPath = useRunningByPath();
  const fullscreen = useFullscreen();

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  // Pinned + Projects (STATIC registry order — clicking never reorders).
  const pinned = useMemo(() => workspaces.filter((w) => w.pinned), [workspaces]);
  const projects = useMemo(() => workspaces.filter((w) => !w.pinned), [workspaces]);
  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.order - b.order),
    [groups],
  );

  // Recent projects = picker recents NOT already in the registry.
  const openPaths = useMemo(() => new Set(workspaces.map((w) => w.path)), [workspaces]);
  const recents = useMemo(
    () => recentProjects.filter((r) => !openPaths.has(r.path)),
    [recentProjects, openPaths],
  );

  // Section ids that currently exist (for collapse-all + the toggle button).
  const sectionIds = useMemo(() => {
    const ids: string[] = [];
    if (pinned.length) ids.push("sec:pinned");
    ids.push("sec:projects");
    if (recents.length) ids.push("sec:recent");
    if (recentChats.length) ids.push("sec:chats");
    return ids;
  }, [pinned.length, recents.length, recentChats.length]);

  // Flatten everything into one virtualized row list. Sections AND group
  // folders are collapsible; a collapsed section omits all its content rows.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (pinned.length) {
      out.push({ kind: "section", id: "sec:pinned", label: "Pinned", key: "s:pinned" });
      if (!collapsed["sec:pinned"]) for (const ws of pinned) out.push({ kind: "ws", ws, indented: false, key: ws.id });
    }
    out.push({ kind: "section", id: "sec:projects", label: "Projects", key: "s:projects" });
    if (!collapsed["sec:projects"]) {
      const inGroup = (gid: string) => projects.filter((w) => w.groupId === gid);
      for (const g of sortedGroups) {
        const members = inGroup(g.id);
        out.push({ kind: "group", group: g, count: members.length, key: `g:${g.id}` });
        if (!collapsed[g.id]) for (const ws of members) out.push({ kind: "ws", ws, indented: true, key: ws.id });
      }
      for (const ws of projects.filter((w) => !w.groupId)) out.push({ kind: "ws", ws, indented: false, key: ws.id });
    }
    if (recents.length) {
      out.push({ kind: "section", id: "sec:recent", label: "Recent", key: "s:recent" });
      if (!collapsed["sec:recent"]) for (const r of recents) out.push({ kind: "recent", name: r.name, path: r.path, key: `r:${r.path}` });
    }
    if (recentChats.length) {
      out.push({ kind: "section", id: "sec:chats", label: "Chats", key: "s:chats" });
      if (!collapsed["sec:chats"]) for (const c of recentChats) out.push({ kind: "chat", chat: c, key: `c:${c.tabId}` });
    }
    return out;
  }, [pinned, projects, sortedGroups, collapsed, recents, recentChats]);

  // Collapse-all / expand-all: collapses every section + group, or expands all.
  const allCollapsibleIds = useMemo(
    () => [...sectionIds, ...groups.map((g) => g.id)],
    [sectionIds, groups],
  );
  const allCollapsed = allCollapsibleIds.length > 0 && allCollapsibleIds.every((id) => collapsed[id]);
  const toggleAll = () => {
    if (allCollapsed) setCollapsed({});
    else setCollapsed(Object.fromEntries(allCollapsibleIds.map((id) => [id, true])));
  };

  // ── Git summaries: fetch lazily for the currently-VISIBLE workspace rows
  // (never all of a 100s-long list), cached + refreshed on git-changed.
  const [summaries, setSummaries] = useState<Record<string, GitSummary>>({});
  const fetchedRef = useRef<Set<string>>(new Set());
  const fetchSummary = useCallback(async (path: string) => {
    if (fetchedRef.current.has(path)) return;
    fetchedRef.current.add(path);
    try {
      const s = await invoke<GitSummary>("git_workspace_summary", { path });
      setSummaries((m) => ({ ...m, [path]: s }));
    } catch {
      fetchedRef.current.delete(path);
    }
  }, []);
  useEffect(() => {
    const un = listen<{ project?: string }>("atlas:git-changed", (e) => {
      const p = e.payload?.project;
      if (!p) return;
      fetchedRef.current.delete(p);
      void fetchSummary(p);
    });
    return () => { void un.then((off) => off()); };
  }, [fetchSummary]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const k = rows[i]?.kind;
      if (k === "ws") return WS_H;
      if (k === "chat") return CHAT_H;
      if (k === "recent") return ROW_H;
      return HEADER_H + 2; // section / group headers
    },
    overscan: 8,
    getItemKey: (i) => rows[i]?.key ?? i,
  });

  // Fetch git summaries for the visible workspace rows.
  const items = virtualizer.getVirtualItems();
  const visiblePaths = items.map((v) => { const r = rows[v.index]; return r?.kind === "ws" ? r.ws.path : null; }).filter(Boolean).join("|");
  useEffect(() => {
    for (const p of visiblePaths.split("|")) if (p) void fetchSummary(p);
  }, [visiblePaths, fetchSummary]);

  const openChat = useCallback(async (chat: RecentChat) => {
    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.path === chat.projectPath);
    if (ws) await useWorkspaceStore.getState().actions.switchTo(ws.id);
    else await addWorkspace(chat.projectPath);
    // Focus the chat tab if it exists in the now-active workspace's view.
    setActiveTab(chat.tabId);
  }, [addWorkspace, setActiveTab]);

  const openTabSingleton = (type: "mission-control" | "log" | "settings", title: string) =>
    addTab({ id: type === "mission-control" ? "mission-control" : type, type, title, closable: true, dirty: false, data: {} });

  return (
    <aside className="flex flex-col h-screen w-[244px] shrink-0 border-r border-[var(--border-default)] bg-[var(--bg-secondary)]/80 backdrop-blur-xl" data-tauri-drag-region>
      {/* Top bar: aligned to the titlebar height (h-[30px] + border-b) so the
       *  line under the traffic lights matches the rest of the title bar.
       *  Buttons sit right to dodge the traffic lights — but in fullscreen the
       *  lights are gone, so reclaim the left edge. */}
      <div
        className={cn(
          "h-[30px] shrink-0 flex items-center gap-1 px-2 border-b border-[var(--border-default)]",
          fullscreen ? "justify-start" : "justify-end",
        )}
        data-tauri-drag-region
      >
        <button
          onClick={toggleAll}
          className="p-1 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] outline-none"
          title={allCollapsed ? "Expand all" : "Collapse all"}
        >
          {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
        </button>
        <AddProjectMenu />
      </div>

      {/* Header actions. */}
      <div className="px-1.5 pb-1 shrink-0 space-y-0.5">
        <HeaderButton icon={<AtlasIcon size={14} className="rounded-[3px]" />} label="Console" onClick={() => openTabSingleton("mission-control", "Console")} />
        <HeaderButton icon={<ScrollText size={13} />} label="See Logs" onClick={() => openTabSingleton("log", "Log")} />
        <HeaderButton icon={<Settings size={13} />} label="Settings" onClick={() => openTabSingleton("settings", "Settings")} />
      </div>

      {/* Virtualized list. */}
      <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
        {rows.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-[var(--text-tertiary)]">No projects yet.</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((v) => {
              const row = rows[v.index];
              if (!row) return null;
              return (
                <div key={row.key} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}>
                  {row.kind === "section" ? (
                    <SectionHeaderRow label={row.label} collapsed={!!collapsed[row.id]} onToggle={() => toggle(row.id)} />
                  ) : row.kind === "group" ? (
                    <GroupHeaderRow group={row.group} count={row.count} collapsed={!!collapsed[row.group.id]} onToggle={() => toggle(row.group.id)} />
                  ) : row.kind === "ws" ? (
                    <WorkspaceRow ws={row.ws} active={row.ws.id === activeWorkspaceId} agentCount={runningByPath[row.ws.path] ?? 0} summary={summaries[row.ws.path]} groups={groups} indented={row.indented} />
                  ) : row.kind === "recent" ? (
                    <RecentProjectRow name={row.name} path={row.path} onOpen={() => void addWorkspace(row.path)} />
                  ) : (
                    <ChatRow chat={row.chat} onOpen={() => void openChat(row.chat)} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

function HeaderButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
      <span className="text-[var(--text-tertiary)]">{icon}</span>
      {label}
    </button>
  );
}

/** The "+" dropdown that replaced the old titlebar project picker: Open Folder
 *  + searchable Recent projects, adding the chosen project to the sidebar. */
function AddProjectMenu() {
  const { addWorkspace } = useWorkspaceStore.use.actions();
  const recentProjects = useProjectStore.use.recentProjects();
  const [query, setQuery] = useState("");
  const filtered = recentProjects.filter(
    (p) => p.name.toLowerCase().includes(query.toLowerCase()) || p.path.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <DropdownMenu.Root onOpenChange={(o) => { if (!o) setQuery(""); }}>
      <DropdownMenu.Trigger asChild>
        <button
          className="flex items-center justify-center h-6 w-6 rounded-full border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] outline-none transition-colors"
          title="Add project"
        >
          <Plus size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        {/* Compact menu primitive — mirrors the source-control "filter files"
         *  dropdown: 26px rows, px-3 on both sides, border-b search header. */}
        <DropdownMenu.Content align="end" sideOffset={4}
          className="z-[var(--z-max)] w-[280px] max-h-[360px] rounded-lg border border-[var(--border-default)] bg-[#000] shadow-xl text-[var(--text-secondary)] flex flex-col overflow-hidden">
          <DropdownMenu.Item onSelect={() => void pickAndAddWorkspace()}
            className="w-full flex items-center gap-2 px-3 h-[28px] text-[11px] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default shrink-0">
            <FolderOpen size={13} className="text-[var(--text-tertiary)] shrink-0" />
            <span className="flex-1 text-left">Open Folder…</span>
          </DropdownMenu.Item>
          {recentProjects.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 px-3 h-[30px] border-y border-[var(--border-default)] shrink-0" onKeyDown={(e) => e.stopPropagation()}>
                <Search size={11} className="text-[var(--text-tertiary)] shrink-0" />
                <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects…"
                  className="flex-1 bg-transparent outline-none text-[10px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]" />
              </div>
              <div className="px-3 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wide text-[var(--text-tertiary)] shrink-0">Recent</div>
              <div className="overflow-y-auto py-1 hide-scrollbar">
                {filtered.length === 0 ? (
                  <div className="px-3 py-2 text-[10px] text-[var(--text-tertiary)] text-center">No matches</div>
                ) : (
                  filtered.map((p) => (
                    <DropdownMenu.Item key={p.path} onSelect={() => void addWorkspace(p.path)}
                      className="w-full flex items-center gap-2 px-3 h-[26px] text-[11px] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default">
                      <Folder size={12} className="text-[var(--text-tertiary)] shrink-0" />
                      <span className="truncate font-mono text-left flex-1">{p.name}</span>
                    </DropdownMenu.Item>
                  ))
                )}
              </div>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
