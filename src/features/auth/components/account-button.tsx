import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { CircleUser, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AccountUser } from "../lib/auth-api";
import { useAuthStore } from "../stores/auth-store";

/**
 * The account control at the right of the title bar.
 *
 * Rendered unconditionally — deliberately **outside** the title bar's
 * "a project is open" guard, so a fresh install can connect an account from the
 * empty state rather than having to open a folder first.
 *
 * Signed in, it is the user's face: the photo when we have one cached, their
 * initial in a coloured circle when we do not. There is no third "broken photo"
 * state — every failure path in Rust and here lands on the initial, because a
 * missing avatar is not something the user can act on.
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
    if (signedIn) return; // ATL-49 opens the account menu from here.
    void beginSignIn();
  };

  const title = user
    ? `${user.name} (${user.email})`
    : signedIn
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
        signedIn || connecting ? "text-[#ccc]" : "text-[#555] hover:text-[#aaa]",
      )}
    >
      {starting || connecting ? (
        <Loader2 size={14} className="animate-spin" />
      ) : user ? (
        <Avatar user={user} />
      ) : (
        <CircleUser size={14} />
      )}
    </button>
  );
}

/** The user's photo, or their initial. */
function Avatar({ user }: { user: AccountUser }) {
  // Keyed by path rather than a bare boolean, so a photo that changes gets a
  // fresh attempt instead of inheriting the previous one's failure.
  const [failedPath, setFailedPath] = useState<string | null>(null);

  if (user.avatarPath && failedPath !== user.avatarPath) {
    return (
      <img
        src={convertFileSrc(user.avatarPath)}
        alt=""
        draggable={false}
        onError={() => setFailedPath(user.avatarPath)}
        className="w-[18px] h-[18px] rounded-full object-cover"
      />
    );
  }
  return <Initial user={user} />;
}

/**
 * A single letter on a colour derived from the user id.
 *
 * Deriving rather than picking keeps the same person the same colour on every
 * machine and every launch, which is what makes the circle read as *their*
 * badge rather than decoration.
 */
function Initial({ user }: { user: AccountUser }) {
  const source = user.name.trim() || user.email.trim();
  // `Array.from` rather than `[0]`, so a name starting outside the BMP does not
  // render as half a character.
  const letter = (Array.from(source)[0] ?? "?").toUpperCase();

  return (
    <span
      aria-hidden
      style={{ backgroundColor: `hsl(${hueFor(user.id)} 42% 40%)` }}
      className="flex items-center justify-center w-[18px] h-[18px] rounded-full text-[10px] font-medium leading-none text-white/90 select-none"
    >
      {letter}
    </span>
  );
}

/** Stable hue in [0, 360) for a string. */
function hueFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}
