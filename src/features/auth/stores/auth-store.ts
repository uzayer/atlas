// Account state, mirrored from Rust.
//
// This store is a pure reflection of `atlas:auth-changed`. It never decides
// anything: Rust owns the credential, the grant, and every transition, so the
// only writer here is the event handler wired up once in App.tsx.
//
// `dialogOpen` is the one piece of genuinely local state — whether the connect
// dialog is on screen. It is separate from `status` because a user can dismiss
// the dialog while a grant is still valid, and reopening it must resume rather
// than restart.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { auth, type AuthSnapshot } from "../lib/auth-api";

interface AuthStoreState {
  snapshot: AuthSnapshot;
  /** Whether the connect dialog is showing. */
  dialogOpen: boolean;
  /** Last grant failure, shown inside the dialog. Cleared on the next attempt. */
  error: string | null;
  /** True between clicking the button and Rust confirming the grant started. */
  starting: boolean;
  actions: {
    setSnapshot: (snapshot: AuthSnapshot) => void;
    setError: (message: string) => void;
    /** Start (or resume) sign-in and show the dialog. */
    beginSignIn: () => Promise<void>;
    /** Dismiss the dialog and abandon the grant. */
    cancelSignIn: () => Promise<void>;
    /** Dismiss the dialog, leaving the grant running. */
    closeDialog: () => void;
    /**
     * Sign out. Resolves to whether the server session was revoked too —
     * `false` means this device is signed out but the server session may
     * outlive it. The signed-out state itself arrives as an event, not from
     * this promise.
     */
    signOut: () => Promise<boolean>;
    /** Pull the current state from Rust (mount hydration). */
    hydrate: () => Promise<void>;
  };
}

const useAuthStoreBase = create<AuthStoreState>()((set, get) => ({
  snapshot: { status: "signed-out" },
  dialogOpen: false,
  error: null,
  starting: false,

  actions: {
    setSnapshot: (snapshot) =>
      set((s) => ({
        snapshot,
        starting: false,
        // Signing in is the end of the flow — close the dialog for them.
        dialogOpen: snapshot.status === "connecting" ? s.dialogOpen : false,
        error: snapshot.status === "signed-in" ? null : s.error,
      })),

    setError: (message) => set({ error: message, starting: false }),

    beginSignIn: async () => {
      set({ dialogOpen: true, error: null, starting: true });
      try {
        const snapshot = await auth.signIn();
        set({ snapshot, starting: false });
      } catch (e) {
        set({
          error: e instanceof Error ? e.message : String(e),
          starting: false,
        });
      }
    },

    cancelSignIn: async () => {
      set({ dialogOpen: false, error: null, starting: false });
      try {
        set({ snapshot: await auth.cancelSignIn() });
      } catch {
        // Cancelling is best-effort; the dialog is already gone either way.
      }
    },

    closeDialog: () => set({ dialogOpen: false }),

    signOut: async () => {
      try {
        return await auth.signOut();
      } catch {
        // The local half cannot fail — Rust clears before it can return an
        // error at all — so an IPC failure here says nothing about the server
        // session, and the caveat is the honest thing to show.
        return false;
      }
    },

    hydrate: async () => {
      try {
        const snapshot = await auth.snapshot();
        // Never resurrect the dialog from hydration — if a grant is still in
        // flight it belongs in the title bar, not popped over the workspace.
        set({ snapshot });
      } catch {
        // A failed hydrate leaves the default signed-out state, which is the
        // correct thing to show when we cannot tell.
      }
      void get();
    },
  },
}));

export const useAuthStore = createSelectors(useAuthStoreBase);
