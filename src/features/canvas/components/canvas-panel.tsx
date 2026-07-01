import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  ConnectionMode,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import * as Dialog from "@radix-ui/react-dialog";
import { StickyNote } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useCanvasStore, type CanvasNode, type ShapeType } from "../stores/canvas-store";
import { canvasMediaUpload } from "../lib/canvas-api";
import { NoteNode } from "./note-node";
import { TextNode } from "./text-node";
import { MediaNode } from "./media-node";
import { ShapeNode } from "./shape-node";
import { CanvasToolbar } from "./canvas-toolbar";
import { CanvasHeader } from "./canvas-header";
import { NoteEditorPanel } from "./note-editor-panel";

const nodeTypes = { note: NoteNode, text: TextNode, media: MediaNode, shape: ShapeNode };

export function CanvasPanel() {
  const fullscreen = useCanvasStore.use.fullscreen();
  const { setFullscreen } = useCanvasStore.use.actions();

  // The same canvas surface is rendered inside a Dialog when fullscreen is on,
  // otherwise inline. We toss away the inline tree while fullscreen so we
  // never have two ReactFlow instances competing for state at once.
  const surface = (
    <ReactFlowProvider>
      <CanvasSurface fullscreen={fullscreen} onToggleFullscreen={() => setFullscreen(!fullscreen)} />
    </ReactFlowProvider>
  );

  if (!fullscreen) return surface;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && setFullscreen(false)}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 bg-black/60"
          style={{ zIndex: "var(--z-overlay)" as unknown as number }}
        />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-12 left-6 right-6 bottom-6 rounded-xl border border-[var(--border-default)] bg-[var(--bg-base)] overflow-hidden flex flex-col shadow-[var(--shadow-overlay)] focus:outline-none"
          style={{ zIndex: "var(--z-modal)" as unknown as number }}
        >
          <Dialog.Title className="sr-only">Spaces</Dialog.Title>
          {surface}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CanvasSurface({
  fullscreen,
  onToggleFullscreen,
}: {
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const project = useProjectStore.use.currentProject();
  const projectPath = project?.path ?? null;

  const storeProjectPath = useCanvasStore.use.projectPath();
  const nodes = useCanvasStore.use.nodes();
  const edges = useCanvasStore.use.edges();
  const selectedId = useCanvasStore.use.selectedId();
  const loaded = useCanvasStore.use.loaded();
  const activeTool = useCanvasStore.use.activeTool();
  const {
    loadProject,
    addNote,
    addText,
    addMedia,
    addShape,
    moveNote,
    deleteNote,
    addEdge,
    deleteEdge,
    setSelected,
    setViewport,
    setTool,
  } = useCanvasStore.use.actions();

  // Which note is open in the slide-in editor (null = closed). Notes open on
  // double-click; text edits inline; media has no editor.
  const [editingId, setEditingId] = useState<string | null>(null);

  // Load when the project changes.
  useEffect(() => {
    if (!projectPath) return;
    if (storeProjectPath !== projectPath) {
      loadProject(projectPath).catch(() => {});
    }
  }, [projectPath, storeProjectPath, loadProject]);

  const rf = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Project store data → xyflow shape. Node `type` = kind so xyflow routes to the
  // right renderer; `data` carries only what that renderer needs.
  const rfNodes = useMemo<Node[]>(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: n.kind,
        position: { x: n.x, y: n.y },
        selected: n.id === selectedId,
        data:
          n.kind === "note"
            ? { title: n.title, body: n.body, updatedAt: n.updatedAt, icon: n.icon }
            : n.kind === "text"
              ? { text: n.text ?? "" }
              : n.kind === "shape"
                ? {
                    shapeType: n.shapeType ?? "rectangle",
                    text: n.text ?? "",
                    width: n.width,
                    height: n.height,
                  }
                : {
                    src: n.src ?? "",
                    projectPath: projectPath ?? "",
                    width: n.width,
                  },
        draggable: true,
      })),
    [nodes, selectedId, projectPath]
  );
  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
        type: "smoothstep",
        style: { stroke: "rgba(255,255,255,0.25)", strokeWidth: 1.5 },
      })),
    [edges]
  );

  // Apply position changes back to the store.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const c of changes) {
        if (c.type === "position" && c.position) {
          moveNote(c.id, c.position.x, c.position.y);
        } else if (c.type === "remove") {
          deleteNote(c.id);
        } else if (c.type === "select") {
          if (c.selected) setSelected(c.id);
        }
      }
    },
    [moveNote, deleteNote, setSelected]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) {
        if (c.type === "remove") deleteEdge(c.id);
      }
    },
    [deleteEdge]
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source && c.target) addEdge(c.source, c.target, c.sourceHandle, c.targetHandle);
    },
    [addEdge]
  );

  const viewportCenter = useCallback(
    (dx = 0, dy = 0) => {
      const wrap = wrapperRef.current;
      if (!wrap) return undefined;
      const rect = wrap.getBoundingClientRect();
      const c = rf.screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      return { x: c.x + dx, y: c.y + dy };
    },
    [rf]
  );

  // Click a create-tool, then click the canvas to drop it there; then revert to
  // Select. `connector`/`select` just clear selection on an empty-canvas click.
  const onPaneClick = useCallback(
    (e: React.MouseEvent) => {
      const tool = useCanvasStore.getState().activeTool;
      if (tool === "note" || tool === "text") {
        const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        if (tool === "note") addNote({ x: p.x - 130, y: p.y - 40 });
        else addText({ x: p.x, y: p.y });
        setTool("select");
      } else if (tool.startsWith("shape:")) {
        const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        addShape(tool.slice(6) as ShapeType, { x: p.x - 65, y: p.y - 45 });
        setTool("select");
      } else {
        setSelected(null);
      }
    },
    [rf, addNote, addText, addShape, setTool, setSelected]
  );

  const handleInsertMedia = useCallback(async () => {
    if (!projectPath) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({
      multiple: false,
      filters: [
        { name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"] },
      ],
    });
    if (!sel || Array.isArray(sel)) return;
    const path = sel as string;
    try {
      const rel = await canvasMediaUpload(projectPath, path);
      addMedia({ src: rel, mediaKind: "image" }, viewportCenter(-160, -90));
    } catch {
      /* silent — the dialog can be retried */
    }
  }, [projectPath, addMedia, viewportCenter]);

  const handleFit = useCallback(() => {
    if (nodes.length === 0) return;
    rf.fitView({ duration: 350, padding: 0.2 });
  }, [rf, nodes.length]);

  const onMoveEnd = useCallback(
    (_: unknown, vp: { x: number; y: number; zoom: number }) => {
      setViewport(vp);
    },
    [setViewport]
  );

  const jumpToNode = useCallback(
    (id: string) => {
      const n = (useCanvasStore.getState().nodes as CanvasNode[]).find((nn) => nn.id === id);
      if (!n) return;
      rf.setCenter(n.x + 160, n.y + 60, { duration: 350, zoom: rf.getZoom() });
    },
    [rf]
  );

  // Open the slide-in editor on a note double-click (text/media aren't notes).
  const onNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    const n = useCanvasStore.getState().nodes.find((x) => x.id === node.id);
    if (n?.kind === "note") setEditingId(node.id);
  }, []);

  if (!projectPath) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-[12px] text-text-tertiary gap-2 px-6 text-center">
        <StickyNote size={18} className="opacity-60" />
        <div>No project open.</div>
        <div className="text-[10px]">Spaces are per-project. Open a folder to start a board.</div>
      </div>
    );
  }

  const armed = activeTool === "note" || activeTool === "text" || activeTool.startsWith("shape:");

  return (
    <div ref={wrapperRef} className="h-full min-h-0 relative bg-bg-base">
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-text-tertiary z-30">
          Loading…
        </div>
      )}

      <ReactFlow
        className={cn(armed && "[&_.react-flow__pane]:!cursor-crosshair")}
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onMoveEnd={onMoveEnd}
        nodeTypes={nodeTypes}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={40}
        minZoom={0.2}
        maxZoom={2}
        fitView={false}
        defaultViewport={useCanvasStore.getState().viewport}
        deleteKeyCode={["Backspace", "Delete"]}
        proOptions={{ hideAttribution: true }}
        panOnScroll
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.2}
          color="rgba(255,255,255,0.18)"
        />
      </ReactFlow>

      {/* Floating overlays (Miro-style) */}
      <CanvasHeader
        noteCount={nodes.length}
        fullscreen={fullscreen}
        onFit={handleFit}
        onToggleFullscreen={onToggleFullscreen}
      />
      <CanvasToolbar activeTool={activeTool} onTool={setTool} onInsertMedia={handleInsertMedia} />

      {editingId && (
        <NoteEditorPanel
          key={editingId}
          noteId={editingId}
          projectPath={projectPath}
          onClose={() => setEditingId(null)}
          onJumpToNode={(id) => {
            setEditingId(id);
            jumpToNode(id);
          }}
        />
      )}
    </div>
  );
}

// Keep the named export the rest of the app already imports.
export { CanvasPanel as default };
