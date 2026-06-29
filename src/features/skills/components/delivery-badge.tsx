import { cn } from "@/lib/utils";
import type { Delivery } from "../lib/types";

const LABELS: Record<Delivery, string> = {
  "native-dir": "native-dir",
  inject: "inject",
  unsupported: "unsupported",
};

/**
 * Capability-tier pill (see plan §4). `native-dir` reads neutral (the v1 happy
 * path); `inject` is amber (a reserved fallback); `unsupported` is ghosted.
 */
export function DeliveryBadge({ delivery }: { delivery: Delivery }) {
  return (
    <span
      title={
        delivery === "native-dir"
          ? "Delivered as files symlinked into the agent's skills dir"
          : delivery === "inject"
            ? "Would be injected as a prompt block (reserved, not built)"
            : "This agent does not support skills"
      }
      className={cn(
        "inline-flex h-[18px] items-center rounded-full border px-2 font-mono text-[10px] leading-none",
        delivery === "native-dir" &&
          "border-border-default bg-bg-raised text-text-tertiary",
        delivery === "inject" && "border-warning/40 bg-warning/10 text-warning",
        delivery === "unsupported" &&
          "border-border-subtle bg-transparent text-text-ghost",
      )}
    >
      {LABELS[delivery]}
    </span>
  );
}
