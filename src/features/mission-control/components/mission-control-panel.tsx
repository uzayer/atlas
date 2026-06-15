import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  ShieldCheck,
  ScrollText,
  Coins,
  FolderGit2,
} from "lucide-react";
import { useWorkspaceStore, type Workspace } from "@/features/workspaces/stores/workspace-store";

// Mirrors `commands::claude::ProjectUsage` (serialized snake_case).
interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  request_count: number;
  total_cost_usd: number;
  session_count: number;
}
interface ProjectUsage {
  totals: UsageTotals;
  sessions: unknown[];
}

// Mirrors `commands::memory_policy::Policy`.
interface Policy {
  id: string;
  key: string;
  hint: string;
  value: string;
  source: string;
  file_path: string;
  doc_title: string;
  score: number;
}

interface LogEntry {
  id: string;
  timestamp: string;
  source: string;
  kind: string;
  summary: string;
  projectName?: string;
}

const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
const fmtCost = (n: number) => `$${n.toFixed(2)}`;

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Activity;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 text-[var(--text-secondary)]">
        <Icon size={14} className="text-[var(--accent-primary)]" />
        <h2 className="text-[12px] font-semibold uppercase tracking-wide">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function UsageGrid({ workspaces }: { workspaces: Workspace[] }) {
  const [usage, setUsage] = useState<Record<string, ProjectUsage>>({});

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      workspaces.map(async (w) => {
        try {
          const u = await invoke<ProjectUsage>("project_usage_stats", { cwd: w.path });
          return [w.id, u] as const;
        } catch {
          return [w.id, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setUsage(Object.fromEntries(entries.filter(([, u]) => u)) as Record<string, ProjectUsage>);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaces.map((w) => w.id).join("|")]);

  if (workspaces.length === 0)
    return <p className="text-[12px] text-[var(--text-tertiary)]">No open workspaces.</p>;

  return (
    <div className="grid grid-cols-2 gap-2">
      {workspaces.map((w) => {
        const t = usage[w.id]?.totals;
        return (
          <div
            key={w.id}
            className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 space-y-2"
          >
            <div className="flex items-center gap-2 min-w-0">
              <FolderGit2 size={13} style={{ color: w.color ?? "var(--accent-primary)" }} />
              <span className="text-[12px] font-medium text-[var(--text-primary)] truncate">
                {w.name}
              </span>
            </div>
            {t ? (
              <div className="flex items-center gap-4 text-[11px] text-[var(--text-secondary)]">
                <span className="flex items-center gap-1">
                  <Coins size={11} className="text-[var(--text-tertiary)]" />
                  {fmtCost(t.total_cost_usd)}
                </span>
                <span title="input → output tokens">
                  {fmtTokens(t.input_tokens)} → {fmtTokens(t.output_tokens)}
                </span>
                <span className="text-[var(--text-tertiary)]">{t.session_count} sess</span>
              </div>
            ) : (
              <p className="text-[11px] text-[var(--text-tertiary)]">No usage recorded.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PolicyList({ workspaces }: { workspaces: Workspace[] }) {
  const [policies, setPolicies] = useState<Record<string, Policy[]>>({});

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      workspaces.map(async (w) => {
        try {
          const p = await invoke<Policy[]>("memory_policies", { projectPath: w.path });
          return [w.id, p] as const;
        } catch {
          return [w.id, []] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setPolicies(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [workspaces.map((w) => w.id).join("|")]);

  const all = workspaces.flatMap((w) =>
    (policies[w.id] ?? []).map((p) => ({ ...p, workspace: w.name })),
  );
  if (all.length === 0)
    return <p className="text-[12px] text-[var(--text-tertiary)]">No agent policies detected.</p>;

  return (
    <div className="space-y-1">
      {all.map((p, i) => (
        <div
          key={`${p.id}-${i}`}
          className="flex items-start gap-3 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2"
        >
          <span className="text-[11px] font-medium text-[var(--text-primary)] w-32 shrink-0">
            {p.key}
          </span>
          <span className="text-[11px] text-[var(--text-secondary)] flex-1 min-w-0">{p.value}</span>
          <span className="text-[9px] text-[var(--text-tertiary)] uppercase shrink-0">{p.source}</span>
        </div>
      ))}
    </div>
  );
}

function parseJsonl<T>(raw: string): T[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

function LogStream({ workspaces }: { workspaces: Workspace[] }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const perProject = await Promise.all(
        workspaces.map((w) =>
          invoke<string>("load_project_log", { project: w.path })
            .then((raw) => parseJsonl<LogEntry>(raw))
            .catch(() => [] as LogEntry[]),
        ),
      );
      const pinned = await invoke<string>("load_pinned_log")
        .then((raw) => parseJsonl<LogEntry>(raw))
        .catch(() => [] as LogEntry[]);
      if (cancelled) return;
      const merged = [...perProject.flat(), ...pinned]
        .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
        .slice(0, 100);
      setLogs(merged);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaces.map((w) => w.id).join("|")]);

  if (logs.length === 0)
    return <p className="text-[12px] text-[var(--text-tertiary)]">No activity yet.</p>;

  return (
    <div className="space-y-0.5 font-mono">
      {logs.map((l) => (
        <div key={l.id} className="flex items-center gap-2 text-[11px] px-1 py-0.5">
          <span className="text-[var(--text-tertiary)] shrink-0">
            {new Date(l.timestamp).toLocaleTimeString()}
          </span>
          <span className="text-[var(--accent-primary)] shrink-0 w-16 truncate">{l.source}</span>
          {l.projectName && (
            <span className="text-[var(--text-tertiary)] shrink-0 w-24 truncate">{l.projectName}</span>
          )}
          <span className="text-[var(--text-secondary)] truncate">{l.summary}</span>
        </div>
      ))}
    </div>
  );
}

export function MissionControlPanel() {
  const workspaces = useWorkspaceStore.use.workspaces();

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-base)]">
      <div className="max-w-4xl mx-auto p-6 space-y-8">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">Mission Control</h1>
          <p className="text-[12px] text-[var(--text-tertiary)]">
            Usage, agent policies and activity across all {workspaces.length} workspace
            {workspaces.length === 1 ? "" : "s"}.
          </p>
        </div>

        <Section icon={Activity} title="Project Usage">
          <UsageGrid workspaces={workspaces} />
        </Section>

        <Section icon={ShieldCheck} title="Agent Policies">
          <PolicyList workspaces={workspaces} />
        </Section>

        <Section icon={ScrollText} title="Activity">
          <LogStream workspaces={workspaces} />
        </Section>
      </div>
    </div>
  );
}
