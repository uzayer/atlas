import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import { logEvent } from "@/features/log/lib/log";
import { loadCanvas, saveCanvas } from "../lib/canvas-api";

/** What a canvas node is. `note` = rich card (title/body/icon), `text` = chrome-
 *  less free text, `media` = image, `shape` = geometric flowchart shape with a
 *  centered text label. Defaults to `note` for legacy files. */
export type CanvasNodeKind = "note" | "text" | "media" | "shape";
export type MediaKind = "image" | "video";

/** Flowchart shape geometries. */
export type ShapeType = "rectangle" | "rounded" | "ellipse" | "diamond";

/** Active canvas tool. Create-tools drop a node on the next pane click, then
 *  revert to `select`. `connector` is a hint; connections are made by dragging
 *  between node handles (Loose mode). `shape:*` drops that geometry. */
export type CanvasTool =
  | "select"
  | "note"
  | "text"
  | "media"
  | "connector"
  | `shape:${ShapeType}`;

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  width?: number;
  height?: number;
  // note fields
  title: string;
  body: string;
  /** Emoji shown on the note card (falls back to the sticky-note glyph). */
  icon?: string;
  // text field (also the centered label for `shape` nodes)
  text?: string;
  // shape field
  shapeType?: ShapeType;
  // media fields
  /** Relative path under `.atlas/canvas-media/` (served via canvas_media_data_url). */
  src?: string;
  mediaKind?: MediaKind;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  /** Which side of each node the connector attaches to (t/r/b/l). */
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

/** Persisted file schema. v2 adds node `kind`/`icon`/media + edge handle sides. */
interface CanvasFile {
  version: 2;
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
  /** Ids of currently-selected nodes (multi-select via marquee / shift-click). */
  selectedIds: string[];
  fullscreen: boolean;
  activeTool: CanvasTool;
  /** Mirrors the module-level undo/redo stacks for toolbar button state. */
  canUndo: boolean;
  canRedo: boolean;
}

type NodePatch = Partial<
  Pick<
    CanvasNode,
    "title" | "body" | "width" | "height" | "icon" | "text" | "src" | "mediaKind" | "shapeType"
  >
>;

