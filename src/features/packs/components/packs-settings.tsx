// Settings → Packs. Browse the skills.sh registry, install a pack (one source
// repo → all its components), and project each installed pack into a tool.
// Disk is the source of truth (Rust owns the store/lock/projections); every
// mutation refetches rather than locally patching. AMOLED design tokens +
// the shared `StatusToken` so this surface is a companion to My Skills.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpCircle,
  Check,
  Download,
  Package,
  RefreshCw,
  Search,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { AtlasLoader } from "@/components/atlas-loader";
import { useProjectStore } from "@/features/project/stores/project-store";
import { skills as skillsApi } from "@/features/skills/lib/skills-api";
import type { AgentTarget } from "@/features/skills/lib/types";
import { StatusToken } from "@/features/skills/components/projection-toggles";

import { packs as packsApi } from "../lib/packs-api";
import type {
  ComponentKind,
  InstalledPack,
  PackSearchHit,
  Scope,
} from "../lib/types";

const KIND_LABEL: Record<ComponentKind, string> = {
  skill: "Skills",
  agent: "Agents",
  command: "Commands",
  hook: "Hooks",
  rule: "Rules",
  script: "Scripts",
};

function kindCounts(components: { kind: ComponentKind }[]): string {
  const counts = new Map<ComponentKind, number>();
  for (const c of components) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, n]) => `${n} ${KIND_LABEL[kind].toLowerCase()}`)
    .join(" · ");
}

/** State of a pack row's Check/Update control. */
type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "uptodate"
  | "updating";

