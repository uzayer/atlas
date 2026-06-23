import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, X } from "lucide-react";
import { Markdown } from "@/lib/markdown";
import { skills as skillsApi } from "../lib/skills-api";
import type { Scope, SkillContent, SkillMeta } from "../lib/types";
import { DeliveryBadge } from "./delivery-badge";

/**
 * Read-only detail view for one skill: its frontmatter + rendered SKILL.md
 * body. Editing happens in Atlas's real editor (the body is just a file), so
 * this offers an Edit shortcut rather than an inline textarea.
 */
export function SkillDetail({
  skill,
  scope,
  projectPath,
  onClose,
  onEdit,
}: {
  skill: SkillMeta;
  scope: Scope;
  projectPath: string | null;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [content, setContent] = useState<SkillContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBody = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setContent(null);
    setError(null);
    skillsApi
      .read(scope, skill.name, projectPath)
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, skill.name, projectPath]);

  useEffect(() => fetchBody(), [fetchBody]);

  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col border-l border-border-default bg-bg-sidebar">
      {/* Header */}
      <div className="flex h-[36px] shrink-0 items-center gap-2 border-b border-border-default px-3">
        <span className="truncate text-[12px] font-medium text-text-primary">
          {skill.name}
        </span>
        <DeliveryBadge delivery={skill.delivery} />
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            title="Edit SKILL.md"
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Meta */}
      <div className="shrink-0 space-y-2 border-b border-border-subtle px-3 py-2.5">
        <p className="text-[11px] leading-snug text-text-secondary">
          {skill.description || "No description."}
        </p>
        <div className="flex items-center gap-1.5 text-[10px] text-text-tertiary">
          <span className="font-semibold uppercase tracking-wider">
            Enabled
          </span>
          {skill.enabledAgents.length === 0 ? (
            <span className="text-text-ghost">none</span>
          ) : (
            <span className="text-text-secondary">
              {skill.enabledAgents.join(", ")}
            </span>
          )}
        </div>
        <p className="break-all font-mono text-[9px] text-text-ghost">
          {skill.path}
        </p>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto hide-scrollbar px-3 py-3">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 size={16} className="animate-spin text-text-tertiary" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-[11px] text-error">
              Could not load skill body: {error}
            </p>
            <button
              type="button"
              onClick={() => fetchBody()}
              className="h-6 rounded border border-border-default px-2 text-[10px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              Retry
            </button>
          </div>
        ) : content ? (
          <Markdown className="text-[12px]">
            {content.body || "_(empty body)_"}
          </Markdown>
        ) : (
          <p className="text-[11px] text-text-tertiary">
            Could not load skill body.
          </p>
        )}
      </div>
    </div>
  );
}
