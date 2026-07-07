import * as Dialog from "@radix-ui/react-dialog";
import { Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { AtlasIcon } from "@/components/atlas-icon";
import { useUpdaterStore } from "../stores/updater-store";
import { updater } from "../lib/updater-api";

/**
 * "Update available" prompt — a macOS-updater-style centered card: app icon,
 * title, subtitle, and stacked full-width actions. Mounted once at the app root;
 * opens when the Rust startup check (or a manual "Check for updates") emits
 * `atlas:update-available`. The automatic-update toggle lives in Settings →
 * Updates, not here.
 */
export function UpdateAvailableModal() {
  const phase = useUpdaterStore.use.phase();
  const version = useUpdaterStore.use.version();
  const progress = useUpdaterStore.use.progress();
  const error = useUpdaterStore.use.error();
  const { beginInstall, dismiss, setError } = useUpdaterStore.use.actions();

  const open = phase !== "idle";
  const installing = phase === "installing";
  const isError = phase === "error";

  const installNow = () => {
    beginInstall();
    // On success the app restarts; failures arrive via the error listener, but
    // guard here too in case the invoke itself rejects.
    void updater.install(true).catch((e) => setError(String(e)));
  };

  const installLater = () => {
    beginInstall();
    void updater
      .install(false)
      .then(() => {
        dismiss();
        toast.success("Update installed — it'll be applied next time you open Atlas.");
      })
      .catch((e) => setError(String(e)));
  };

  const skip = () => {
    if (version) void updater.ignore(version).catch(() => {});
    dismiss();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        // Don't allow closing mid-install; otherwise a click-away = dismiss.
        if (!o && !installing) dismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[var(--z-overlay)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[var(--z-modal)]",
            "w-[300px] rounded-2xl overflow-hidden",
            "bg-[var(--bg-secondary)] border border-[var(--border-default)]",
            "shadow-[var(--shadow-overlay)]",
            "px-5 pt-6 pb-5 flex flex-col items-center text-center",
          )}
        >
          {/* App icon (or an error glyph in the failure state). */}
          {isError ? (
            <div className="w-[52px] h-[52px] rounded-2xl bg-bg-elevated border border-border-default grid place-items-center">
              <AlertTriangle size={24} className="text-[var(--status-error)]" />
            </div>
          ) : (
            <AtlasIcon size={52} className="rounded-2xl" />
          )}

          <Dialog.Title className="mt-3 text-[15px] font-semibold text-text-primary">
            {isError ? "Update failed" : "Update Available"}
          </Dialog.Title>

          <p className="mt-1 text-[12px] text-text-secondary leading-relaxed px-1">
            {isError ? (
              error ?? "Something went wrong while installing the update."
            ) : (
              <>
                A new version of Atlas{version ? ` (${version})` : ""} is ready to be
                installed.
              </>
            )}
          </p>

          {installing ? (
            <div className="mt-4 w-full flex flex-col gap-1.5">
              <div className="h-1.5 rounded-full bg-bg-elevated overflow-hidden">
                <div
                  className="h-full bg-text-primary transition-[width] duration-150"
                  style={{ width: progress != null ? `${Math.round(progress * 100)}%` : "40%" }}
                />
              </div>
              <span className="text-[10px] text-text-tertiary inline-flex items-center justify-center gap-1">
                <Loader2 size={10} className="animate-spin" />
                {progress != null ? `Downloading ${Math.round(progress * 100)}%` : "Preparing…"}
              </span>
            </div>
          ) : isError ? (
            <button
              type="button"
              onClick={dismiss}
              className="mt-4 w-full h-9 rounded-lg text-[12px] font-medium bg-[var(--text-primary)] text-[var(--bg-base)] hover:opacity-90 transition-opacity"
            >
              Close
            </button>
          ) : (
            <>
              <div className="mt-4 w-full flex flex-col gap-2">
                <button
                  type="button"
                  autoFocus
                  onClick={installNow}
                  className="w-full h-9 rounded-lg text-[12px] font-medium bg-[var(--text-primary)] text-[var(--bg-base)] hover:opacity-90 transition-opacity"
                >
                  Install now
                </button>
                <button
                  type="button"
                  onClick={installLater}
                  className="w-full h-9 rounded-lg text-[12px] font-medium bg-[var(--bg-elevated)] text-text-primary border border-border-default hover:bg-bg-hover transition-colors"
                >
                  Install on next launch
                </button>
              </div>
              <button
                type="button"
                onClick={skip}
                className="mt-3 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
              >
                Skip this version
              </button>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
