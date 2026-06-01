import * as Dialog from "@radix-ui/react-dialog";
import { Shield, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useChatStore } from "../stores/chat-store";
import { agents } from "../lib/agents-api";
import { cn } from "@/lib/utils";
import { Kbd } from "@/ui/kbd";
import type { PermissionOptionRef, PendingPermission } from "@/types/acp";

function isAllow(kind: string) {
  return kind === "allow_once" || kind === "allow_always";
}
function isReject(kind: string) {
  return kind === "reject_once" || kind === "reject_always";
}

interface PermissionModalProps {
  tabId: string;
}

/**
 * Renders the head of the pending-permission queue for whichever ACP session
 * is bound to this tab. Cancelled requests (ESC / click outside) resolve as
 * `cancelled` on the wire so the agent backs off correctly.
 */
export function PermissionModal({ tabId }: PermissionModalProps) {
  // Narrow subscription: we only care about this tab's acpSessionId
  // and the head of its permission queue. The previous broad
  // `useChatStore.use.sessions()` + `useChatStore.use.pendingPermissions()`
  // pair re-rendered this modal on every streaming chunk because the
  // top-level `sessions` map identity flips on each tail mutation.
  // Subscribing to only the values we read keeps the modal idle until
  // a permission actually arrives.
  const acpSessionId = useChatStore(
    (s) => s.sessions[tabId]?.acpSessionId,
  );
  const current = useChatStore((s) => {
    if (!acpSessionId) return undefined;
    return s.pendingPermissions[acpSessionId]?.[0];
  });
  const queueLength = useChatStore((s) => {
    if (!acpSessionId) return 0;
    return s.pendingPermissions[acpSessionId]?.length ?? 0;
  });
  const popPermission = useChatStore.use.actions().popPermission;

  if (!current) return null;

  const resolve = (optId: string) => {
    agents
      .respondPermission(
        current.agentId,
        current.acpSessionId,
        current.requestId,
        { kind: "selected", option_id: optId }
      )
      .catch((e) => toast.error(`Permission send failed: ${e}`))
      .finally(() => popPermission(current.acpSessionId, current.requestId));
  };

  const cancel = () => {
    agents
      .respondPermission(
        current.agentId,
        current.acpSessionId,
        current.requestId,
        { kind: "cancelled" }
      )
      .catch((e) => toast.error(`Permission cancel failed: ${e}`))
      .finally(() => popPermission(current.acpSessionId, current.requestId));
  };

  const title = current.toolCall.title ?? current.toolCall.kind ?? "Tool call";
  // Recommended default = the first "allow" option, if any.
  const primaryId = current.options.find((o) => isAllow(o.kind))?.optionId;

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[480px] max-w-[92vw] rounded-md border border-border-default bg-bg-elevated",
            "shadow-[var(--shadow-overlay)] animate-scale-in",
            "text-text-primary"
          )}
        >
          <div className="flex items-start gap-3 border-b border-border-default px-4 py-3">
            <Shield className="mt-0.5 size-4 text-accent" />
            <div className="flex-1">
              <Dialog.Title className="text-sm font-medium">
                Permission required
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-text-secondary">
                The agent wants to run {" "}
                <span className="font-mono text-text-primary">{title}</span>.
              </Dialog.Description>
            </div>
          </div>

          {queueLength > 1 && (
            <div className="border-b border-border-default bg-bg-base px-4 py-1.5 text-[11px] text-text-secondary">
              {queueLength - 1} more pending after this
            </div>
          )}

          <ToolCallPreview tc={current.toolCall} />

          <div className="flex flex-col gap-1.5 px-4 py-3">
            {current.options.map((opt) => (
              <PermissionButton
                key={opt.optionId}
                option={opt}
                // The first "allow" option is the recommended default —
                // autofocus + the accent (white) primary-button look, so
                // Enter triggers it and it's visually unmistakable.
                isPrimary={opt.optionId === primaryId}
                onSelect={() => resolve(opt.optionId)}
              />
            ))}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border-default px-4 py-2.5">
            <button
              type="button"
              onClick={cancel}
              className="inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-base hover:text-text-primary transition-colors"
            >
              Cancel
              <Kbd>esc</Kbd>
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PermissionButton({
  option,
  isPrimary,
  onSelect,
}: {
  option: PermissionOptionRef;
  isPrimary?: boolean;
  onSelect: () => void;
}) {
  const allow = isAllow(option.kind);
  const reject = isReject(option.kind);
  const Icon = allow ? CheckCircle2 : reject ? XCircle : AlertTriangle;

  // Monochrome theme: the recommended action is the accent (white)
  // "default button"; reject carries the only chromatic signal (error
  // red); neutral options stay quiet. No off-palette greens.
  const tone = isPrimary
    ? "border-transparent bg-[var(--accent-primary)] text-[var(--bg-base)] hover:bg-[var(--accent-primary-hover)]"
    : reject
      ? "border-border-default bg-bg-base text-[var(--status-error)] hover:bg-[var(--status-error-muted)]"
      : "border-border-default bg-bg-base text-text-primary hover:bg-bg-hover";

  return (
    <button
      type="button"
      autoFocus={isPrimary}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2 rounded-sm border px-3 py-2 text-left text-xs transition-colors outline-none",
        isPrimary && "focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30",
        tone
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="flex-1 font-medium">{option.name}</span>
      {isPrimary ? (
        <Kbd className="border-[var(--bg-base)]/20 bg-[var(--bg-base)]/10 text-[var(--bg-base)]">
          ↵
        </Kbd>
      ) : (
        <span className="text-[10px] uppercase tracking-wide text-text-secondary">
          {option.kind.replace(/_/g, " ")}
        </span>
      )}
    </button>
  );
}

function ToolCallPreview({ tc }: { tc: PendingPermission["toolCall"] }) {
  // Best-effort surfacing of common fields. We render the input as JSON so the
  // user can see exactly what's about to run.
  const inputValue = (tc as Record<string, unknown>).rawInput ?? (tc as Record<string, unknown>).input;
  const formatted = inputValue !== undefined
    ? safeStringify(inputValue, 2)
    : null;
  if (!formatted) return null;
  return (
    <div className="border-b border-border-default bg-bg-base px-4 py-2">
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-snug text-text-secondary">
        {formatted}
      </pre>
    </div>
  );
}

function safeStringify(v: unknown, indent: number): string {
  try {
    const s = JSON.stringify(v, null, indent);
    return s.length > 4000 ? s.slice(0, 4000) + "\n…(truncated)" : s;
  } catch {
    return String(v);
  }
}
