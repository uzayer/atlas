// Shared projection control for Settings → Skills and Settings → Packs.
//
// One status vocabulary + one token visual so both surfaces read as one family
// (AMOLED design tokens, hairline pills — DESIGN §5). The Skills matrix renders
// `StatusToken` per (skill, tool) cell; the Packs tab renders the same token per
// tool, mapping its projected/not state onto `synced`/`absent`. A `pack` status
// is read-only here — pack-delivered projections are managed in the Packs tab.

import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ProjectionCell, ProjectionStatus } from "@/features/skills/lib/types";

export const STATUS_META: Record<
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
  pack: {
    label: "pack",
    cls: "border border-border-strong bg-bg-raised text-text-secondary",
    hint: "Delivered by a pack — manage it in the Packs tab",
  },
};

/**
 * One projection toggle. Renders a dash when the tool isn't detected, a
 * read-only chip for `pack` (or any `readOnly` cell), and a click-to-toggle pill
 * otherwise. `mode` (`symlink`/`copy`) is surfaced in the tooltip.
 */
export function StatusToken({
  status,
  mode = null,
  detected,
  busy,
  readOnly = false,
  onClick,
}: {
  status: ProjectionStatus;
  mode?: ProjectionCell["mode"];
  detected: boolean;
  busy: boolean;
  readOnly?: boolean;
  onClick?: () => void;
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

  const chip =
    "inline-flex h-[18px] min-w-[40px] items-center justify-center gap-1 rounded-full px-2 text-[10px] font-medium transition-colors";

  // Pack-owned or explicitly read-only → a non-interactive chip.
  if (status === "pack" || readOnly) {
    return (
      <span title={meta.hint} className={cn(chip, meta.cls)}>
        {meta.label}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={`${meta.hint}${mode ? ` (${mode})` : ""}`}
      className={cn(chip, meta.cls, busy && "opacity-50")}
    >
      {busy ? <Loader2 size={9} className="animate-spin" /> : meta.label}
    </button>
  );
}

/** Status legend. Defaults to the statuses a user can actually encounter. */
export function Legend({
  items = ["synced", "absent", "drifted", "external", "conflict", "pack"],
}: {
  items?: ProjectionStatus[];
}) {
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
