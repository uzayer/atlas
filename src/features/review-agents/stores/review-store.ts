// Review-Agents store. Owns provider/model selection, the diff source, the
// streaming state of an in-flight review, and the list of persisted past
// reviews (loaded from Rust). A single global `atlas:review` listener routes
// streamed deltas + completion into state, keyed by the active review id.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import {
  review,
  listenReview,
  type ReviewRecord,
  type ReviewSource,
} from "../lib/review-api";
import { curateModels, defaultModelFor } from "../lib/model-catalog";

const LS_PROVIDER = "atlas-review-provider";
// Model choice is persisted PER PROVIDER so a model picked for one provider can
// never be sent to another (the cause of cross-provider 404s).
const lsModelKey = (provider: string) => `atlas-review-model:${provider}`;

interface ReviewState {
  providers: string[];
  providersLoaded: boolean;
  selectedProvider: string | null;
  models: string[];
  loadingModels: boolean;
  selectedModel: string | null;
  source: ReviewSource;
  records: ReviewRecord[];
  /** Review currently selected for viewing (past or just-finished). */
  selectedRecord: ReviewRecord | null;
  /** Id of the in-flight (or last-started) review. */
  activeId: string | null;
  streaming: boolean;
  streamText: string;
  streamError: string | null;
  /** A source preset requested from elsewhere (e.g. Source Control's "Review
   *  this commit"); the panel consumes it to set its picker, then clears it. */
  pendingSource: { mode: "working" | "staged" | "commit"; sha?: string } | null;
  actions: {
    init: (project: string) => Promise<void>;
    refreshRecords: (project: string) => Promise<void>;
    setProvider: (provider: string) => Promise<void>;
    setModel: (model: string) => void;
    setSource: (source: ReviewSource) => void;
    start: (project: string) => Promise<void>;
    cancel: () => void;
    selectRecord: (record: ReviewRecord | null) => void;
    /** Preset the diff source from another feature (does not auto-run). */
    requestReview: (mode: "working" | "staged" | "commit", sha?: string) => void;
    /** Clear the pending preset after the panel applies it. */
    consumePending: () => void;
  };
}

let listenerReady = false;

export const useReviewStore = createSelectors(
  create<ReviewState>((set, get) => ({
    providers: [],
    providersLoaded: false,
    selectedProvider: null,
    models: [],
    loadingModels: false,
    selectedModel: null,
    source: { type: "working" },
    records: [],
    selectedRecord: null,
    activeId: null,
    streaming: false,
    streamText: "",
    streamError: null,
    pendingSource: null,
    actions: {
      init: async (project) => {
        if (!listenerReady) {
          listenerReady = true;
          await listenReview((e) => {
            const { activeId } = get();
            if (e.id !== activeId) return;
            switch (e.kind) {
              case "delta":
                set((s) => ({ streamText: s.streamText + e.delta }));
                break;
              case "thinking":
                break; // not surfaced in the UI
              case "complete":
                set((s) => ({
                  streaming: false,
                  streamText: "",
                  selectedRecord: e.record,
                  records: [e.record, ...s.records.filter((r) => r.id !== e.record.id)],
                }));
                break;
              case "error":
                set({ streaming: false, streamError: e.message });
                break;
            }
          });
        }

        // Records + providers in parallel.
        const [providers] = await Promise.all([
          review.providers().catch(() => [] as string[]),
          get().actions.refreshRecords(project),
        ]);
        set({ providers, providersLoaded: true });

        // Restore the saved provider/model if still valid, else first available.
        const saved = localStorage.getItem(LS_PROVIDER);
        const provider = saved && providers.includes(saved) ? saved : providers[0] ?? null;
        if (provider) {
          await get().actions.setProvider(provider);
        }
      },

      refreshRecords: async (project) => {
        try {
          const records = await review.list(project);
          set({ records });
        } catch {
          set({ records: [] });
        }
      },

      setProvider: async (provider) => {
        localStorage.setItem(LS_PROVIDER, provider);
        set({ selectedProvider: provider, loadingModels: true, models: [] });
        let liveIds: string[] = [];
        try {
          liveIds = (await review.models(provider)).map((m) => m.id);
        } catch {
          liveIds = [];
        }
        // Curate to coding-strong models for this provider (live ∪ preferred).
        const models = curateModels(provider, liveIds);
        // Restore this provider's saved model if still offered, else its default.
        const saved = localStorage.getItem(lsModelKey(provider));
        const selectedModel =
          saved && models.includes(saved) ? saved : defaultModelFor(provider, models);
        if (selectedModel) localStorage.setItem(lsModelKey(provider), selectedModel);
        set({ models, selectedModel, loadingModels: false });
      },

      setModel: (model) => {
        const provider = get().selectedProvider;
        if (provider) localStorage.setItem(lsModelKey(provider), model);
        set({ selectedModel: model });
      },

      setSource: (source) => set({ source }),

      start: async (project) => {
        const { selectedProvider, selectedModel, source, streaming } = get();
        if (streaming || !selectedProvider || !selectedModel) return;
        const id = crypto.randomUUID();
        set({
          activeId: id,
          streaming: true,
          streamText: "",
          streamError: null,
          selectedRecord: null,
        });
        try {
          await review.start(id, project, selectedProvider, selectedModel, source);
        } catch (err) {
          // resolve-diff / no-key errors come back as a rejected promise with no
          // event. Only surface if this review is still the active in-flight one
          // (the `complete`/`error` event may have already settled it).
          if (get().activeId === id && get().streaming) {
            set({ streaming: false, streamError: String(err) });
          }
        }
      },

      cancel: () => {
        const { activeId, streaming } = get();
        if (activeId && streaming) {
          void review.cancel(activeId);
          set({ streaming: false });
        }
      },

      selectRecord: (record) => set({ selectedRecord: record, streamError: null }),

      requestReview: (mode, sha) => set({ pendingSource: { mode, sha } }),

      consumePending: () => set({ pendingSource: null }),
    },
  })),
);
