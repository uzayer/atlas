import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

interface ConfirmDeleteProps {
  open: boolean;
  /** Display name in the prompt — file/folder basename. */
  name: string;
  /** Whether the target is a directory (changes the warning copy). */
  isDir: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

/**
 * Custom Radix dialog for delete confirmation. `window.confirm` would
 * steal focus and look like a default browser modal — not acceptable
 * for a destructive action on a polished surface like the file tree.
 */
export function FileTreeConfirmDelete({
  open,
  name,
  isDir,
  onConfirm,
  onOpenChange,
}: ConfirmDeleteProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[var(--z-overlay)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-[30%] -translate-x-1/2 z-[var(--z-modal)]",
            "w-[380px] rounded-xl overflow-hidden",
            "bg-[var(--bg-secondary)] border border-[var(--border-default)]",
            "shadow-[var(--shadow-overlay)]",
            "p-4 flex flex-col gap-3",
          )}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onConfirm();
            }
          }}
        >
          <Dialog.Title className="text-[13px] font-semibold text-text-primary">
            Delete {isDir ? "folder" : "file"}?
          </Dialog.Title>
          <p className="text-[12px] text-text-secondary leading-relaxed">
            <span className="font-mono text-text-primary">{name}</span> will be
            permanently {isDir ? "removed along with everything inside it" : "deleted"}.
            This can't be undone.
          </p>
          <div className="flex items-center justify-end gap-2 mt-1">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cn(
                "px-3 h-7 rounded text-[11px]",
                "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
              )}
            >
              Cancel
            </button>
            <button
              type="button"
              autoFocus
              onClick={onConfirm}
              className={cn(
                "px-3 h-7 rounded text-[11px] font-medium",
                "text-white bg-[var(--status-error)] hover:opacity-90",
              )}
            >
              Delete
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
