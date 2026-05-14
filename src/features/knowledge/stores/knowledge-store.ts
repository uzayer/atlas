import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { invoke } from "@tauri-apps/api/core";
import { logEvent } from "@/features/log/lib/log";

interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  source: string;
  file_path: string;
  updated_at: string;
}

interface KnowledgeState {
  entries: KnowledgeEntry[];
  activeEntryId: string | null;
  editContent: string;
  loading: boolean;
  actions: {
    loadEntries: (projectPath: string) => Promise<void>;
    selectEntry: (id: string) => void;
    setEditContent: (content: string) => void;
    saveEntry: (projectPath: string) => Promise<void>;
    createEntry: (projectPath: string) => Promise<void>;
    deleteEntry: (projectPath: string, id: string) => Promise<void>;
    createDir: (projectPath: string, dirName: string) => Promise<void>;
  };
}

export const useKnowledgeStore = createSelectors(
  create<KnowledgeState>()((set, get) => ({
    entries: [],
    activeEntryId: null,
    editContent: "",
    loading: false,
    actions: {
      loadEntries: async (projectPath) => {
        try {
          const newEntries = await invoke<KnowledgeEntry[]>("list_knowledge", {
            projectPath,
          });
          const current = get();

          // Skip update if entries haven't changed (prevent unnecessary re-renders)
          const unchanged = current.entries.length === newEntries.length &&
            current.entries.every((e, i) => e.id === newEntries[i]?.id && e.updated_at === newEntries[i]?.updated_at);
          if (unchanged && !current.loading) return;

          const activeStillExists = newEntries.find((e) => e.id === current.activeEntryId);
          set({
            entries: newEntries,
            loading: false,
            activeEntryId: activeStillExists
              ? current.activeEntryId
              : newEntries[0]?.id ?? null,
            editContent: activeStillExists?.content
              ?? newEntries[0]?.content ?? "",
          });
        } catch {
          set({ loading: false });
        }
      },
      selectEntry: (id) => {
        const entry = get().entries.find((e) => e.id === id);
        set({
          activeEntryId: id,
          editContent: entry?.content ?? "",
        });
      },
      setEditContent: (content) => set({ editContent: content }),
      saveEntry: async (projectPath) => {
        const { activeEntryId, editContent } = get();
        if (!activeEntryId) return;
        try {
          await invoke("save_knowledge_note", {
            projectPath,
            id: activeEntryId,
            content: editContent,
          });
          // Update the entry's content in-place without a full reload
          const title = editContent.split("\n")[0]?.replace(/^#+\s*/, "").slice(0, 60) || "note";
          set({
            entries: get().entries.map((e) =>
              e.id === activeEntryId ? { ...e, content: editContent, title, updated_at: new Date().toISOString() } : e
            ),
          });
          invoke("log_interaction", {
            projectPath,
            interactionType: "note_edit",
            summary: `Edited note: ${title}`,
          }).catch(() => {});
          logEvent({
            source: "knowledge",
            kind: "note-save",
            summary: title,
            projectPath,
            payload: { id: activeEntryId },
          });
        } catch {
          // silent
        }
      },
      createEntry: async (projectPath) => {
        const id = `note-${Date.now()}`;
        const content = "# Untitled\n\n";
        try {
          await invoke("save_knowledge_note", {
            projectPath,
            id,
            content,
          });
          await get().actions.loadEntries(projectPath);
          set({ activeEntryId: id, editContent: content });
          logEvent({
            source: "knowledge",
            kind: "note-create",
            summary: "New note",
            projectPath,
            payload: { id },
          });
        } catch {
          // silent
        }
      },
      deleteEntry: async (projectPath, id) => {
        try {
          await invoke("delete_knowledge_note", { projectPath, id });
          await get().actions.loadEntries(projectPath);
          logEvent({
            source: "knowledge",
            kind: "note-delete",
            summary: id,
            projectPath,
            payload: { id },
          });
        } catch {
          // silent
        }
      },
      createDir: async (projectPath, dirName) => {
        try {
          await invoke("create_knowledge_dir", { projectPath, dirName });
          await get().actions.loadEntries(projectPath);
          logEvent({
            source: "knowledge",
            kind: "dir-create",
            summary: dirName,
            projectPath,
            payload: { dirName },
          });
        } catch (e) {
          console.error("Failed to create directory:", e);
        }
      },
    },
  }))
);
