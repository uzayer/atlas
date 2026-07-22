import { CircleUser, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuthStore } from "../stores/auth-store";
import { AccountAvatar } from "./account-avatar";
import { AccountMenu } from "./account-menu";

/**
 * The account control at the right of the title bar.
 *
 * Rendered unconditionally — deliberately **outside** the title bar's
 * "a project is open" guard, so a fresh install can connect an account from the
 * empty state rather than having to open a folder first.
 *
 * Signed in, it is the user's face and the trigger for the account menu.
 * Signed out or mid-grant it is a plain button that starts (or reopens)
 * sign-in — the menu has nothing to say in either state.
 */
export function AccountButton() {
  const snapshot = useAuthStore.use.snapshot();
  const starting = useAuthStore.use.starting();
  const { beginSignIn, closeDialog } = useAuthStore.use.actions();
  const dialogOpen = useAuthStore.use.dialogOpen();

  const connecting = snapshot.status === "connecting";
  const signedIn = snapshot.status === "signed-in";
  const user = snapshot.status === "signed-in" ? snapshot.user : null;

  const onClick = () => {
    // While connecting, the button toggles the dialog rather than starting
    // anything — the grant is already running.
    if (connecting) {
      if (dialogOpen) closeDialog();
      else void beginSignIn();
      return;
    }
    void beginSignIn();
  };

  const title = user
    ? `${user.name} (${user.email})`
    : signedIn
      ? "Atlas account — connected"
      : connecting
        ? "Waiting for approval in your browser…"
        : "Connect your Atlas account";

  const button = (
    // Signed in the click is Radix's to handle, so no `onClick` of our own —
    // one that also ran would fight the trigger it is wrapped in.
    <button
      onClick={signedIn ? undefined : onClick}
      title={title}
      aria-label={title}
      className={cn(
        "relative flex items-center justify-center w-6 h-6 rounded transition-all duration-150",
        "hover:bg-[#ffffff08] outline-none focus:outline-none",
        signedIn || connecting ? "text-[#ccc]" : "text-[#555] hover:text-[#aaa]",
      )}
    >
      {starting || connecting ? (
        <Loader2 size={14} className="animate-spin" />
      ) : user ? (
        <AccountAvatar user={user} size={18} />
      ) : (
        <CircleUser size={14} />
      )}
    </button>
  );

  // Narrowed on `snapshot` rather than the `signedIn` boolean, so the menu is
  // handed one coherent account state instead of pieces pulled out separately.
  if (snapshot.status !== "signed-in") return button;
  return <AccountMenu account={snapshot}>{button}</AccountMenu>;
}
