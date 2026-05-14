import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, Maximize2, Minimize2, Crosshair, StickyNote } from "lucide-react";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useCanvasStore, type CanvasNode } from "../stores/canvas-store";
import { NoteNode, type NoteNodeData } from "./note-node";
import { NoteInspector } from "./note-inspector";

const nodeTypes = { note: NoteNode };

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
  const {
    loadProject,
    addNote,
    moveNote,
    deleteNote,
    addEdge,
    deleteEdge,
    setSelected,
    setViewport,
  } = useCanvasStore.use.actions();

  // Load when the project changes.
  useEffect(() => {
    if (!projectPath) return;
    if (storeProjectPath !== projectPath) {
      loadProject(projectPath).catch(() => {});
    }
  }, [projectPath, storeProjectPath, loadProject]);

  const rf = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Project store data → xyflow shape.
  const rfNodes = useMemo<Node<NoteNodeData>[]>(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: "note",
        position: { x: n.x, y: n.y },
        selected: n.id === selectedId,
        data: {
          title: n.title,
          body: n.body,
          updatedAt: n.updatedAt,
        },
        // We disable connections-from-everywhere; handles on the node provide them.
        draggable: true,
      })),
    [nodes, selectedId]
  );
  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
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
      if (c.source && c.target) addEdge(c.source, c.target);
    },
    [addEdge]
  );

  const handleAddNote = useCallback(() => {
    // Drop new notes near the current viewport center so they're visible.
    const wrap = wrapperRef.current;
    if (!wrap) {
      addNote();
      return;
    }
    const rect = wrap.getBoundingClientRect();
    const center = rf.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    addNote({ x: center.x - 160, y: center.y - 60 });
  }, [rf, addNote]);

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

  if (!projectPath) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-[12px] text-text-tertiary gap-2 px-6 text-center">
        <StickyNote size={18} className="opacity-60" />
        <div>No project open.</div>
        <div className="text-[10px]">Spaces are per-project. Open a folder to start a board.</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-bg-base">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 h-[32px] shrink-0 border-b border-border-default">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-text-secondary font-medium">Spaces</span>
          <span className="text-[10px] text-text-tertiary">· {nodes.length} notes</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleAddNote}
            className="flex items-center gap-1.5 px-2 h-6 rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            title="Add note"
          >
            <Plus size={11} />
            Note
          </button>
          <button
            onClick={handleFit}
            className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
            title="Fit to view"
          >
            <Crosshair size={11} />
          </button>
          <button
            onClick={onToggleFullscreen}
            className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          </button>
        </div>
      </div>

      {/* Canvas + inspector */}
      <div ref={wrapperRef} className="flex-1 min-h-0 relative">
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-text-tertiary">
            Loading…
          </div>
        )}

        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onPaneClick={() => setSelected(null)}
          onMoveEnd={onMoveEnd}
          nodeTypes={nodeTypes}
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

        {selectedId && (
          <NoteInspector onClose={() => setSelected(null)} onJumpToNode={jumpToNode} />
        )}
      </div>
    </div>
  );
}

// Keep the named export the rest of the app already imports.
export { CanvasPanel as default };
