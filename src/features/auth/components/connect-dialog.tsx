import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, ChevronRight, Loader2, MonitorSmartphone } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuthStore } from "../stores/auth-store";

/**
 * The connecting dialog.
 *
 * **The device code is not the headline.** RFC 8628 shows a code because it was
 * designed for TVs and printers, where the human carries it to a *second*
 * device. Atlas runs on a laptop with the browser one process away, and the URL
 * we open already has the code embedded — so on the happy path nobody needs to
 * read it. Leading with it imports a compare-these-two-screens ritual that
 * protects nothing the user can perceive and reads as unexplained friction.
 *
 * So: a waiting state up front, and the code behind a disclosure for whoever
 * lost the browser tab or is approving from their phone.
 */
export function ConnectDialog() {
  const open = useAuthStore.use.dialogOpen();
  const snapshot = useAuthStore.use.snapshot();
  const error = useAuthStore.use.error();
  const starting = useAuthStore.use.starting();
  const { cancelSignIn, closeDialog, beginSignIn } = useAuthStore.use.actions();

  const [showCode, setShowCode] = useState(false);

  const connecting = snapshot.status === "connecting" ? snapshot : null;
  const done = snapshot.status === "signed-in";

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // Closing the dialog abandons the attempt. Leaving a poll loop running
        // against a request the user visibly cancelled would be dishonest.
        if (!next) void cancelSignIn();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-overlay)] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-[24%] z-[var(--z-modal)] -translate-x-1/2",
            "w-[440px] max-w-[92vw] rounded-lg border border-border-default bg-bg-elevated",
            "shadow-[var(--shadow-overlay)] text-text-primary",
          )}
        >
          <div className="flex items-start gap-2.5 border-b border-border-default px-4 py-3">
            <MonitorSmartphone className="mt-0.5 size-4 text-text-tertiary" />
            <div>
              <Dialog.Title className="text-sm font-medium">
                Connect your Atlas account
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-text-secondary">
                Approve this device in your browser to finish.
              </Dialog.Description>
            </div>
          </div>

          <div className="p-4">
            {done ? (
              <div className="flex items-center gap-2 px-1 py-5 text-xs text-text-secondary">
                <Check size={14} className="text-[var(--status-success)]" />
                Connected.
              </div>
            ) : error ? (
              <div className="px-1 py-4">
                <p className="text-xs text-[var(--status-error)]">{error}</p>
                <button
                  onClick={() => void beginSignIn()}
                  className="mt-3 rounded border border-border-default px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-[#ffffff08]"
                >
                  Try again
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 px-1 py-5 text-xs text-text-secondary">
                  <Loader2 size={14} className="animate-spin" />
                  {starting
                    ? "Starting…"
                    : "Continue in your browser, then come back here."}
                </div>

                {connecting ? (
                  <div className="border-t border-border-default pt-2">
                    <button
                      onClick={() => setShowCode((v) => !v)}
                      className="flex w-full items-center gap-1 px-1 py-1.5 text-[11px] text-text-tertiary transition-colors hover:text-text-secondary"
                    >
                      <ChevronRight
                        size={12}
                        className={cn("transition-transform", showCode && "rotate-90")}
                      />
                      Trouble? Enter the code manually
                    </button>

                    {showCode ? (
                      <div className="mt-1 space-y-2 rounded border border-border-default bg-[var(--bg-base)] px-3 py-2.5">
                        <p className="text-[11px] text-text-tertiary">
                          Go to{" "}
                          <span className="font-mono text-text-secondary">
                            {connecting.verificationUri}
                          </span>{" "}
                          and enter:
                        </p>
                        <p className="text-center font-mono text-lg tracking-[0.3em] text-text-primary">
                          {connecting.userCode}
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-border-default px-4 py-2.5">
            <button
              onClick={() => (done ? closeDialog() : void cancelSignIn())}
              className="rounded px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-[#ffffff08] hover:text-text-primary"
            >
              {done ? "Close" : "Cancel"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
