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
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Snowflake,
  ArrowUpCircle,
  Pencil,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { openFile } from "@/lib/open-file";
import { useProjectStore } from "@/features/project/stores/project-store";
import { skills as api } from "@/features/skills/lib/skills-api";
import type {
  ProjectionCell,
  ProjectionStatus,
  ReconcileView,
  Scope,
  ToolInfo,
} from "@/features/skills/lib/types";
import { SkillCreateDialog } from "@/features/skills/components/skill-create-dialog";

/** A skill unified across both scopes for the master list + matrix. */
interface MergedSkill {
  name: string;
  description: string;
  managedGlobal: boolean;
  managedProject: boolean;
}

const SCOPES_ALL: Scope[] = ["global", "project"];

export function SkillsSettings() {
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;

  const [global, setGlobal] = useState<ReconcileView | null>(null);
  const [project, setProject] = useState<ReconcileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, p] = await Promise.all([
        api.reconcile("global", null),
        projectPath
          ? api.reconcile("project", projectPath)
          : Promise.resolve(null),
      ]);
      setGlobal(g);
      setProject(p);
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
        };
        if (!cur.description && s.description) cur.description = s.description;
        if (scope === "global" && s.managed) cur.managedGlobal = true;
        if (scope === "project" && s.managed) cur.managedProject = true;
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

  const selectedSkill = useMemo(
    () => filtered.find((s) => s.name === selected) ?? null,
    [filtered, selected],
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

  const createScope: Scope = projectPath ? "project" : "global";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 space-y-4 p-6 pb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Skills</h2>
            <p className="mt-0.5 max-w-[560px] text-[11px] leading-snug text-text-tertiary">
              Reusable procedures you invoke with{" "}
              <span className="font-mono text-text-secondary">#skill:</span> in
              chat (works for every agent). One canonical library, projected
              into the tools you choose. Toggle a cell to symlink a skill into
              that tool; Atlas keeps everything in sync.
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
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-medium text-bg-base transition-colors hover:bg-accent-hover"
            >
              <Plus size={12} />
              New skill
            </button>
          </div>
        </div>

        <div className="flex h-7 w-full max-w-[320px] items-center gap-1.5 rounded-md border border-border-default bg-bg-input px-2 focus-within:border-border-strong">
          <Search size={11} className="shrink-0 text-text-tertiary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter skills…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
      </div>

      {/* Body: list + matrix detail */}
      <div className="flex min-h-0 flex-1 border-t border-border-subtle">
        {/* Master list */}
        <div className="w-[300px] shrink-0 overflow-y-auto hide-scrollbar border-r border-border-subtle">
          {loading ? (
            <Empty>
              <Loader2 size={13} className="animate-spin text-text-tertiary" />
            </Empty>
          ) : filtered.length === 0 ? (
            <Empty>
              {query.trim()
                ? "No skills match your filter."
                : "No skills yet. Create one to start your library."}
            </Empty>
          ) : (
            filtered.map((s) => (
              <SkillListRow
                key={s.name}
                skill={s}
                active={s.name === selected}
                summary={statusSummary(s, tools, scopesShown, cellFor)}
                onClick={() => setSelected(s.name)}
              />
            ))
          )}
        </div>

        {/* Detail / matrix */}
        <div className="min-w-0 flex-1 overflow-y-auto hide-scrollbar">
          {!selectedSkill ? (
            <Empty>Select a skill to manage where it's delivered.</Empty>
          ) : (
            <SkillMatrix
              skill={selectedSkill}
              tools={tools}
              scopes={scopesShown}
              cellFor={cellFor}
              toolDetected={toolDetected}
              busy={busy}
              hasProject={projectPath !== null}
              onToggle={toggleCell}
              onAvailableEverywhere={() => availableEverywhere(selectedSkill)}
              onPromote={() => promote(selectedSkill)}
              onEdit={() => void openInEditor(selectedSkill)}
              onDelete={() => remove(selectedSkill)}
            />
          )}
        </div>
      </div>

      <SkillCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        scope={createScope}
        onCreate={async (name, description, body) => {
          await api.create(
            createScope,
            name,
            description,
            body,
            [],
            rootFor(createScope),
          );
          await load();
        }}
      />
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
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 border-b border-border-subtle px-3 py-2.5 text-left transition-colors",
        active ? "bg-bg-selected" : "hover:bg-bg-hover",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-text-primary">
            {skill.name}
          </span>
          {!managed && <Tag>external</Tag>}
        </div>
        <p className="mt-0.5 line-clamp-1 text-[11px] text-text-tertiary">
          {skill.description || "No description."}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
        {summary.warn && <span className="text-warning">drift</span>}
        {summary.synced > 0 && (
          <span className="text-text-secondary">{summary.synced}●</span>
        )}
      </div>
    </button>
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
  onToggle: (name: string, scope: Scope, tool: ToolInfo) => void;
  onAvailableEverywhere: () => void;
  onPromote: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const managed = skill.managedGlobal || skill.managedProject;
  const canPromote = hasProject && skill.managedProject && !skill.managedGlobal;

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[13px] font-semibold text-text-primary">
              {skill.name}
            </h3>
            {!managed && <Tag>external</Tag>}
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

      {/* Tool × scope matrix */}
      <div className="overflow-hidden rounded-lg border border-border-default">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `120px repeat(${tools.length}, 1fr)`,
          }}
        >
          {/* Header row */}
          <Th>Scope</Th>
          {tools.map((t) => (
            <Th key={t.id}>{t.displayName}</Th>
          ))}
          {/* One row per scope */}
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
        Click a cell to symlink (or unlink) this skill in that tool. Drifted or
        external cells are never overwritten — resolve those by hand.
      </p>
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
  onToggle,
}: {
  scope: Scope;
  tools: ToolInfo[];
  skillName: string;
  cellFor: (name: string, scope: Scope, toolId: string) => ProjectionCell;
  toolDetected: (tool: ToolInfo, scope: Scope) => boolean;
  busy: Set<string>;
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
              onClick={() => onToggle(skillName, scope, tool)}
            />
          </div>
        );
      })}
    </>
  );
}

