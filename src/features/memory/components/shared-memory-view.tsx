// Shared Cross-Agent Memory (v2) — Memory panel "Shared" view.
//
// Surfaces the per-project shared event log's derived state so the user can see
// what all agents (Claude, Codex, …) are collectively working from: the active
// plan, cross-agent decisions, recent file changes, and standing facts — plus
// an on-demand query and a clear action. Read-only mirror of the Rust
// `state.json`; refresh re-reads it. Styling follows the AMOLED hairline system.

import { useEffect } from "react";
import { useSharedMemoryStore } from "../stores/shared-memory-store";

interface Props {
  projectPath: string;
  className?: string;
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

  const isEmpty =
    !state.activePlan &&
    state.decisions.length === 0 &&
    state.recentChanges.length === 0 &&
    state.facts.length === 0;

  return (
    <div className={`flex flex-col gap-4 text-sm text-white/90 ${className ?? ""}`}>
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-white/50">
          Shared Cross-Agent Memory
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded border border-white/15 px-2 py-1 text-xs text-white/70 hover:bg-white/10"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void clear()}
            className="rounded border border-white/15 px-2 py-1 text-xs text-white/50 hover:bg-white/10 hover:text-red-300"
          >
            Clear
          </button>
        </div>
      </div>

      <input
        value={queryText}
        onChange={(e) => void runQuery(e.target.value)}
        placeholder="Search shared memory…"
        className="w-full rounded border border-white/15 bg-transparent px-2 py-1 text-xs text-white placeholder:text-white/30 focus:border-white/40 focus:outline-none"
      />

      {queryText.trim() ? (
        <Section title={`Results (${queryResults.length})`}>
          {queryResults.length === 0 ? (
            <Muted>No matching events.</Muted>
          ) : (
            queryResults.map((e) => (
              <Row key={e.seq} agent={e.agent}>
                <span className="text-white/40">[{e.kind}]</span>{" "}
                {String(e.payload.text ?? e.payload.path ?? e.payload.summary ?? e.key ?? "")}
              </Row>
            ))
          )}
        </Section>
      ) : !loaded ? (
        <Muted>Loading…</Muted>
      ) : isEmpty ? (
        <Muted>
          No shared memory yet. As agents plan, decide, and edit files, their
          work is captured here and shared across every agent on this project.
        </Muted>
      ) : (
        <>
          {state.activePlan && (
            <Section title="Active plan">
              <Row agent={state.activePlan.agent}>
                <pre className="whitespace-pre-wrap font-sans">
                  {state.activePlan.text}
                </pre>
              </Row>
            </Section>
          )}

          {state.decisions.length > 0 && (
            <Section title={`Decisions (${state.decisions.length})`}>
              {[...state.decisions].reverse().map((d) => (
                <Row key={d.seq} agent={d.agent}>
                  {d.text}
                </Row>
              ))}
            </Section>
          )}

          {state.recentChanges.length > 0 && (
            <Section title={`Recent changes (${state.recentChanges.length})`}>
              {[...state.recentChanges].reverse().map((c) => (
                <Row key={c.seq} agent={c.agent}>
                  <span className="text-white/80">{c.path}</span>
                  {c.summary ? <span className="text-white/50"> — {c.summary}</span> : null}
                </Row>
              ))}
            </Section>
          )}

          {state.facts.length > 0 && (
            <Section title={`Facts (${state.facts.length})`}>
              {[...state.facts].reverse().map((f) => (
                <Row key={f.seq} agent={f.agent}>
                  {f.text}
                </Row>
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-medium text-white/60">{title}</div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function Row({ agent, children }: { agent: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-white/10 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-white/35">{agent}</div>
      <div className="text-white/90">{children}</div>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-white/40">{children}</div>;
}
