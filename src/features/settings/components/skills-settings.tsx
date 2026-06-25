// Settings → Skills: the control-plane home for the user's skill library.
//
// Skills are always invokable with `#skill:` in the composer — that rail reaches
// every ACP agent regardless of delivery. This surface manages the ONE canonical
// library and *projects* each skill into the tools the user chooses (Claude Code,
// Codex, …): a master list on the left, and a per-skill **tool × scope matrix**
// on the right where each cell is a click-to-toggle projection (symlink primary,
// copy fallback). Drifted / external cells are never silently overwritten.
//
// AMOLED: hairline rows, white-on-black, single accent, no cards (DESIGN §5).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Puzzle,
  RefreshCw,
  Search,
  Snowflake,
  ArrowUpCircle,
  Pencil,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { AtlasLoader } from "@/components/atlas-loader";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { CachedMarkdown } from "@/lib/markdown-cache";
import { openFile } from "@/lib/open-file";
import { useProjectStore } from "@/features/project/stores/project-store";
import { skills as api } from "@/features/skills/lib/skills-api";
import type {
  PackComponentMeta,
  ProjectionCell,
  ReconcileView,
  Scope,
  ToolInfo,
} from "@/features/skills/lib/types";
import {
  Legend,
  StatusToken,
} from "@/features/skills/components/projection-toggles";

/** A skill unified across both scopes for the master list + matrix. */
interface MergedSkill {
  name: string;
  description: string;
  managedGlobal: boolean;
  managedProject: boolean;
  /** Owning pack when this skill is pack-delivered (read-only in My Skills). */
  pack?: string | null;
}

const SCOPES_ALL: Scope[] = ["global", "project"];

