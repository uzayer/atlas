// Updater store — drives the "update available" modal. Fed by Rust events
// (`atlas:update-available` / `:progress` / `:error`) wired up once in App.tsx.
// In-memory only; a dismissed/ignored update simply won't re-appear until the
// next startup check.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

/** Modal lifecycle phase. */
export type UpdatePhase = "idle" | "available" | "installing" | "error";

interface UpdaterState {
  phase: UpdatePhase;
  version: string | null;
  currentVersion: string | null;
  /** 0..1 download progress while installing (null = indeterminate). */
  progress: number | null;
  error: string | null;
  /** True while the backend is checking for an update (titlebar spinner). */
  checking: boolean;
  actions: {
    /** An update was found — open the modal. */
    setAvailable: (version: string, currentVersion: string) => void;
    setProgress: (downloaded: number, total: number) => void;
    setError: (message: string) => void;
    setChecking: (checking: boolean) => void;
    /** Enter the installing state (clears any prior error/progress). */
    beginInstall: () => void;
    /** Close the modal without acting. */
    dismiss: () => void;
  };
}

const useUpdaterStoreBase = create<UpdaterState>()((set) => ({
  phase: "idle",
  version: null,
  currentVersion: null,
  progress: null,
  error: null,
  checking: false,
  actions: {
    setAvailable: (version, currentVersion) =>
      set({ phase: "available", version, currentVersion, progress: null, error: null }),
    setProgress: (downloaded, total) =>
      set({ progress: total > 0 ? Math.min(1, downloaded / total) : null }),
    setError: (message) => set({ phase: "error", error: message }),
    setChecking: (checking) => set({ checking }),
    beginInstall: () => set({ phase: "installing", progress: null, error: null }),
    dismiss: () => set({ phase: "idle", progress: null, error: null }),
  },
}));

export const useUpdaterStore = createSelectors(useUpdaterStoreBase);
