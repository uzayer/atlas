// Shared Cross-Agent Memory (v2) — Memory panel "Shared" view.
//
// Surfaces the per-project shared event log's derived state so the user can see
// what all agents (Claude, Codex, …) are collectively working from: the active
// plan, cross-agent decisions, failures to avoid, architecture notes, recent
// file changes, and standing facts — plus an on-demand query and a clear action.
// Read-only mirror of the Rust `state.json`; refresh re-reads it.
//
// Styling follows DESIGN_PRINCIPLES.md: AMOLED surface ladder + 1px hairlines
// (no boxed cards), semantic tokens only, `.eyebrow` group labels, mono/tabular
// numerics. Color is spent ONLY on per-agent identity (§2.3) — agent marks use
// the sanctioned `--agent-*-chip` tints + real logos. Motion is 120–200ms
// ease-out on transform/opacity only and reduced-motion-aware. Full interaction
// states: skeleton load / composed empty / tactile press / staggered reveal /
// collapsible groups / cockpit stat strip.

import { useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Trash2,
  X,
  Share2,
  Search,
  ChevronRight,
  Lightbulb,
  TriangleAlert,
  Boxes,
  FileDiff,
  Info,
  ListChecks,
} from "lucide-react";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { ClaudeIcon, CodexIcon } from "@/components/agent-icons";
import { useSharedMemoryStore } from "../stores/shared-memory-store";
import type { ChangeView } from "../lib/shared-memory-api";

interface Props {
  projectPath: string;
  className?: string;
}

