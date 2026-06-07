import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  RefreshCw,
  FileText,
  BookText,
  Search,
  ChevronRight,
  ChevronDown,
  Coins,
  GitBranch,
  Clock,
  ShieldCheck,
  Cpu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/lib/markdown";
import { timeAgo } from "@/lib/time-ago";
import { ClaudeIcon, CodexIcon } from "@/components/agent-icons";
import { useProjectStore } from "@/features/project/stores/project-store";

// ── Wire types (mirror src-tauri/src/commands/agent_memory.rs) ──────────────

interface MemoryFile {
  name: string;
  title: string;
  description: string;
  kind: string;
  body: string;
  modified_ms: number;
}
interface ClaudeMemory {
  memory_dir: string;
  index: string | null;
  entries: MemoryFile[];
  project_md: string | null;
  global_md: string | null;
}
interface CodexThread {
  id: string;
  title: string;
  first_user_message: string;
  model: string;
  git_branch: string | null;
  approval_mode: string;
  tokens_used: number;
  created_at: number;
  updated_at: number;
}
interface CodexMemory {
  db_path: string | null;
  agents_md: string | null;
  global_agents_md: string | null;
  threads: CodexThread[];
}
interface AgentMemory {
  claude: ClaudeMemory;
  codex: CodexMemory;
}

type SubTab = "claude" | "codex";

// ── Panel shell ─────────────────────────────────────────────────────────────

