import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { invoke } from "@tauri-apps/api/core";
import { createSelectors } from "@/lib/create-selectors";
import { useProjectStore } from "@/features/project/stores/project-store";

export type LogSource =
  | "atlas"
  | "agent"
  | "chat"
  | "git"
  | "knowledge"
  | "github"
  | "canvas"
  | "editor"
  | "research"
  | "project"
  | "system";

export interface LogEntry {
  id: string;
  timestamp: string; // ISO
  source: LogSource;
  kind: string;
  summary: string;
  projectPath?: string;
  projectName?: string;
  payload?: Record<string, unknown>;
  pinned?: boolean;
}

interface LogState {
  buffer: LogEntry[];
  pinned: LogEntry[];
  ready: boolean;
}

interface LogActions {
  actions: {
    append: (
      entry: Omit<LogEntry, "id" | "timestamp" | "pinned" | "projectName"> & {
        projectName?: string;
      }
    ) => void;
    pin: (id: string) => Promise<void>;
    unpin: (id: string) => Promise<void>;
    clearBuffer: () => void;
    clearPinned: () => Promise<void>;
    loadPinned: () => Promise<void>;
  };
}

const BUFFER_CAP = 500;

function genId(): string {
  return `l_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export const useLogStore = createSelectors(
  create<LogState & LogActions>()(
    immer((set, get) => ({
      buffer: [],
      pinned: [],
      ready: false,
      actions: {
        append: (entry) => {
          const project = useProjectStore.getState().currentProject;
          const projectPath = entry.projectPath ?? project?.path ?? undefined;
          const projectName =
            entry.projectName ??
            (project && projectPath === project.path ? project.name : undefined);
          const full: LogEntry = {
            ...entry,
            id: genId(),
            timestamp: nowIso(),
            projectPath,
            projectName,
          };
          set((s) => {
            s.buffer.unshift(full);
            if (s.buffer.length > BUFFER_CAP) s.buffer.length = BUFFER_CAP;
          });
        },
        pin: async (id) => {
          // Find the entry in buffer or pinned.
          const inBuffer = get().buffer.find((e) => e.id === id);
          const target: LogEntry | undefined = inBuffer
            ? { ...inBuffer, pinned: true }
            : get().pinned.find((e) => e.id === id);
          if (!target) return;
          set((s) => {
            if (!s.pinned.some((e) => e.id === id)) {
              s.pinned.unshift({ ...target, pinned: true });
            }
            const i = s.buffer.findIndex((e) => e.id === id);
            if (i !== -1) s.buffer[i].pinned = true;
          });
          try {
            await invoke("append_pinned_log", { entryJson: JSON.stringify(target) });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("pin log entry failed", err);
          }
        },
        unpin: async (id) => {
          set((s) => {
            s.pinned = s.pinned.filter((e) => e.id !== id);
            const i = s.buffer.findIndex((e) => e.id === id);
            if (i !== -1) s.buffer[i].pinned = false;
          });
          try {
            const remaining = get().pinned;
            const body = remaining.map((e) => JSON.stringify(e)).join("\n") + (remaining.length ? "\n" : "");
            await invoke("rewrite_pinned_log", { entriesJson: body });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("unpin log entry failed", err);
          }
        },
        clearBuffer: () =>
          set((s) => {
            s.buffer = [];
          }),
        clearPinned: async () => {
          set((s) => {
            s.pinned = [];
            for (const e of s.buffer) e.pinned = false;
          });
          try {
            await invoke("clear_pinned_log");
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("clear pinned log failed", err);
          }
        },
        loadPinned: async () => {
          if (get().ready) return;
          try {
            const text = await invoke<string>("load_pinned_log");
            const lines = text.split("\n").filter((l) => l.trim());
            const parsed: LogEntry[] = [];
            for (const l of lines) {
              try {
                const obj = JSON.parse(l) as LogEntry;
                parsed.push({ ...obj, pinned: true });
              } catch {
                // skip malformed line
              }
            }
            parsed.reverse(); // newest first
            set((s) => {
              s.pinned = parsed;
              s.ready = true;
            });
          } catch {
            set((s) => {
              s.ready = true;
            });
          }
        },
      },
    }))
  )
);