interface TextItem {
  seq: number;
  agent: string;
  text: string;
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/* Per-agent identity — the one place DESIGN_PRINCIPLES sanctions color (§2.3). */
function agentMeta(agent: string): {
  Icon: typeof ClaudeIcon | null;
  tint: string;
  label: string;
} {
  const a = agent.toLowerCase();
  if (a.includes("codex"))
    return { Icon: CodexIcon, tint: "var(--agent-codex-chip-bg)", label: "Codex" };
  if (a.includes("claude"))
    return { Icon: ClaudeIcon, tint: "var(--agent-claude-chip-bg)", label: "Claude" };
  return { Icon: null, tint: "var(--bg-elevated)", label: agent.split(/[-_]/)[0] || agent };
}

export function SharedMemoryView({ projectPath, className }: Props) {
  const state = useSharedMemoryStore.use.state();
  const loaded = useSharedMemoryStore.use.loaded();
  const queryText = useSharedMemoryStore.use.queryText();
  const queryResults = useSharedMemoryStore.use.queryResults();
  const { load, refresh, runQuery, clear } = useSharedMemoryStore.use.actions();

  useEffect(() => {
    if (projectPath) void load(projectPath);
  }, [projectPath, load]);

  const reduced = useMemo(prefersReducedMotion, []);
  const searching = queryText.trim().length > 0;

  const textSections: {
    key: string;
    title: string;
    Icon: typeof Lightbulb;
    items: TextItem[];
  }[] = [
    { key: "decisions", title: "Decisions", Icon: Lightbulb, items: state.decisions },
    { key: "failures", title: "Failures / avoid", Icon: TriangleAlert, items: state.failures },
    { key: "architecture", title: "Architecture", Icon: Boxes, items: state.architecture },
    { key: "facts", title: "Facts", Icon: Info, items: state.facts },
  ];

  const stats = [
    { Icon: Lightbulb, label: "decisions", n: state.decisions.length },
    { Icon: TriangleAlert, label: "failures", n: state.failures.length },
    { Icon: Boxes, label: "arch", n: state.architecture.length },
    { Icon: FileDiff, label: "files", n: state.recentChanges.length },
    { Icon: Info, label: "facts", n: state.facts.length },
  ].filter((s) => s.n > 0);

  const isEmpty = !state.activePlan && stats.length === 0;

  return (
    <div
      className={`flex h-full flex-col text-[13px] text-[var(--text-secondary)] ${className ?? ""}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
        <div className="flex items-baseline gap-2">
          <span className="eyebrow">Shared Cross-Agent Memory</span>
          {loaded && state.lastSeq > 0 && (
            <span className="font-mono text-[10px] tabular-nums text-[var(--text-ghost)]">
              {state.lastSeq} events
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Refresh" onClick={() => void refresh()}>
            <RefreshCw size={12} />
          </IconButton>
          <IconButton label="Clear shared memory" onClick={() => void clear()}>
            <Trash2 size={12} />
          </IconButton>
        </div>
      </div>

      {/* Search */}
      <div className="px-4 pb-2">
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-ghost)]"
          />
          <input
            value={queryText}
            onChange={(e) => void runQuery(e.target.value)}
            placeholder="Search shared memory…"
            className="h-7 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] pl-7 pr-7 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-focus)] focus-visible:border-[var(--border-focus)]"
          />
          {searching && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => void runQuery("")}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] active:scale-[0.94]"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Cockpit stat strip */}
      {!searching && loaded && !isEmpty && (
        <div className="mx-4 mb-2 flex divide-x divide-[var(--border-subtle)] overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)]">
          {stats.map((s) => (
            <div key={s.label} className="flex flex-1 items-center justify-center gap-1.5 py-1.5">
              <s.Icon size={11} className="text-[var(--text-tertiary)]" />
              <span className="font-mono text-[12px] tabular-nums text-[var(--text-primary)]">
                {s.n}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-[var(--text-ghost)]">
                {s.label}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {searching ? (
          <Collapsible title="Results" Icon={Search} count={queryResults.length}>
            {queryResults.length === 0 ? (
              <Muted>No events match “{queryText.trim()}”.</Muted>
            ) : (
              <Group>
                {queryResults.map((e, i) => (
                  <Row key={e.seq} agent={e.agent} index={i} reduced={reduced}>
                    <span className="mr-1.5 font-mono text-[10px] uppercase text-[var(--text-ghost)]">
                      {e.kind.replace("_", " ")}
                    </span>
                    {String(
                      e.payload.text ??
                        e.payload.path ??
                        e.payload.summary ??
                        e.key ??
                        "",
                    )}
                  </Row>
                ))}
              </Group>
            )}
          </Collapsible>
        ) : !loaded ? (
          <div className="pt-2">
            <PanelSkeleton rows={6} />
          </div>
        ) : isEmpty ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-4 pt-1">
            {state.activePlan && (
              <Collapsible title="Active plan" Icon={ListChecks}>
                <Group>
                  <Row agent={state.activePlan.agent} index={0} reduced={reduced}>
                    <pre className="whitespace-pre-wrap font-sans leading-[1.55]">
                      {state.activePlan.text}
                    </pre>
                  </Row>
                </Group>
              </Collapsible>
            )}

            {textSections.map(
              (sec) =>
                sec.items.length > 0 && (
                  <Collapsible
                    key={sec.key}
                    title={sec.title}
                    Icon={sec.Icon}
                    count={sec.items.length}
                  >
                    <Group>
                      {[...sec.items].reverse().map((it, i) => (
                        <Row key={it.seq} agent={it.agent} index={i} reduced={reduced}>
                          {it.text}
                        </Row>
                      ))}
                    </Group>
                  </Collapsible>
                ),
            )}

            {state.recentChanges.length > 0 && (
              <Collapsible
                title="Recent changes"
                Icon={FileDiff}
                count={state.recentChanges.length}
              >
                <Group>
                  {[...state.recentChanges].reverse().map((c: ChangeView, i) => (
                    <Row key={c.seq} agent={c.agent} index={i} reduced={reduced}>
                      <span className="font-mono text-[12px] text-[var(--text-primary)]">
                        {c.path}
                      </span>
                      {c.summary ? (
                        <span className="text-[var(--text-tertiary)]"> — {c.summary}</span>
                      ) : null}
                    </Row>
                  ))}
                </Group>
              </Collapsible>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Primitives ────────────────────────────────────────────────────────────── */

/** Collapsible group: eyebrow + icon + count header that toggles its rows. */
function Collapsible({
  title,
  Icon,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  Icon: typeof Lightbulb;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-1.5 text-left"
      >
        <ChevronRight
          size={11}
          className={`text-[var(--text-ghost)] transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        <Icon size={11} className="text-[var(--text-tertiary)]" />
        <span className="eyebrow group-hover:text-[var(--text-secondary)]">{title}</span>
        {count !== undefined && (
          <span className="font-mono text-[10px] tabular-nums text-[var(--text-ghost)]">
            {count}
          </span>
        )}
      </button>
      {open && children}
    </div>
  );
}

/** Bordered container with hairline-divided rows — the Atlas "group, don't box" idiom. */
function Group({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-md border border-[var(--border-default)]">
      {children}
    </div>
  );
}

function Row({
  agent,
  index,
  reduced,
  children,
}: {
  agent: string;
  index: number;
  reduced: boolean;
  children: React.ReactNode;
}) {
  const [shown, setShown] = useState(reduced);
  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setShown(true), Math.min(index, 12) * 24);
    return () => clearTimeout(t);
  }, [index, reduced]);

  return (
    <div
      className={`px-2.5 py-2 transition-[opacity,transform] duration-200 ease-out hover:bg-[var(--bg-hover)] ${
        shown ? "translate-y-0 opacity-100" : "translate-y-[3px] opacity-0"
      }`}
    >
      <AgentMark agent={agent} />
      <div className="mt-1 text-[var(--text-secondary)]">{children}</div>
    </div>
  );
}

/** Tinted identity mark: agent logo on its sanctioned chip tint + short name. */
function AgentMark({ agent }: { agent: string }) {
  const { Icon, tint, label } = agentMeta(agent);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="flex h-4 w-4 items-center justify-center rounded-sm border border-[var(--border-default)]"
        style={{ background: tint }}
      >
        {Icon ? (
          <Icon className="size-2.5" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-tertiary)]" />
        )}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
        {label}
      </span>
    </span>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded-md border border-[var(--border-default)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] active:scale-[0.96]"
    >
      {children}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 pt-16 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[var(--text-tertiary)]">
        <Share2 size={16} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-medium text-[var(--text-secondary)]">
          No shared memory yet
        </span>
        <p className="max-w-[34ch] text-[12px] leading-[1.5] text-[var(--text-tertiary)]">
          As agents plan, decide, and edit files, their work is captured here and
          shared with every agent on this project.
        </p>
      </div>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-0.5 py-1 text-[12px] leading-[1.5] text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}