export function MemoryPanel() {
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;
  const [data, setData] = useState<AgentMemory | null>(null);
  const [loading, setLoading] = useState(true);
  const [sub, setSub] = useState<SubTab>("claude");

  const load = useCallback(() => {
    if (!projectPath) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void invoke<AgentMemory>("agent_memory_read", { projectPath })
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [projectPath]);

  useEffect(() => {
    load();
  }, [load]);

  const codexCount = data?.codex.threads.length ?? 0;
  const claudeCount =
    (data?.claude.entries.length ?? 0) +
    (data?.claude.index ? 1 : 0) +
    (data?.claude.project_md ? 1 : 0) +
    (data?.claude.global_md ? 1 : 0);

  return (
    <div className="h-full flex flex-col bg-[var(--bg-base)]">
      {/* Header: sub-tab segmented control + refresh */}
      <div className="flex items-center justify-between h-[32px] shrink-0 border-b border-[var(--border-default)] px-2">
        <div className="flex items-center gap-0.5">
          <SubTabButton
            active={sub === "claude"}
            onClick={() => setSub("claude")}
            icon={<ClaudeIcon className="size-3.5" />}
            label="Claude Code"
            count={claudeCount}
          />
          <SubTabButton
            active={sub === "codex"}
            onClick={() => setSub("codex")}
            icon={<CodexIcon className="size-3.5" />}
            label="Codex"
            count={codexCount}
          />
        </div>
        <button
          onClick={load}
          className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          title="Refresh"
        >
          <RefreshCw size={12} className={cn(loading && "animate-spin")} />
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {loading && !data ? (
          <Centered>
            <Loader2 size={18} className="animate-spin text-[var(--text-tertiary)]" />
          </Centered>
        ) : !projectPath ? (
          <Centered>
            <p className="text-[12px] text-[var(--text-tertiary)]">
              Open a project to view agent memory.
            </p>
          </Centered>
        ) : sub === "claude" ? (
          <ClaudeView claude={data?.claude ?? null} />
        ) : (
          <CodexView codex={data?.codex ?? null} />
        )}
      </div>
    </div>
  );
}

function SubTabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-2.5 h-[24px] rounded-md text-[11px] font-medium transition-colors cursor-pointer",
        active
          ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
      )}
    >
      <span className={cn(active ? "opacity-100" : "opacity-60")}>{icon}</span>
      {label}
      {count > 0 && (
        <span
          className={cn(
            "ml-0.5 px-1 rounded-full text-[9px] tabular-nums",
            active
              ? "bg-[var(--bg-elevated-2)] text-[var(--text-secondary)]"
              : "bg-[var(--bg-elevated)] text-[var(--text-tertiary)]",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="h-full flex items-center justify-center">{children}</div>;
}

// ── Claude: markdown master-detail ──────────────────────────────────────────

interface ClaudeItem {
  id: string;
  title: string;
  subtitle: string;
  badge: string | null;
  body: string;
  section: "Instructions" | "Index" | "Memories";
}

const KIND_TINT: Record<string, string> = {
  user: "var(--status-info)",
  feedback: "var(--status-warning)",
  project: "var(--accent-primary)",
  reference: "var(--text-tertiary)",
};

function ClaudeView({ claude }: { claude: ClaudeMemory | null }) {
  const items = useMemo<ClaudeItem[]>(() => {
    if (!claude) return [];
    const out: ClaudeItem[] = [];
    if (claude.project_md)
      out.push({
        id: "claude-md",
        title: "CLAUDE.md",
        subtitle: "Project instructions",
        badge: null,
        body: claude.project_md,
        section: "Instructions",
      });
    if (claude.global_md)
      out.push({
        id: "claude-md-global",
        title: "CLAUDE.md",
        subtitle: "Global (~/.claude)",
        badge: null,
        body: claude.global_md,
        section: "Instructions",
      });
    if (claude.index)
      out.push({
        id: "index",
        title: "Memory Index",
        subtitle: "MEMORY.md",
        badge: null,
        body: claude.index,
        section: "Index",
      });
    for (const e of claude.entries)
      out.push({
        id: e.name,
        title: e.title,
        subtitle: e.description,
        badge: e.kind || null,
        body: e.body,
        section: "Memories",
      });
    return out;
  }, [claude]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    items.find((i) => i.id === selectedId) ?? items[0] ?? null;

  const grouped = useMemo(() => {
    const order: ClaudeItem["section"][] = ["Instructions", "Index", "Memories"];
    return order
      .map((section) => ({ section, items: items.filter((i) => i.section === section) }))
      .filter((g) => g.items.length > 0);
  }, [items]);

  if (!claude || items.length === 0) {
    return (
      <Centered>
        <div className="text-center space-y-1.5 max-w-[300px] px-4">
          <ClaudeIcon className="size-6 mx-auto opacity-40" />
          <p className="text-[12px] text-[var(--text-secondary)]">No Claude memory yet</p>
          <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
            Claude Code writes per-project memory to{" "}
            <code className="text-[10px] break-all">
              {claude?.memory_dir ?? "~/.claude/projects/…/memory"}
            </code>{" "}
            as you work.
          </p>
        </div>
      </Centered>
    );
  }

  return (
    <div className="h-full flex">
      {/* List rail */}
      <aside className="w-[252px] shrink-0 border-r border-[var(--border-default)] overflow-y-auto hide-scrollbar bg-[var(--bg-sidebar)]">
        {grouped.map((g) => (
          <div key={g.section}>
            <div className="sticky top-0 z-10 px-3 py-1.5 bg-[var(--bg-sidebar)] text-[9px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] border-b border-[var(--border-subtle)]">
              {g.section}
            </div>
            {g.items.map((it) => {
              const active = selected?.id === it.id;
              return (
                <button
                  key={it.id}
                  onClick={() => setSelectedId(it.id)}
                  className={cn(
                    "w-full text-left px-3 py-2 border-b border-[var(--border-subtle)] transition-colors cursor-pointer flex flex-col gap-0.5",
                    active
                      ? "bg-[var(--bg-selected)]"
                      : "hover:bg-[var(--bg-hover)]",
                  )}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    {it.badge && (
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: KIND_TINT[it.badge] ?? "var(--text-tertiary)" }}
                      />
                    )}
                    <span
                      className={cn(
                        "text-[11px] truncate",
                        active
                          ? "text-[var(--text-primary)] font-medium"
                          : "text-[var(--text-secondary)]",
                      )}
                    >
                      {it.title}
                    </span>
                  </div>
                  {it.subtitle && (
                    <span className="text-[10px] text-[var(--text-tertiary)] line-clamp-2 leading-snug">
                      {it.subtitle}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </aside>

      {/* Detail */}
      <main className="flex-1 min-w-0 overflow-y-auto hide-scrollbar">
        {selected && (
          <div className="px-6 py-5 max-w-[760px] mx-auto">
            <div className="flex items-center gap-2 mb-3">
              {selected.badge ? (
                <span
                  className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide"
                  style={{
                    color: KIND_TINT[selected.badge] ?? "var(--text-tertiary)",
                    background: "var(--bg-elevated)",
                  }}
                >
                  {selected.badge}
                </span>
              ) : (
                <FileText size={12} className="text-[var(--text-tertiary)]" />
              )}
              <span className="text-[10px] text-[var(--text-tertiary)] font-mono">
                {selected.subtitle || selected.title}
              </span>
            </div>
            <Markdown className="text-[12.5px]">{selected.body}</Markdown>
          </div>
        )}
      </main>
    </div>
  );
}

// ── Codex: full-bleed sessions data table (mirrors the BYOK keys panel) ──────

// Shared column tracks so the sticky header and every row line up. Session
// grows; the rest are fixed. A min-width track keeps columns from collapsing
// when the panel is narrow (the table scrolls horizontally instead).
const COL = {
  session: "flex-1 min-w-[280px]",
  model: "w-[150px] shrink-0",
  branch: "w-[130px] shrink-0",
  approval: "w-[120px] shrink-0",
  tokens: "w-[90px] shrink-0",
  updated: "w-[110px] shrink-0",
  chevron: "w-[32px] shrink-0",
} as const;
const TABLE_MIN_W = 280 + 150 + 130 + 120 + 90 + 110 + 32; // 912

function CodexView({ codex }: { codex: CodexMemory | null }) {
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAgents, setShowAgents] = useState(false);

  const hasAgents = !!(codex?.agents_md || codex?.global_agents_md);

  const rows = useMemo(() => {
    const list = codex?.threads ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (t) =>
        (t.title || "").toLowerCase().includes(q) ||
        (t.first_user_message || "").toLowerCase().includes(q) ||
        (t.model || "").toLowerCase().includes(q) ||
        (t.git_branch || "").toLowerCase().includes(q),
    );
  }, [codex, query]);

  if (!codex) {
    return (
      <Centered>
        <Loader2 size={18} className="animate-spin text-[var(--text-tertiary)]" />
      </Centered>
    );
  }

  if (codex.threads.length === 0 && !hasAgents) {
    return (
      <Centered>
        <div className="text-center space-y-1.5 max-w-[320px] px-4">
          <CodexIcon className="size-6 mx-auto opacity-40" />
          <p className="text-[12px] text-[var(--text-secondary)]">No Codex memory yet</p>
          <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
            Codex tracks per-project sessions in its state database and reads an{" "}
            <code className="text-[10px]">AGENTS.md</code> if present. Run Codex in this
            project to populate it.
          </p>
        </div>
      </Centered>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[var(--bg-base)]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-[40px] shrink-0 border-b border-[var(--border-default)]">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          Sessions
          <span className="ml-1.5 text-[9px] text-[var(--text-tertiary)] tabular-nums">
            {codex.threads.length}
          </span>
        </span>

        <div className="flex-1" />

        {hasAgents && (
          <button
            onClick={() => setShowAgents((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 h-6 rounded-md border px-2 text-[11px] transition-colors cursor-pointer",
              showAgents
                ? "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
            )}
            title="Toggle AGENTS.md"
          >
            <BookText size={11} />
            AGENTS.md
          </button>
        )}

        <div className="flex items-center gap-1.5 h-6 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 w-[200px] focus-within:border-[var(--border-strong)]">
          <Search size={11} className="text-[var(--text-tertiary)] shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
          />
        </div>
      </div>

      {/* AGENTS.md drawer */}
      {showAgents && hasAgents && (
        <div className="shrink-0 max-h-[40%] overflow-y-auto hide-scrollbar border-b border-[var(--border-default)] bg-[var(--bg-sidebar)] px-4 py-3 space-y-2">
          {codex.agents_md && (
            <AgentsCard label="AGENTS.md · project" body={codex.agents_md} />
          )}
          {codex.global_agents_md && (
            <AgentsCard label="AGENTS.md · global" body={codex.global_agents_md} />
          )}
        </div>
      )}

      {/* Table — both-axis scroll, min-width track, sticky header. */}
      <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
        <div style={{ minWidth: TABLE_MIN_W }}>
          <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-[var(--border-default)] bg-[var(--bg-base)] px-3 text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
            <span className={COL.session}>Session</span>
            <span className={COL.model}>Model</span>
            <span className={COL.branch}>Branch</span>
            <span className={COL.approval}>Approval</span>
            <span className={cn(COL.tokens, "text-right")}>Tokens</span>
            <span className={cn(COL.updated, "text-right")}>Updated</span>
            <span className={COL.chevron} />
          </div>

          {rows.length === 0 ? (
            <div className="grid place-items-center h-[160px] text-[11px] text-[var(--text-tertiary)]">
              No sessions match.
            </div>
          ) : (
            rows.map((t) => (
              <CodexRow
                key={t.id || `${t.created_at}-${t.updated_at}`}
                thread={t}
                expanded={expandedId === (t.id || `${t.created_at}`)}
                onToggle={() => {
                  const k = t.id || `${t.created_at}`;
                  setExpandedId((cur) => (cur === k ? null : k));
                }}
              />
            ))
          )}
        </div>
      </div>

      {codex.db_path && (
        <div className="shrink-0 border-t border-[var(--border-subtle)] px-3 h-[22px] flex items-center text-[9px] text-[var(--text-ghost)] font-mono truncate">
          {codex.db_path}
        </div>
      )}
    </div>
  );
}

function CodexRow({
  thread: t,
  expanded,
  onToggle,
}: {
  thread: CodexThread;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-[var(--border-subtle)]">
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center h-[40px] px-3 text-left transition-colors",
          expanded ? "bg-[var(--bg-elevated)]/50" : "hover:bg-[var(--bg-hover)]",
        )}
      >
        <span className={cn(COL.session, "min-w-0 pr-3")}>
          <span className="block truncate text-[12px] text-[var(--text-primary)]">
            {cleanTitle(t.title || t.first_user_message) || "Untitled session"}
          </span>
        </span>
        <span className={cn(COL.model, "truncate font-mono text-[10px] text-[var(--text-tertiary)]")}>
          {t.model || "—"}
        </span>
        <span className={cn(COL.branch, "truncate")}>
          {t.git_branch ? (
            <span className="font-mono text-[11px] text-[var(--text-secondary)]">
              {t.git_branch}
            </span>
          ) : (
            <span className="text-[var(--text-ghost)]">—</span>
          )}
        </span>
        <span className={COL.approval}>
          {t.approval_mode ? (
            <span className="px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-tertiary)] text-[10px]">
              {t.approval_mode}
            </span>
          ) : (
            <span className="text-[var(--text-ghost)] text-[11px]">—</span>
          )}
        </span>
        <span className={cn(COL.tokens, "text-right tabular-nums text-[11px] text-[var(--text-tertiary)]")}>
          {t.tokens_used ? formatTokens(t.tokens_used) : "—"}
        </span>
        <span className={cn(COL.updated, "text-right text-[10px] text-[var(--text-tertiary)]")}>
          {t.updated_at
            ? timeAgo(new Date(t.updated_at * 1000).toISOString(), { suffix: true })
            : "—"}
        </span>
        <span className={cn(COL.chevron, "flex items-center justify-end text-[var(--text-tertiary)]")}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {expanded && <CodexDetail thread={t} />}
    </div>
  );
}

function CodexDetail({ thread: t }: { thread: CodexThread }) {
  const message = (t.first_user_message || t.title || "").trim();
  return (
    <div className="bg-[var(--bg-elevated)]/40 border-t border-[var(--border-subtle)] px-4 py-4">
      {/* Metadata chips */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3">
        <MetaChip icon={Cpu} label="Model" value={t.model || "—"} mono />
        <MetaChip icon={GitBranch} label="Branch" value={t.git_branch || "—"} mono />
        <MetaChip icon={ShieldCheck} label="Approval" value={t.approval_mode || "—"} />
        <MetaChip
          icon={Coins}
          label="Tokens"
          value={t.tokens_used ? t.tokens_used.toLocaleString() : "—"}
        />
        <MetaChip icon={Clock} label="Started" value={fmtDateTime(t.created_at)} />
        <MetaChip icon={Clock} label="Updated" value={fmtDateTime(t.updated_at)} />
      </div>

      {/* Full first-message content */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-base)] overflow-hidden">
        <div className="flex items-center gap-1.5 px-3 h-[26px] border-b border-[var(--border-subtle)] bg-[var(--bg-elevated-2)]">
          <FileText size={11} className="text-[var(--text-tertiary)]" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
            First message
          </span>
        </div>
        <div className="px-4 py-3 max-h-[420px] overflow-y-auto hide-scrollbar">
          {message ? (
            <Markdown className="text-[12px]">{message}</Markdown>
          ) : (
            <p className="text-[11px] text-[var(--text-tertiary)]">No message recorded.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function MetaChip({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon size={11} className="text-[var(--text-ghost)]" />
      <span className="text-[10px] text-[var(--text-tertiary)]">{label}</span>
      <span
        className={cn(
          "text-[11px] text-[var(--text-secondary)]",
          mono && "font-mono",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function AgentsCard({ label, body }: { label: string; body: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 h-[28px] border-b border-[var(--border-subtle)] bg-[var(--bg-elevated-2)]">
        <BookText size={11} className="text-[var(--text-tertiary)]" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
          {label}
        </span>
      </div>
      <div className="px-4 py-3">
        <Markdown className="text-[12px]">{body}</Markdown>
      </div>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Strip the appended Atlas-context block + collapse whitespace for table rows. */
function cleanTitle(s: string): string {
  const cut = s.split("\n---\n")[0] ?? s;
  return cut.replace(/\s+/g, " ").trim();
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function fmtDateTime(sec: number): string {
  if (!sec) return "—";
  return new Date(sec * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