export function SkillsSettings() {
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;

  const [global, setGlobal] = useState<ReconcileView | null>(null);
  const [project, setProject] = useState<ReconcileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedComp, setSelectedComp] = useState<PackComponentMeta | null>(
    null,
  );
  const [components, setComponents] = useState<PackComponentMeta[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, p, cg, cp] = await Promise.all([
        api.reconcile("global", null),
        projectPath
          ? api.reconcile("project", projectPath)
          : Promise.resolve(null),
        api.componentsList("global", null),
        projectPath
          ? api.componentsList("project", projectPath)
          : Promise.resolve([] as PackComponentMeta[]),
      ]);
      setGlobal(g);
      setProject(p);
      // Dedupe pack components across scopes by (kind, pack, name).
      const byKey = new Map<string, PackComponentMeta>();
      for (const c of [...cg, ...cp]) {
        byKey.set(`${c.kind}:${c.pack}:${c.name}`, c);
      }
      setComponents([...byKey.values()]);
    } catch (e) {
      toast.error(
        `Couldn't reconcile skills: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const viewFor = (scope: Scope) => (scope === "global" ? global : project);

  // The tool registry is identical across scopes — take it from whichever view
  // resolved first.
  const tools: ToolInfo[] = global?.tools ?? project?.tools ?? [];

  const scopesShown: Scope[] = useMemo(
    () => (projectPath ? SCOPES_ALL : ["global"]),
    [projectPath],
  );

  // Merge the two reconciled views into one library list keyed by skill name.
  const merged: MergedSkill[] = useMemo(() => {
    const byName = new Map<string, MergedSkill>();
    const ingest = (v: ReconcileView | null, scope: Scope) => {
      if (!v) return;
      for (const s of v.skills) {
        const cur = byName.get(s.name) ?? {
          name: s.name,
          description: s.description,
          managedGlobal: false,
          managedProject: false,
          pack: null as string | null,
        };
        if (!cur.description && s.description) cur.description = s.description;
        if (scope === "global" && s.managed) cur.managedGlobal = true;
        if (scope === "project" && s.managed) cur.managedProject = true;
        if (!cur.pack && s.pack) cur.pack = s.pack;
        byName.set(s.name, cur);
      }
    };
    ingest(global, "global");
    ingest(project, "project");
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [global, project]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return merged;
    return merged.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [merged, query]);

  const filteredComponents = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? components.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.description.toLowerCase().includes(q) ||
            c.kind.includes(q),
        )
      : components;
    return [...list].sort((a, b) =>
      a.kind !== b.kind
        ? a.kind.localeCompare(b.kind)
        : a.name.localeCompare(b.name),
    );
  }, [components, query]);

  const selectedSkill = useMemo(
    () => filtered.find((s) => s.name === selected) ?? null,
    [filtered, selected],
  );

  // ── Keyboard navigation (↑/↓ through skills then pack components) ────────────
  const compKey = (c: PackComponentMeta) => `${c.kind}:${c.pack}:${c.name}`;
  const navItems = useMemo(
    () => [
      ...filtered.map((s) => ({ kind: "skill" as const, skill: s })),
      ...filteredComponents.map((c) => ({ kind: "comp" as const, comp: c })),
    ],
    [filtered, filteredComponents],
  );
  const currentNavIndex = useMemo(() => {
    if (selectedComp) {
      const k = compKey(selectedComp);
      return navItems.findIndex(
        (it) => it.kind === "comp" && compKey(it.comp) === k,
      );
    }
    if (selected)
      return navItems.findIndex(
        (it) => it.kind === "skill" && it.skill.name === selected,
      );
    return -1;
  }, [navItems, selected, selectedComp]);
  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (navItems.length === 0) return;
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const base = currentNavIndex < 0 ? (delta === 1 ? -1 : 0) : currentNavIndex;
      const next = Math.max(0, Math.min(navItems.length - 1, base + delta));
      const it = navItems[next];
      if (!it) return;
      if (it.kind === "skill") {
        setSelectedComp(null);
        setSelected(it.skill.name);
      } else {
        setSelected(null);
        setSelectedComp(it.comp);
      }
    },
    [navItems, currentNavIndex],
  );

  // ── Cell helpers ──────────────────────────────────────────────────────────

  const cellFor = (
    name: string,
    scope: Scope,
    toolId: string,
  ): ProjectionCell => {
    const v = viewFor(scope);
    const skill = v?.skills.find((s) => s.name === name);
    return (
      skill?.cells.find((c) => c.tool === toolId) ?? {
        tool: toolId,
        scope,
        status: "absent",
        mode: null,
      }
    );
  };

  const managedAt = (name: string, scope: Scope): boolean => {
    const v = viewFor(scope);
    return v?.skills.find((s) => s.name === name)?.managed ?? false;
  };

  const toolDetected = (tool: ToolInfo, scope: Scope): boolean =>
    scope === "global" ? tool.detectedGlobal : tool.detectedProject;

  const canonicalScope = (s: MergedSkill): Scope | null =>
    s.managedGlobal ? "global" : s.managedProject ? "project" : null;

  const rootFor = (scope: Scope) => (scope === "project" ? projectPath : null);

  // ── Mutations ───────────────────────────────────────────────────────────────

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy((b) => new Set(b).add(key));
    try {
      await fn();
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(key);
        return next;
      });
    }
  };

  const toggleCell = (name: string, scope: Scope, tool: ToolInfo) => {
    const cell = cellFor(name, scope, tool.id);
    if (!toolDetected(tool, scope)) {
      toast.error(`${tool.displayName} isn't installed for ${scope} scope.`);
      return;
    }
    const key = `${scope}:${tool.id}:${name}`;
    switch (cell.status) {
      case "synced":
        void withBusy(key, () =>
          api.unproject(scope, name, tool.id, rootFor(scope)),
        );
        return;
      case "absent":
        if (!managedAt(name, scope)) {
          toast.error(
            scope === "project"
              ? "Promote this skill to a project skill first."
              : "This skill isn't in your global library yet.",
          );
          return;
        }
        void withBusy(key, () =>
          api.project(scope, name, tool.id, false, rootFor(scope)),
        );
        return;
      case "drifted":
      case "conflict":
        toast.error(
          `"${name}" was edited outside Atlas in ${tool.displayName}. Open both and reconcile manually — Atlas won't overwrite it.`,
        );
        return;
      case "external":
        toast.error(
          `"${name}" is an external skill ${tool.displayName} owns. Adopt it into your library first.`,
        );
        return;
      case "pack":
        toast.error(
          `"${name}" is delivered by pack "${cell.pack ?? ""}". Manage its tools in the Packs tab.`,
        );
        return;
      case "canonical":
        return; // the source row — nothing to toggle
    }
  };

  const availableEverywhere = (s: MergedSkill) => {
    const scope = canonicalScope(s);
    if (!scope) {
      toast.error("Adopt this skill into your library first.");
      return;
    }
    void withBusy(`all:${s.name}`, async () => {
      for (const tool of tools) {
        if (!toolDetected(tool, scope)) continue;
        const cell = cellFor(s.name, scope, tool.id);
        if (cell.status === "absent") {
          await api.project(scope, s.name, tool.id, false, rootFor(scope));
        }
      }
    });
  };

  const promote = (s: MergedSkill) => {
    if (!projectPath || !s.managedProject) return;
    void withBusy(`promote:${s.name}`, async () => {
      await api.promote(s.name, projectPath);
      toast.success(`Promoted "${s.name}" to your global library`);
    });
  };

  const freezeAll = () => {
    void withBusy("freeze", async () => {
      await api.freeze("global", null);
      if (projectPath) await api.freeze("project", projectPath);
      toast.success("Froze all projections to real copies");
    });
  };

  const openInEditor = async (s: MergedSkill) => {
    const scope = canonicalScope(s);
    if (!scope) return;
    try {
      openFile(await api.path(scope, s.name, rootFor(scope)));
    } catch (e) {
      toast.error(
        `Couldn't open: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const remove = (s: MergedSkill) => {
    const scope = canonicalScope(s);
    if (!scope) return;
    void withBusy(`del:${s.name}`, async () => {
      await api.delete(scope, s.name, rootFor(scope));
      if (selected === s.name) setSelected(null);
      toast.success(`Deleted "${s.name}"`);
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 space-y-4 p-6 pb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Skills</h2>
            <p className="mt-0.5 text-[11px] leading-snug text-text-tertiary">
              Invoke with{" "}
              <span className="font-mono text-text-secondary">#skill:</span> in
              chat · projected into the tools you choose.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <IconButton title="Refresh" onClick={() => void load()}>
              <RefreshCw size={12} className={cn(loading && "animate-spin")} />
            </IconButton>
            <IconButton
              title="Freeze all projections into real copies (uninstall safety)"
              onClick={freezeAll}
              disabled={busy.has("freeze")}
            >
              <Snowflake size={12} />
            </IconButton>
          </div>
        </div>

        <div className="flex h-7 w-full max-w-[320px] items-center gap-1.5 rounded-md border border-border-default bg-bg-input px-2 transition-colors focus-within:border-border-strong focus-within:ring-1 focus-within:ring-border-strong">
          <Search size={11} className="shrink-0 text-text-tertiary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter skills & pack components…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
      </div>

      {/* Body: list + matrix detail */}
      <div className="flex min-h-0 flex-1 border-t border-border-subtle">
        {/* Master list */}
        <div
          tabIndex={0}
          onKeyDown={onListKeyDown}
          className="w-[300px] shrink-0 overflow-y-auto hide-scrollbar border-r border-border-subtle outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong"
        >
          {loading ? (
            <PanelSkeleton rows={8} />
          ) : filtered.length === 0 && filteredComponents.length === 0 ? (
            <Empty>
              <Puzzle size={16} className="mb-1 text-text-ghost" />
              {query.trim()
                ? "Nothing matches your filter."
                : "No skills yet. Create one to start your library."}
            </Empty>
          ) : (
            <>
              {filtered.map((s) => (
                <SkillListRow
                  key={s.name}
                  skill={s}
                  active={!selectedComp && s.name === selected}
                  summary={statusSummary(s, tools, scopesShown, cellFor)}
                  onClick={() => {
                    setSelectedComp(null);
                    setSelected(s.name);
                  }}
                />
              ))}
              {filteredComponents.length > 0 && (
                <div className="eyebrow border-t border-border-subtle bg-bg-raised px-3 py-1.5">
                  Pack Components
                </div>
              )}
              {filteredComponents.map((c) => {
                const key = `${c.kind}:${c.pack}:${c.name}`;
                return (
                  <ComponentListRow
                    key={key}
                    comp={c}
                    active={
                      !!selectedComp &&
                      `${selectedComp.kind}:${selectedComp.pack}:${selectedComp.name}` ===
                        key
                    }
                    onClick={() => {
                      setSelected(null);
                      setSelectedComp(c);
                    }}
                  />
                );
              })}
            </>
          )}
        </div>

        {/* Detail / matrix */}
        <div
          key={selectedComp ? `c:${selectedComp.pack}:${selectedComp.name}` : `s:${selected ?? ""}`}
          className="min-w-0 flex-1 overflow-y-auto hide-scrollbar animate-fade-in"
        >
          {selectedComp ? (
            <ComponentDetail comp={selectedComp} />
          ) : !selectedSkill ? (
            <Empty>
              <Zap size={18} className="text-text-ghost" />
              <span className="text-text-secondary">Nothing selected</span>
              Pick a skill to manage where it's delivered, or a pack component to
              see how to invoke it.
            </Empty>
          ) : (
            <SkillMatrix
              skill={selectedSkill}
              tools={tools}
              scopes={scopesShown}
              cellFor={cellFor}
              toolDetected={toolDetected}
              busy={busy}
              hasProject={projectPath !== null}
              projectPath={projectPath}
              onToggle={toggleCell}
              onAvailableEverywhere={() => availableEverywhere(selectedSkill)}
              onPromote={() => promote(selectedSkill)}
              onEdit={() => void openInEditor(selectedSkill)}
              onDelete={() => remove(selectedSkill)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Master-list row ───────────────────────────────────────────────────────────

function SkillListRow({
  skill,
  active,
  summary,
  onClick,
}: {
  skill: MergedSkill;
  active: boolean;
  summary: { synced: number; warn: boolean; external: boolean };
  onClick: () => void;
}) {
  const managed = skill.managedGlobal || skill.managedProject;
  const fromPack = !managed && skill.pack;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 border-b border-border-subtle px-3 py-2.5 text-left outline-none transition-colors active:bg-bg-active",
        active ? "bg-bg-selected" : "hover:bg-bg-hover",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-text-primary">
            {skill.name}
          </span>
          {fromPack ? (
            <Tag title={`Delivered by pack "${skill.pack}"`}>
              pack: {skill.pack}
            </Tag>
          ) : (
            !managed && <Tag>external</Tag>
          )}
        </div>
        <p className="mt-0.5 line-clamp-1 text-[11px] text-text-tertiary">
          {skill.description || "No description."}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums">
        {summary.warn && <span className="text-warning">drift</span>}
        {summary.synced > 0 && (
          <span className="inline-flex items-center gap-1 text-text-secondary">
            <span className="dot" />
            {summary.synced}
          </span>
        )}
      </div>
    </button>
  );
}

// ── Pack-component row + read-only detail ───────────────────────────────────────

function ComponentListRow({
  comp,
  active,
  onClick,
}: {
  comp: PackComponentMeta;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 border-b border-border-subtle px-3 py-2.5 text-left outline-none transition-colors active:bg-bg-active",
        active ? "bg-bg-selected" : "hover:bg-bg-hover",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-text-primary">
            {comp.name}
          </span>
          <Tag>{comp.kind}</Tag>
        </div>
        <p className="mt-0.5 line-clamp-1 text-[11px] text-text-tertiary">
          {comp.description || `from pack: ${comp.pack}`}
        </p>
      </div>
      <span className="shrink-0 font-mono text-[9px] text-text-ghost">
        #{comp.kind}:
      </span>
    </button>
  );
}

function ComponentDetail({ comp }: { comp: PackComponentMeta }) {
  return (
    <div className="space-y-5 p-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-[13px] font-semibold text-text-primary">
            {comp.name}
          </h3>
          <Tag>{comp.kind}</Tag>
          <Tag title={`Delivered by pack "${comp.pack}"`}>
            pack: {comp.pack}
          </Tag>
        </div>
        <p className="mt-0.5 text-[11px] text-text-tertiary">
          {comp.description || "No description."}
        </p>
      </div>

      <div className="border-t border-border-subtle pt-4">
        <div className="eyebrow">Invoke</div>
        <code className="mt-2 inline-block rounded-sm bg-bg-raised px-1.5 py-0.5 font-mono text-[11px] text-text-primary">
          #{comp.kind}:{comp.name}
        </code>
        <p className="mt-2 text-[11px] leading-snug text-text-tertiary">
          Type this in chat to inline its body for any agent. Delivery into a
          tool (Claude Code / Codex) is managed from the Packs tab.
        </p>
      </div>

      <p className="text-[10px] leading-snug text-text-tertiary">
        Pack component · read-only here · source{" "}
        <span className="font-mono">{comp.relPath}</span>
      </p>
    </div>
  );
}

// ── Matrix detail ─────────────────────────────────────────────────────────────

function SkillMatrix({
  skill,
  tools,
  scopes,
  cellFor,
  toolDetected,
  busy,
  hasProject,
  projectPath,
  onToggle,
  onAvailableEverywhere,
  onPromote,
  onEdit,
  onDelete,
}: {
  skill: MergedSkill;
  tools: ToolInfo[];
  scopes: Scope[];
  cellFor: (name: string, scope: Scope, toolId: string) => ProjectionCell;
  toolDetected: (tool: ToolInfo, scope: Scope) => boolean;
  busy: Set<string>;
  hasProject: boolean;
  projectPath: string | null;
  onToggle: (name: string, scope: Scope, tool: ToolInfo) => void;
  onAvailableEverywhere: () => void;
  onPromote: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const managed = skill.managedGlobal || skill.managedProject;
  const canPromote = hasProject && skill.managedProject && !skill.managedGlobal;
  const fromPack = !managed && !!skill.pack;

  // Where to read the SKILL.md body from: a project-only managed skill reads at
  // project scope; everything else (global, pack-provided) reads at global,
  // where `read_skill` falls back to the pack store.
  const readScope: Scope =
    skill.managedProject && !skill.managedGlobal ? "project" : "global";
  const bodyProjectPath = readScope === "project" ? projectPath : null;
  const packTools = fromPack
    ? tools
        .filter((t) =>
          scopes.some((s) => cellFor(skill.name, s, t.id).status === "pack"),
        )
        .map((t) => t.displayName)
    : [];

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[13px] font-semibold text-text-primary">
              {skill.name}
            </h3>
            {fromPack ? (
              <Tag title={`Delivered by pack "${skill.pack}"`}>
                pack: {skill.pack}
              </Tag>
            ) : (
              !managed && <Tag>external</Tag>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-text-tertiary">
            {skill.description || "No description."}
          </p>
        </div>
        {managed && (
          <div className="flex shrink-0 items-center gap-1">
            <IconButton title="Open SKILL.md" onClick={onEdit}>
              <Pencil size={12} />
            </IconButton>
            <IconButton title="Delete skill" danger onClick={onDelete}>
              <Trash2 size={12} />
            </IconButton>
          </div>
        )}
      </div>

      {/* Bulk actions */}
      {managed && (
        <div className="flex flex-wrap items-center gap-2">
          <SmallButton
            onClick={onAvailableEverywhere}
            busy={busy.has(`all:${skill.name}`)}
          >
            Available everywhere
          </SmallButton>
          {canPromote && (
            <SmallButton
              onClick={onPromote}
              busy={busy.has(`promote:${skill.name}`)}
            >
              <ArrowUpCircle size={11} />
              Promote to global
            </SmallButton>
          )}
        </div>
      )}

      {/* Delivery — a compact line for pack skills (read-only), the actionable
          tool × scope matrix for your own skills. */}
      {fromPack ? (
        <p className="text-[11px] leading-snug text-text-tertiary">
          Delivered by pack{" "}
          <span className="text-text-secondary">{skill.pack}</span>
          {packTools.length > 0
            ? ` · in ${packTools.join(", ")}`
            : " · not projected into a tool"}
          {" · "}
          <span className="font-mono text-text-secondary">
            #skill:{skill.name}
          </span>
          . Manage delivery in the Packs tab.
        </p>
      ) : (
        <>
          <div className="overflow-hidden rounded border border-border-default">
            <div
              className="grid"
              style={{
                gridTemplateColumns: `120px repeat(${tools.length}, 1fr)`,
              }}
            >
              <Th>Scope</Th>
              {tools.map((t) => (
                <Th key={t.id}>{t.displayName}</Th>
              ))}
              {scopes.map((scope) => (
                <MatrixRow
                  key={scope}
                  scope={scope}
                  tools={tools}
                  skillName={skill.name}
                  cellFor={cellFor}
                  toolDetected={toolDetected}
                  busy={busy}
                  onToggle={onToggle}
                />
              ))}
            </div>
          </div>
          <Legend />
          <p className="text-[10px] leading-snug text-text-tertiary">
            Click a cell to symlink (or unlink) this skill in that tool. Drifted
            or external cells are never overwritten; resolve those by hand.
          </p>
        </>
      )}

      {/* About — the skill's actual content (SKILL.md body). */}
      <SkillBody
        scope={readScope}
        name={skill.name}
        projectPath={bodyProjectPath}
      />
    </div>
  );
}

/** Fetches and renders a skill's SKILL.md body (resolves pack skills too).
 *  Renders nothing when the body is empty or unreadable (e.g. an un-adopted
 *  external skill). */
function SkillBody({
  scope,
  name,
  projectPath,
}: {
  scope: Scope;
  name: string;
  projectPath: string | null;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setBody(null);
    api
      .read(scope, name, projectPath)
      .then((c) => {
        if (alive) {
          setBody(c.body.trim() || null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) {
          setBody(null);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [scope, name, projectPath]);

  if (loading) {
    return (
      <div className="border-t border-border-subtle pt-4">
        <div className="eyebrow mb-2">About</div>
        <PanelSkeleton rows={5} className="p-0" />
      </div>
    );
  }
  if (!body) return null;

  return (
    <div className="border-t border-border-subtle pt-4">
      <div className="eyebrow mb-2">About</div>
      <CachedMarkdown
        source={body}
        className="prose-chat text-[12px] text-text-secondary"
      />
    </div>
  );
}

function MatrixRow({
  scope,
  tools,
  skillName,
  cellFor,
  toolDetected,
  busy,
  readOnly,
  onToggle,
}: {
  scope: Scope;
  tools: ToolInfo[];
  skillName: string;
  cellFor: (name: string, scope: Scope, toolId: string) => ProjectionCell;
  toolDetected: (tool: ToolInfo, scope: Scope) => boolean;
  busy: Set<string>;
  readOnly?: boolean;
  onToggle: (name: string, scope: Scope, tool: ToolInfo) => void;
}) {
  return (
    <>
      <div className="flex items-center border-t border-border-subtle px-3 py-2 text-[11px] capitalize text-text-secondary">
        {scope}
      </div>
      {tools.map((tool) => {
        const cell = cellFor(skillName, scope, tool.id);
        const detected = toolDetected(tool, scope);
        const key = `${scope}:${tool.id}:${skillName}`;
        return (
          <div
            key={tool.id}
            className="flex items-center justify-center border-l border-t border-border-subtle px-2 py-2"
          >
            <StatusToken
              status={cell.status}
              mode={cell.mode}
              detected={detected}
              busy={busy.has(key)}
              readOnly={readOnly}
              onClick={() => onToggle(skillName, scope, tool)}
            />
          </div>
        );
      })}
    </>
  );
}

// ── Small shared bits ─────────────────────────────────────────────────────────

/** Compact per-row status summary for the master list. */
function statusSummary(
  skill: MergedSkill,
  tools: ToolInfo[],
  scopes: Scope[],
  cellFor: (name: string, scope: Scope, toolId: string) => ProjectionCell,
): { synced: number; warn: boolean; external: boolean } {
  let synced = 0;
  let warn = false;
  let external = false;
  for (const scope of scopes) {
    for (const t of tools) {
      const c = cellFor(skill.name, scope, t.id);
      if (c.status === "synced") synced += 1;
      if (c.status === "drifted" || c.status === "conflict") warn = true;
      if (c.status === "external") external = true;
    }
  }
  return { synced, warn, external };
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <div className="eyebrow border-b border-border-default bg-bg-raised px-3 py-2">
      {children}
    </div>
  );
}

function Tag({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex h-[18px] max-w-[140px] items-center truncate rounded-full border border-border-default bg-bg-raised px-2 text-[10px] text-text-tertiary"
    >
      {children}
    </span>
  );
}

function IconButton({
  children,
  title,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md border border-border-default text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50",
        danger && "hover:border-error/40 hover:bg-error/10 hover:text-error",
      )}
    >
      {children}
    </button>
  );
}

function SmallButton({
  children,
  onClick,
  busy,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex h-7 items-center gap-1 rounded-md border border-border-default bg-bg-elevated px-2.5 text-[11px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-50"
    >
      {busy ? <AtlasLoader size={11} /> : children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 py-10 text-center text-[11px] leading-snug text-text-tertiary">
      {children}
    </div>
  );
}
