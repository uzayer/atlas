import * as Dialog from "@radix-ui/react-dialog";
import { Shield, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useChatStore } from "../stores/chat-store";
import { agents } from "../lib/agents-api";
import { cn } from "@/lib/utils";
import type { PermissionOptionRef, PendingPermission } from "@/types/acp";

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
            "w-[480px] max-w-[92vw] rounded-md border border-border-default bg-bg-elevated shadow-xl",
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
                onSelect={() => resolve(opt.optionId)}
              />
            ))}
          </div>

          <div className="flex justify-end gap-2 border-t border-border-default px-4 py-2.5">
            <button
              type="button"
              onClick={cancel}
              className="rounded-sm px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-base hover:text-text-primary"
            >
              Cancel (ESC)
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PermissionButton({
  option,
  onSelect,
}: {
  option: PermissionOptionRef;
  onSelect: () => void;
}) {
  const Icon =
    option.kind === "allow_once" || option.kind === "allow_always"
      ? CheckCircle2
      : option.kind === "reject_once" || option.kind === "reject_always"
        ? XCircle
        : AlertTriangle;
  const tone =
    option.kind === "allow_once" || option.kind === "allow_always"
      ? "text-green-400 hover:bg-green-500/10"
      : option.kind === "reject_once" || option.kind === "reject_always"
        ? "text-red-400 hover:bg-red-500/10"
        : "text-text-primary hover:bg-bg-base";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2 rounded-sm border border-border-default bg-bg-base px-3 py-2 text-left text-xs transition-colors",
        tone
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="flex-1">{option.name}</span>
      <span className="text-[10px] uppercase tracking-wide text-text-secondary">
        {option.kind.replace(/_/g, " ")}
      </span>
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
