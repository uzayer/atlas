import { CircleUser, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuthStore } from "../stores/auth-store";

/**
 * The account control at the right of the title bar.
 *
 * Rendered unconditionally — deliberately **outside** the title bar's
 * "a project is open" guard, so a fresh install can connect an account from the
 * empty state rather than having to open a folder first.
 *
 * ATL-47 replaces the icon with the user's profile photo. Until then signed-in
 * is shown as a filled state rather than a face.
 */
export function AccountButton() {
  const snapshot = useAuthStore.use.snapshot();
  const starting = useAuthStore.use.starting();
  const { beginSignIn, closeDialog } = useAuthStore.use.actions();
  const dialogOpen = useAuthStore.use.dialogOpen();

  const connecting = snapshot.status === "connecting";
  const signedIn = snapshot.status === "signed-in";

  const onClick = () => {
    // While connecting, the button toggles the dialog rather than starting
    // anything — the grant is already running.
    if (connecting) {
      if (dialogOpen) closeDialog();
      else void beginSignIn();
      return;
    }
    if (signedIn) return; // ATL-49 opens the account menu from here.
    void beginSignIn();
  };

  const title = signedIn
    ? "Atlas account — connected"
    : connecting
      ? "Waiting for approval in your browser…"
      : "Connect your Atlas account";

  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "relative flex items-center justify-center w-6 h-6 rounded transition-all duration-150",
        "hover:bg-[#ffffff08] outline-none focus:outline-none",
        signedIn || connecting
          ? "text-[#ccc]"
          : "text-[#555] hover:text-[#aaa]",
      )}
    >
      {starting || connecting ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <CircleUser size={14} />
      )}
    </button>
  );
}
