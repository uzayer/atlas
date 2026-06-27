import { useState } from "react";
import { Loader2, Pencil, Trash2, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentTarget, SkillMeta } from "../lib/types";
import { DeliveryBadge } from "./delivery-badge";

/**
 * One installed skill. For a **managed** skill (in Atlas's `.atlas/skills`
 * store) it shows a per-agent enable toggle for every detected agent plus
 * Edit / Details / Delete; enable/disable maps 1:1 to a symlink on disk. For an
 * **external** skill (a real dir Atlas didn't author, e.g. a globally-installed
 * Claude Code skill) it shows an "external" badge and a primary "Make for all
 * agents" button that adopts it into canonical and fans it out.
 */
export function InstalledRow({
  skill,
  agents,
  busy,
  onToggle,
  onAdopt,
  onEdit,
  onDelete,
  onDetails,
}: {
  skill: SkillMeta;
  agents: AgentTarget[];
  busy: boolean;
  onToggle: (agentId: string, enabled: boolean) => void;
  onAdopt: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDetails: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // Only agents that can actually take a native-dir skill in this scope.
  const targetable = agents.filter(
    (a) => a.detected && a.delivery === "native-dir",
  );

  return (
    <div className="flex items-start gap-3 border-b border-border-subtle px-3 py-2.5 transition-colors hover:bg-bg-hover">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onDetails}
            className="truncate text-left text-[12px] font-medium text-text-primary hover:underline"
          >
            {skill.name}
          </button>
          <DeliveryBadge delivery={skill.delivery} />
          {!skill.managed && <ExternalBadge />}
          {busy && (
            <Loader2 size={11} className="animate-spin text-text-tertiary" />
          )}
        </div>
        <p className="mt-0.5 line-clamp-1 text-[11px] text-text-tertiary">
          {skill.description || "No description."}
        </p>

        {skill.managed ? (
          /* Per-agent enable toggles (managed skills only). */
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {targetable.length === 0 ? (
              <span className="text-[10px] text-text-ghost">
                No skill-capable agents detected in this scope.
              </span>
            ) : (
              targetable.map((agent) => {
                const enabled = skill.enabledAgents.includes(agent.id);
                return (
                  <label
                    key={agent.id}
                    className="flex cursor-pointer items-center gap-1.5 select-none"
                  >
                    <AgentSwitch
                      enabled={enabled}
                      disabled={busy}
                      agentName={agent.displayName}
                      onChange={(v) => onToggle(agent.id, v)}
                    />
                    <span className="text-[10px] text-text-secondary">
                      {agent.displayName}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        ) : (
          /* External skill: offer to adopt it into Atlas for every agent. */
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onAdopt}
              title="Copy into Atlas and symlink into every detected agent"
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-md bg-accent px-2 text-[11px] font-medium text-bg-base transition-colors hover:bg-accent-hover",
                busy && "opacity-50",
              )}
            >
              <Layers size={11} />
              Make for all agents
            </button>
            <span className="text-[10px] text-text-tertiary">
              {skill.enabledAgents.length === 1
                ? "Currently in one agent only."
                : "Not managed by Atlas."}
            </span>
          </div>
        )}
      </div>

      {/* Actions — Edit/Delete operate on the canonical store, so they only
          apply to managed skills. External skills expose adopt instead. */}
      <div className="flex shrink-0 items-center gap-1">
        {!skill.managed ? null : (
          <>
            <button
              type="button"
              onClick={onEdit}
              title="Edit SKILL.md"
              className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <Pencil size={12} />
            </button>
            {confirming ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    onDelete();
                  }}
                  className="h-6 rounded border border-error/40 bg-error/10 px-2 text-[10px] text-error transition-colors hover:bg-error/20"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="h-6 rounded border border-border-default px-2 text-[10px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                title="Delete skill"
                className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-error/10 hover:text-error"
              >
                <Trash2 size={12} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Small pill marking a skill that lives outside Atlas's managed store. */
function ExternalBadge() {
  return (
    <span
      title="Lives directly in an agent's skills dir; not managed by Atlas"
      className="inline-flex h-[18px] items-center rounded-full border border-border-default bg-bg-raised px-2 text-[10px] leading-none text-text-tertiary"
    >
      external
    </span>
  );
}

/** Small AMOLED toggle: hairline track, white knob when on. */
function AgentSwitch({
  enabled,
  disabled,
  agentName,
  onChange,
}: {
  enabled: boolean;
  disabled?: boolean;
  agentName: string;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={agentName}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={cn(
        "relative inline-flex h-[14px] w-[24px] shrink-0 items-center rounded-full border transition-colors duration-150",
        disabled && "opacity-50",
        enabled
          ? "border-transparent bg-accent"
          : "border-border-strong bg-bg-raised",
      )}
    >
      <span
        className={cn(
          "inline-block h-[10px] w-[10px] rounded-full transition-transform duration-150",
          enabled
            ? "translate-x-[11px] bg-bg-base"
            : "translate-x-[1px] bg-text-tertiary",
        )}
      />
    </button>
  );
}