export function PacksSettings({ scope }: { scope: Scope }) {
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<PackSearchHit[]>([]);
  const [installed, setInstalled] = useState<InstalledPack[]>([]);
  const [tools, setTools] = useState<AgentTarget[]>([]);
  /** packName → set of toolIds currently projected. */
  const [projected, setProjected] = useState<Record<string, Set<string>>>({});
  /** packName → state of its Check/Update control. */
  const [updateState, setUpdateState] = useState<Record<string, UpdateState>>(
    {},
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effectiveProject = scope === "project" ? projectPath : null;
  const projectMissing = scope === "project" && !projectPath;

  const refreshInstalled = useCallback(async () => {
    if (projectMissing) {
      setInstalled([]);
      setProjected({});
      return;
    }
    const list = await packsApi.list(scope, effectiveProject);
    setInstalled(list);
    const entries = await Promise.all(
      list.map(async (p) => {
        const views = await packsApi.projections(
          scope,
          p.pack.name,
          effectiveProject,
        );
        return [p.pack.name, new Set(views.map((v) => v.tool))] as const;
      }),
    );
    setProjected(Object.fromEntries(entries));
  }, [scope, effectiveProject, projectMissing]);

  useEffect(() => {
    void skillsApi.toolsList(scope, effectiveProject).then(setTools);
    void refreshInstalled().catch((e) => setError(String(e)));
  }, [scope, effectiveProject, refreshInstalled]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      setResults(await packsApi.search(q));
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }, [query]);

  const installedSources = useMemo(
    () => new Set(installed.map((p) => p.source)),
    [installed],
  );

  const install = useCallback(
    async (source: string) => {
      setBusy(`install:${source}`);
      setError(null);
      try {
        await packsApi.install(scope, source, false, effectiveProject);
        await refreshInstalled();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [scope, effectiveProject, refreshInstalled],
  );

  const toggleProjection = useCallback(
    async (packName: string, toolId: string, on: boolean) => {
      setBusy(`proj:${packName}:${toolId}`);
      setError(null);
      try {
        if (on) {
          await packsApi.project(
            scope,
            packName,
            toolId,
            null,
            false,
            effectiveProject,
          );
        } else {
          await packsApi.unproject(scope, packName, toolId, effectiveProject);
        }
        await refreshInstalled();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [scope, effectiveProject, refreshInstalled],
  );

  const setU = (name: string, s: UpdateState) =>
    setUpdateState((m) => ({ ...m, [name]: s }));

  // Cheap remote-HEAD check (no clone). On a hit, the control morphs to "Update".
  const checkForUpdate = useCallback(
    async (name: string) => {
      setU(name, "checking");
      setError(null);
      try {
        const res = await packsApi.checkUpdate(scope, name, effectiveProject);
        setU(name, res.hasUpdate ? "available" : "uptodate");
        if (!res.hasUpdate) window.setTimeout(() => setU(name, "idle"), 2500);
      } catch (e) {
        setError(String(e));
        setU(name, "idle");
      }
    },
    [scope, effectiveProject],
  );

  // Apply the update: re-install (content-hash dedup), then re-project into the
  // tools it's currently in so snapshot modes (copy/hooks/rules) refresh —
  // symlink projections already follow the store.
  const applyUpdate = useCallback(
    async (name: string, source: string) => {
      setU(name, "updating");
      setError(null);
      try {
        const res = await packsApi.install(scope, source, false, effectiveProject);
        if (res.state === "updated") {
          for (const toolId of projected[name] ?? new Set<string>()) {
            await packsApi.project(
              scope,
              name,
              toolId,
              null,
              true,
              effectiveProject,
            );
          }
        }
        await refreshInstalled();
        setU(name, "uptodate");
        window.setTimeout(() => setU(name, "idle"), 2500);
      } catch (e) {
        setError(String(e));
        setU(name, "available");
      }
    },
    [scope, effectiveProject, projected, refreshInstalled],
  );

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-center gap-2.5">
        <Package size={15} className="shrink-0 text-text-secondary" />
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Packs</h2>
          <p className="mt-0.5 text-[11px] leading-snug text-text-tertiary">
            Install from the registry · project into your agents · invoke with{" "}
            <span className="font-mono text-text-secondary">#</span>.
          </p>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-[11px] text-error">
          {error}
        </div>
      )}

      {projectMissing && (
        <div className="rounded-md border border-border-default bg-bg-raised px-3 py-2 text-[11px] text-text-secondary">
          Open a project to install or project packs at project scope.
        </div>
      )}

      {/* ── Browse ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="flex h-8 items-center gap-1.5 rounded-md border border-border-default bg-bg-input px-2.5 transition-colors focus-within:border-border-strong focus-within:ring-1 focus-within:ring-border-strong">
          <Search size={12} className="shrink-0 text-text-tertiary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void runSearch()}
            placeholder="Search skills.sh · pdf, review, postgres…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
          {searching && <AtlasLoader size={12} className="text-text-tertiary" />}
        </div>

        {results.length > 0 && (
          <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-md border border-border-default">
            {results.map((hit) => {
              const isInstalled = installedSources.has(hit.source);
              const installing = busy === `install:${hit.source}`;
              return (
                <li
                  key={hit.id}
                  className="flex items-center justify-between gap-3 bg-bg-raised px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-medium text-text-primary">
                      {hit.name}
                    </div>
                    <div className="truncate text-[11px] text-text-tertiary">
                      {hit.source} · {hit.installs.toLocaleString()} installs
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={installing || isInstalled || projectMissing}
                    onClick={() => void install(hit.source)}
                    className={cn(
                      "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                      isInstalled
                        ? "cursor-default text-text-tertiary"
                        : "bg-accent text-bg-base hover:bg-accent-hover disabled:opacity-50",
                    )}
                  >
                    {installing ? (
                      <AtlasLoader size={12} />
                    ) : (
                      <Download size={12} />
                    )}
                    {isInstalled ? "Installed" : "Install"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Installed library ──────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="eyebrow">Installed</h3>
          <button
            type="button"
            onClick={() => void refreshInstalled()}
            className="flex items-center gap-1.5 text-[11px] text-text-tertiary transition-colors hover:text-text-primary"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>

        {installed.length === 0 ? (
          <p className="rounded-md border border-dashed border-border-default px-3 py-6 text-center text-[11px] text-text-tertiary">
            No packs installed in this scope yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {installed.map((p) => {
              const projTools = projected[p.pack.name] ?? new Set<string>();
              return (
                <li
                  key={p.pack.name}
                  className="rounded-md border border-border-default bg-bg-raised px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium text-text-primary">
                        {p.pack.name}
                      </div>
                      <div className="truncate text-[11px] text-text-tertiary">
                        {p.source} ·{" "}
                        {kindCounts(p.pack.components) || "no components"}
                      </div>
                    </div>
                    <UpdateControl
                      state={updateState[p.pack.name] ?? "idle"}
                      onCheck={() => void checkForUpdate(p.pack.name)}
                      onUpdate={() => void applyUpdate(p.pack.name, p.source)}
                    />
                  </div>

                  {/* Per-tool projection toggles (shared StatusToken). */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                    {tools.map((t) => {
                      const on = projTools.has(t.id);
                      const working = busy === `proj:${p.pack.name}:${t.id}`;
                      return (
                        <div key={t.id} className="flex items-center gap-1.5">
                          <span className="text-[11px] text-text-secondary">
                            {t.displayName}
                          </span>
                          <StatusToken
                            status={on ? "synced" : "absent"}
                            detected={t.detected}
                            busy={working}
                            onClick={() =>
                              void toggleProjection(p.pack.name, t.id, !on)
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A single control that morphs across the update lifecycle. Fixed width so the
 *  pack row never shifts as the label changes; accent only for the actionable
 *  "Update"; bars loader (not a spinner) while working. */
function UpdateControl({
  state,
  onCheck,
  onUpdate,
}: {
  state: UpdateState;
  onCheck: () => void;
  onUpdate: () => void;
}) {
  const base =
    "inline-flex h-7 min-w-[96px] shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium outline-none transition-colors active:scale-95 focus-visible:ring-1 focus-visible:ring-border-strong";

  switch (state) {
    case "checking":
      return (
        <span
          className={cn(base, "border border-border-default text-text-tertiary")}
        >
          <AtlasLoader size={11} /> Checking
        </span>
      );
    case "updating":
      return (
        <span className={cn(base, "bg-accent text-bg-base")}>
          <AtlasLoader size={11} /> Updating
        </span>
      );
    case "available":
      return (
        <button
          type="button"
          onClick={onUpdate}
          className={cn(base, "bg-accent text-bg-base hover:bg-accent-hover")}
        >
          <ArrowUpCircle size={12} /> Update
        </button>
      );
    case "uptodate":
      return (
        <span
          className={cn(base, "border border-border-subtle text-text-tertiary")}
        >
          <Check size={12} className="animate-scale-in" /> Up to date
        </span>
      );
    default:
      return (
        <button
          type="button"
          onClick={onCheck}
          className={cn(
            base,
            "border border-border-default text-text-secondary hover:bg-bg-hover hover:text-text-primary",
          )}
        >
          <RefreshCw size={12} /> Check
        </button>
      );
  }
}
