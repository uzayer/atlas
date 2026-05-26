import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import { invoke } from "@tauri-apps/api/core";

interface Symbol {
  name: string;
  kind: string;
  file_path: string;
  line: number;
  signature: string;
}

interface LanguageStat {
  language: string;
  files: number;
  lines: number;
}

interface AnalysisState {
  indexed: boolean;
  loading: boolean;
  totalFiles: number;
  totalLines: number;
  languages: LanguageStat[];
  symbols: Symbol[];
  filterKind: string | null;
  searchQuery: string;
}

interface AnalysisActions {
  actions: {
    analyzeProject: (path: string) => Promise<void>;
    setFilterKind: (kind: string | null) => void;
    setSearchQuery: (query: string) => void;
    clear: () => void;
  };
}

export const useAnalysisStore = createSelectors(
  create<AnalysisState & AnalysisActions>()(
    immer((set) => ({
      indexed: false,
      loading: false,
      totalFiles: 0,
      totalLines: 0,
      languages: [],
      symbols: [],
      filterKind: null,
      searchQuery: "",
      actions: {
        analyzeProject: async (path) => {
          set((s) => { s.loading = true; });
          try {
            const result = await invoke<{
              total_files: number;
              total_lines: number;
              languages: LanguageStat[];
              symbols: Symbol[];
            }>("analyze_project", { path });
            set((s) => {
              s.indexed = true;
              s.loading = false;
              s.totalFiles = result.total_files;
              s.totalLines = result.total_lines;
              s.languages = result.languages;
              s.symbols = result.symbols;
            });
            // Mirror to the Rust mention cache so the @-picker
            // reads symbols from native state instead of re-shipping
            // the array every keystroke. Lazy import to avoid
            // pulling chat/lib into the analysis module graph.
            void import("@/features/chat/lib/mentions").then((m) =>
              m.publishSymbolsToMentionCache(),
            );
          } catch {
            set((s) => { s.loading = false; });
          }
        },
        setFilterKind: (kind) => set((s) => { s.filterKind = kind; }),
        setSearchQuery: (query) => set((s) => { s.searchQuery = query; }),
        clear: () => set((s) => {
          s.indexed = false;
          s.symbols = [];
          s.languages = [];
          s.totalFiles = 0;
          s.totalLines = 0;
        }),
      },
    }))
  )
);