interface CanvasActions {
  actions: {
    loadProject: (path: string) => Promise<void>;
    addNote: (at?: { x: number; y: number }) => string;
    addText: (at?: { x: number; y: number }) => string;
    addMedia: (
      opts: { src: string; mediaKind: MediaKind; width?: number; height?: number },
      at?: { x: number; y: number },
    ) => string;
    addShape: (
      shapeType: ShapeType,
      at?: { x: number; y: number },
      size?: { width: number; height: number },
    ) => string;
    updateNote: (id: string, patch: NodePatch) => void;
    deleteNote: (id: string) => void;
    moveNote: (id: string, x: number, y: number) => void;
    addEdge: (
      source: string,
      target: string,
      sourceHandle?: string | null,
      targetHandle?: string | null,
    ) => void;
    deleteEdge: (id: string) => void;
    /** Replace the selection with a single id (or clear when null). */
    setSelected: (id: string | null) => void;
    /** Replace the whole selection set (marquee / multi-select). */
    setSelectedIds: (ids: string[]) => void;
    setViewport: (vp: CanvasViewport) => void;
    setFullscreen: (open: boolean) => void;
    toggleFullscreen: () => void;
    setTool: (tool: CanvasTool) => void;
    /** Snapshot the current nodes/edges so the next mutation is one undo step.
     *  Call at the START of a continuous interaction (node drag / resize). */
    beginInteraction: () => void;
    undo: () => void;
    redo: () => void;
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
      version: 2,
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

// ── Undo/redo snapshot stacks ────────────────────────────────────────────────
// Module-level (not reactive). The store mirrors `canUndo`/`canRedo` for the
// toolbar. A continuous drag/resize captures ONE snapshot at its start
// (`beginInteraction`), so it collapses into a single undo step — matching how
// Excalidraw batches a drag into one history entry.
interface HistorySnap {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}
let past: HistorySnap[] = [];
let future: HistorySnap[] = [];
const HISTORY_CAP = 50;

function resetHistory() {
  past = [];
  future = [];
}

function parseFile(raw: string): CanvasFile {
  try {
    const parsed = JSON.parse(raw) as Partial<CanvasFile>;
    // Migrate v1 → v2: legacy nodes had no `kind`; they were all notes.
    const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : []).map((n) => ({
      ...(n as CanvasNode),
      kind: (n as CanvasNode).kind ?? "note",
      title: (n as CanvasNode).title ?? "",
      body: (n as CanvasNode).body ?? "",
    }));
    return {
      version: 2,
      viewport: parsed.viewport ?? emptyViewport,
      nodes,
      edges: Array.isArray(parsed.edges) ? (parsed.edges as CanvasEdge[]) : [],
    };
  } catch {
    return { version: 2, viewport: emptyViewport, nodes: [], edges: [] };
  }
}

export const useCanvasStore = createSelectors(
  create<CanvasState & CanvasActions>()(
    immer((set, get) => {
      // Capture the pre-mutation nodes/edges as one undo step. `get()` inside a
      // producer returns committed (pre-`set`) state, and immer never mutates a
      // previously-produced object, so storing the references is a safe snapshot.
      const takeSnapshot = () => {
        past.push({ nodes: get().nodes, edges: get().edges });
        if (past.length > HISTORY_CAP) past.shift();
        future = [];
        set((s) => {
          s.canUndo = true;
          s.canRedo = false;
        });
      };
      return {
      projectPath: null,
      loaded: false,
      nodes: [],
      edges: [],
      viewport: emptyViewport,
      selectedIds: [],
      fullscreen: false,
      activeTool: "select",
      canUndo: false,
      canRedo: false,
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
            s.selectedIds = [];
            s.viewport = emptyViewport;
          });
          try {
            const raw = await loadCanvas(path);
            const parsed = parseFile(raw);
            resetHistory();
            set((s) => {
              if (s.projectPath !== path) return; // user switched projects mid-load
              s.nodes = parsed.nodes;
              s.edges = parsed.edges;
              s.viewport = parsed.viewport;
              s.loaded = true;
              s.canUndo = false;
              s.canRedo = false;
            });
          } catch {
            set((s) => {
              if (s.projectPath !== path) return;
              s.loaded = true;
            });
          }
        },
        addNote: (at) => {
          takeSnapshot();
          const id = genId("n");
          const stamp = nowIso();
          const x = at?.x ?? 0;
          const y = at?.y ?? 0;
          set((s) => {
            s.nodes.push({
              id,
              kind: "note",
              x,
              y,
              width: 320,
              title: "Untitled",
              body: "",
              createdAt: stamp,
              updatedAt: stamp,
            });
            s.selectedIds = [id];
          });
          scheduleSave();
          logEvent({ source: "canvas", kind: "note-add", summary: "New note", payload: { id } });
          return id;
        },
        addText: (at) => {
          takeSnapshot();
          const id = genId("n");
          const stamp = nowIso();
          set((s) => {
            s.nodes.push({
              id,
              kind: "text",
              x: at?.x ?? 0,
              y: at?.y ?? 0,
              width: 200,
              title: "",
              body: "",
              text: "Text",
              createdAt: stamp,
              updatedAt: stamp,
            });
            s.selectedIds = [id];
          });
          scheduleSave();
          logEvent({ source: "canvas", kind: "text-add", summary: "New text", payload: { id } });
          return id;
        },
        addShape: (shapeType, at, size) => {
          takeSnapshot();
          const id = genId("n");
          const stamp = nowIso();
          // Default sizes when placed with a click; drag-to-create passes `size`.
          const [defW, defH] =
            shapeType === "ellipse" || shapeType === "diamond" ? [130, 130] : [160, 90];
          const w = size ? Math.max(20, Math.round(size.width)) : defW;
          const h = size ? Math.max(20, Math.round(size.height)) : defH;
          set((s) => {
            s.nodes.push({
              id,
              kind: "shape",
              shapeType,
              x: at?.x ?? 0,
              y: at?.y ?? 0,
              width: w,
              height: h,
              title: "",
              body: "",
              text: "",
              createdAt: stamp,
              updatedAt: stamp,
            });
            s.selectedIds = [id];
          });
          scheduleSave();
          logEvent({ source: "canvas", kind: "shape-add", summary: shapeType, payload: { id } });
          return id;
        },
        addMedia: ({ src, mediaKind, width, height }, at) => {
          takeSnapshot();
          const id = genId("n");
          const stamp = nowIso();
          set((s) => {
            s.nodes.push({
              id,
              kind: "media",
              x: at?.x ?? 0,
              y: at?.y ?? 0,
              width: width ?? 320,
              height,
              title: "",
              body: "",
              src,
              mediaKind,
              createdAt: stamp,
              updatedAt: stamp,
            });
            s.selectedIds = [id];
          });
          scheduleSave();
          logEvent({ source: "canvas", kind: "media-add", summary: mediaKind, payload: { id } });
          return id;
        },
        updateNote: (id, patch) =>
          set((s) => {
            const n = s.nodes.find((n) => n.id === id);
            if (!n) return;
            if (patch.title !== undefined) n.title = patch.title;
            if (patch.body !== undefined) n.body = patch.body;
            if (patch.width !== undefined) n.width = patch.width;
            if (patch.height !== undefined) n.height = patch.height;
            if (patch.icon !== undefined) n.icon = patch.icon;
            if (patch.text !== undefined) n.text = patch.text;
            if (patch.src !== undefined) n.src = patch.src;
            if (patch.mediaKind !== undefined) n.mediaKind = patch.mediaKind;
            n.updatedAt = nowIso();
            scheduleSave();
          }),
        deleteNote: (id) => {
          takeSnapshot();
          const removed = get().nodes.find((n) => n.id === id);
          set((s) => {
            s.nodes = s.nodes.filter((n) => n.id !== id);
            s.edges = s.edges.filter((e) => e.source !== id && e.target !== id);
            s.selectedIds = s.selectedIds.filter((x) => x !== id);
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
        addEdge: (source, target, sourceHandle, targetHandle) => {
          if (source === target) return;
          const exists = get().edges.some(
            (e) =>
              (e.source === source && e.target === target) ||
              (e.source === target && e.target === source)
          );
          if (exists) return;
          takeSnapshot();
          set((s) => {
            s.edges.push({ id: genId("e"), source, target, sourceHandle, targetHandle });
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
          takeSnapshot();
          set((s) => {
            s.edges = s.edges.filter((e) => e.id !== id);
            scheduleSave();
          });
          logEvent({ source: "canvas", kind: "edge-delete", summary: "Connection removed", payload: { id } });
        },
        setSelected: (id) =>
          set((s) => {
            s.selectedIds = id ? [id] : [];
          }),
        setSelectedIds: (ids) =>
          set((s) => {
            s.selectedIds = ids;
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
        setTool: (tool) =>
          set((s) => {
            s.activeTool = tool;
          }),
        beginInteraction: () => takeSnapshot(),
        undo: () => {
          if (past.length === 0) return;
          future.push({ nodes: get().nodes, edges: get().edges });
          const prev = past.pop()!;
          set((s) => {
            s.nodes = prev.nodes;
            s.edges = prev.edges;
            s.canUndo = past.length > 0;
            s.canRedo = true;
          });
          scheduleSave();
        },
        redo: () => {
          if (future.length === 0) return;
          past.push({ nodes: get().nodes, edges: get().edges });
          const next = future.pop()!;
          set((s) => {
            s.nodes = next.nodes;
            s.edges = next.edges;
            s.canUndo = true;
            s.canRedo = future.length > 0;
          });
          scheduleSave();
        },
      },
      };
    })
  )
);