const STATUS_META: Record<
  ProjectionStatus,
  { label: string; cls: string; hint: string }
> = {
  canonical: {
    label: "source",
    cls: "text-text-secondary",
    hint: "Lives in your library",
  },
  synced: {
    label: "on",
    cls: "bg-accent text-bg-base",
    hint: "Projected and in sync — click to remove",
  },
  drifted: {
    label: "drift",
    cls: "text-warning border border-warning/40",
    hint: "Edited outside Atlas — resolve manually",
  },
  external: {
    label: "ext",
    cls: "text-text-tertiary border border-border-default",
    hint: "Owned by the tool — adopt to manage",
  },
  conflict: {
    label: "conflict",
    cls: "text-error border border-error/40",
    hint: "Name collision with different content",
  },
  absent: {
    label: "off",
    cls: "text-text-ghost border border-border-subtle",
    hint: "Not delivered — click to enable",
  },
};

function StatusToken({
  status,
  mode,
  detected,
  busy,
  onClick,
}: {
  status: ProjectionStatus;
  mode: ProjectionCell["mode"];
  detected: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  const meta = STATUS_META[status];
  if (!detected) {
    return (
      <span
        title="Tool not detected in this scope"
        className="text-[10px] text-text-ghost"
      >
        —
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={`${meta.hint}${mode ? ` (${mode})` : ""}`}
      className={cn(
        "inline-flex h-[18px] min-w-[40px] items-center justify-center gap-1 rounded-full px-2 text-[10px] font-medium transition-colors",
        meta.cls,
        busy && "opacity-50",
      )}
    >
      {busy ? <Loader2 size={9} className="animate-spin" /> : meta.label}
    </button>
  );
}

function Legend() {
  const items: ProjectionStatus[] = [
    "synced",
    "absent",
    "drifted",
    "external",
    "conflict",
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {items.map((s) => (
        <span
          key={s}
          className="flex items-center gap-1.5 text-[10px] text-text-tertiary"
        >
          <span
            className={cn(
              "inline-flex h-[14px] min-w-[32px] items-center justify-center rounded-full px-1.5 text-[9px] font-medium",
              STATUS_META[s].cls,
            )}
          >
            {STATUS_META[s].label}
          </span>
          {STATUS_META[s].hint}
        </span>
      ))}
    </div>
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
    <div className="bg-bg-raised px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
      {children}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-[16px] items-center rounded-full border border-border-default bg-bg-raised px-1.5 text-[9px] text-text-tertiary">
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
      {busy && <Loader2 size={11} className="animate-spin" />}
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center gap-1.5 px-6 py-10 text-center text-[11px] leading-snug text-text-tertiary">
      {children}
    </div>
  );
}
