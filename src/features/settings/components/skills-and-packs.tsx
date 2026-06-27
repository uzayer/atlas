// Settings → Skills. One home for two surfaces: "My Skills" (author/adopt the
// canonical `.atlas/skills` store, the `#skill:` invoke source) and "Packs"
// (install multi-component packs from the registry and project them). Both are
// full-bleed; this wrapper owns the sub-tab switch and the shared scope control
// so the two surfaces read as one family.

import { useState } from "react";

import { cn } from "@/lib/utils";
import { ScrollArea } from "@/ui/scroll-area";
import { useProjectStore } from "@/features/project/stores/project-store";
import type { Scope } from "@/features/skills/lib/types";

import { SkillsSettings } from "./skills-settings";
import { PacksSettings } from "@/features/packs/components/packs-settings";

type SubTab = "skills" | "packs";

const TABS: { id: SubTab; label: string }[] = [
  { id: "skills", label: "My Skills" },
  { id: "packs", label: "Packs" },
];

export function SkillsAndPacks() {
  const [tab, setTab] = useState<SubTab>("skills");
  const [scope, setScope] = useState<Scope>("global");
  const hasProject = useProjectStore.use.currentProject()?.path != null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border-default px-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "relative h-9 px-3 text-[12px] font-medium transition-colors",
              tab === t.id
                ? "text-text-primary"
                : "text-text-secondary hover:text-text-primary",
            )}
          >
            {t.label}
            {tab === t.id && (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
            )}
          </button>
        ))}

        {/* Shared scope control — drives Packs install/projection and the
            default scope for new skills. */}
        <div className="ml-auto py-1.5">
          <ScopeSelect
            scope={scope}
            onChange={setScope}
            hasProject={hasProject}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "skills" ? (
          <SkillsSettings />
        ) : (
          <ScrollArea className="h-full">
            <PacksSettings scope={scope} />
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

/** Segmented global/project control (project disabled until a project is open). */
function ScopeSelect({
  scope,
  onChange,
  hasProject,
}: {
  scope: Scope;
  onChange: (s: Scope) => void;
  hasProject: boolean;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border-default bg-bg-raised p-0.5">
      {(["global", "project"] as Scope[]).map((s) => {
        const disabled = s === "project" && !hasProject;
        return (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onChange(s)}
            title={
              disabled ? "Open a project to use project scope" : undefined
            }
            className={cn(
              "rounded px-2 py-0.5 text-[11px] font-medium capitalize transition-colors",
              scope === s
                ? "bg-bg-selected text-text-primary"
                : "text-text-tertiary hover:text-text-primary",
              disabled && "cursor-not-allowed opacity-40",
            )}
          >
            {s}
          </button>
        );
      })}
    </div>
  );
}
