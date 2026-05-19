// Lightweight "recently opened files" queue. Pushed to from anywhere that
// opens a file (editor tabs, file picker selections, etc.) and consumed by
// the mention picker to render its "recent files" header.
//
// In-memory per app session (no persistence v1) — once we want this to
// survive restarts, plug into the existing project-session save/load path.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

export interface RecentFile {
  absPath: string;
  /** Relative-to-project path; what the user sees in the picker. */
  rel: string;
  /** Unix ms of the most-recent open. */
  touchedAt: number;
}

interface RecentFilesState {
  items: RecentFile[];
  actions: {
    /** Move (or insert) the entry to the head of the queue. Capped at 20. */
    push: (entry: Omit<RecentFile, "touchedAt">) => void;
    clear: () => void;
  };
}

const CAP = 20;

export const useRecentFilesStore = createSelectors(
  create<RecentFilesState>()((set) => ({
    items: [],
    actions: {
      push: (entry) =>
        set((s) => {
          const next: RecentFile[] = [
            { ...entry, touchedAt: Date.now() },
            ...s.items.filter((it) => it.absPath !== entry.absPath),
          ].slice(0, CAP);
          return { items: next };
        }),
      clear: () => set({ items: [] }),
    },
  }))
);
