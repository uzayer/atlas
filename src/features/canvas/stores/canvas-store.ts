import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import { logEvent } from "@/features/log/lib/log";
import { loadCanvas, saveCanvas } from "../lib/canvas-api";

export interface CanvasNode {
  id: string;
  x: number;
  y: number;
  width?: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

interface CanvasFile {
  version: 1;
  viewport: CanvasViewport;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface CanvasState {
  projectPath: string | null;
  loaded: boolean;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: CanvasViewport;
  selectedId: string | null;
  fullscreen: boolean;
}

interface CanvasActions {
  actions: {
    loadProject: (path: string) => Promise<void>;
    addNote: (at?: { x: number; y: number }) => string;
    updateNote: (id: string, patch: Partial<Pick<CanvasNode, "title" | "body" | "width">>) => void;
    deleteNote: (id: string) => void;
    moveNote: (id: string, x: number, y: number) => void;
    addEdge: (source: string, target: string) => void;
    deleteEdge: (id: string) => void;
    setSelected: (id: string | null) => void;
    setViewport: (vp: CanvasViewport) => void;
    setFullscreen: (open: boolean) => void;
    toggleFullscreen: () => void;
  };
}

function genId(prefix: "n" | "e"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

const emptyViewport: CanvasViewport = { x: 0, y: 0, zoom: 1 };

// Debounce save per project; cleared whenever we load a different project.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 400;

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const s = useCanvasStore.getState();
    if (!s.projectPath || !s.loaded) return;
    const payload: CanvasFile = {
      version: 1,
      viewport: s.viewport,
      nodes: s.nodes,
      edges: s.edges,
    };
    try {
      await saveCanvas(s.projectPath, JSON.stringify(payload));
    } catch (err) {
      // Silent — UI continues to function from in-memory state.
      // eslint-disable-next-line no-console
      console.error("save canvas failed", err);
    }
  }, SAVE_DEBOUNCE_MS);
}

function parseFile(raw: string): CanvasFile {
  try {
    const parsed = JSON.parse(raw) as Partial<CanvasFile>;
    return {
      version: 1,
      viewport: parsed.viewport ?? emptyViewport,
      nodes: Array.isArray(parsed.nodes) ? (parsed.nodes as CanvasNode[]) : [],
      edges: Array.isArray(parsed.edges) ? (parsed.edges as CanvasEdge[]) : [],
    };
  } catch {
    return { version: 1, viewport: emptyViewport, nodes: [], edges: [] };
  }
}

export const useCanvasStore = createSelectors(
  create<CanvasState & CanvasActions>()(
    immer((set, get) => ({
      projectPath: null,
      loaded: false,
      nodes: [],
      edges: [],
      viewport: emptyViewport,
      selectedId: null,
      fullscreen: false,
      actions: {
        loadProject: async (path) => {
          if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
          }
          set((s) => {
            s.projectPath = path;
            s.loaded = false;
            s.nodes = [];
            s.edges = [];
            s.selectedId = null;
            s.viewport = emptyViewport;
          });
          try {
            const raw = await loadCanvas(path);
            const parsed = parseFile(raw);
            set((s) => {
              if (s.projectPath !== path) return; // user switched projects mid-load
              s.nodes = parsed.nodes;
              s.edges = parsed.edges;
              s.viewport = parsed.viewport;
              s.loaded = true;
            });
          } catch {
            set((s) => {
              if (s.projectPath !== path) return;
              s.loaded = true;
            });
          }
        },
        addNote: (at) => {
          const id = genId("n");
          const stamp = nowIso();
          const x = at?.x ?? 0;
          const y = at?.y ?? 0;
          set((s) => {
            s.nodes.push({
              id,
              x,
              y,
              width: 320,
              title: "Untitled",
              body: "",
              createdAt: stamp,
              updatedAt: stamp,
            });
            s.selectedId = id;
          });
          scheduleSave();
          logEvent({ source: "canvas", kind: "note-add", summary: "New note", payload: { id } });
          return id;
        },
        updateNote: (id, patch) =>
          set((s) => {
            const n = s.nodes.find((n) => n.id === id);
            if (!n) return;
            if (patch.title !== undefined) n.title = patch.title;
            if (patch.body !== undefined) n.body = patch.body;
            if (patch.width !== undefined) n.width = patch.width;
            n.updatedAt = nowIso();
            scheduleSave();
          }),
        deleteNote: (id) => {
          const removed = get().nodes.find((n) => n.id === id);
          set((s) => {
            s.nodes = s.nodes.filter((n) => n.id !== id);
            s.edges = s.edges.filter((e) => e.source !== id && e.target !== id);
            if (s.selectedId === id) s.selectedId = null;
            scheduleSave();
          });
          if (removed) {
            logEvent({
              source: "canvas",
              kind: "note-delete",
              summary: removed.title || "Untitled",
              payload: { id },
            });
          }
        },
        moveNote: (id, x, y) =>
          set((s) => {
            const n = s.nodes.find((n) => n.id === id);
            if (!n) return;
            n.x = x;
            n.y = y;
            scheduleSave();
          }),
        addEdge: (source, target) => {
          if (source === target) return;
          const exists = get().edges.some(
            (e) =>
              (e.source === source && e.target === target) ||
              (e.source === target && e.target === source)
          );
          if (exists) return;
          set((s) => {
            s.edges.push({ id: genId("e"), source, target });
            scheduleSave();
          });
          logEvent({
            source: "canvas",
            kind: "edge-add",
            summary: "Connection added",
            payload: { source, target },
          });
        },
        deleteEdge: (id) => {
          set((s) => {
            s.edges = s.edges.filter((e) => e.id !== id);
            scheduleSave();
          });
          logEvent({ source: "canvas", kind: "edge-delete", summary: "Connection removed", payload: { id } });
        },
        setSelected: (id) =>
          set((s) => {
            s.selectedId = id;
          }),
        setViewport: (vp) =>
          set((s) => {
            s.viewport = vp;
            scheduleSave();
          }),
        setFullscreen: (open) =>
          set((s) => {
            s.fullscreen = open;
          }),
        toggleFullscreen: () =>
          set((s) => {
            s.fullscreen = !s.fullscreen;
          }),
      },
    }))
  )
);
