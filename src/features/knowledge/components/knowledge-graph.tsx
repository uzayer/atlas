import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Application,
  Container,
  Graphics,
  Text,
  TextStyle,
  type Ticker,
  type FederatedPointerEvent,
} from "pixi.js";
import Matter from "matter-js";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useKnowledgeStore } from "../stores/knowledge-store";
import { useKnowledgeMetaStore } from "../stores/knowledge-meta-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  useKnowledgeGraphStore,
  useProjectGraph,
  type ProjectGraph,
} from "../stores/knowledge-graph-store";

/**
 * Obsidian-style force-directed knowledge graph.
 *
 * Implementation note: we use Pixi imperatively (not via @pixi/react)
 * because @pixi/react@8 globally augments React's JSX namespace and
 * breaks unrelated component typing in Atlas. Doing it by hand is more
 * code but reliable — Pixi just gets a `<canvas>` element and a single
 * mount effect that wires up the scene + Matter physics.
 */

const RESOLUTION = 2;
const NODE_CAP = 1000;

const COLOR_PRIMARY = 0xfafafa;
const COLOR_SECONDARY = 0xc4c4c4;
const COLOR_MUTED = 0x5e5e5e;
const COLOR_EDGE_DEFAULT = 0x333333;
const COLOR_EDGE_SELECTED = 0xc4c4c4;
const COLOR_EDGE_DIM = 0x262626;

const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.001;
const HIDE_LABEL_BELOW = 0.5;
const DOUBLE_CLICK_MS = 280;

function nodeRadiusForDegree(degree: number): number {
  return Math.min(10 + Math.sqrt(Math.max(0, degree)) * 3, 32);
}

interface NodeView {
  id: string;
  body: Matter.Body;
  radius: number;
  graphics: Graphics;
  label: Text;
}

interface EdgeView {
  from: string;
  to: string;
  graphics: Graphics;
}

interface SceneState {
  selectedId: string | null;
  neighbors: Set<string>;
  zoom: number;
}

export function KnowledgeGraph() {
  const currentProject = useProjectStore.use.currentProject();
  const { bind, unbind } = useKnowledgeGraphStore.use.actions();
  const { addTab } = useLayoutStore.use.actions();
  const { selectEntry } = useKnowledgeStore.use.actions();
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { graph: rawGraph, loading } = useProjectGraph();
  const metaPages = useKnowledgeMetaStore.use.pages();

  // Enrich node titles with `meta.title` when set. Rust now returns
  // the filename as the title (no longer derives from the first `#`
  // line), so the user-edited page-header title always wins when present
  // and the filename — e.g. `note-1779272396411` — shows otherwise.
  const graph = useMemo<ProjectGraph>(() => {
    if (!rawGraph.nodes.length) return rawGraph;
    return {
      ...rawGraph,
      nodes: rawGraph.nodes.map((n) => {
        const override = metaPages[n.id]?.title?.trim();
        return override ? { ...n, title: override } : n;
      }),
    };
  }, [rawGraph, metaPages]);

  // ResizeObserver so the canvas matches the tab content area.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({
        width: Math.max(200, Math.floor(width)),
        height: Math.max(200, Math.floor(height)),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (currentProject) void bind(currentProject.path);
    return () => unbind();
  }, [currentProject?.path, bind, unbind]);

  if (!currentProject) {
    return (
      <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
        Open a project first
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full relative"
      style={{ background: "var(--bg-canvas)" }}
    >
      {loading ? (
        <LoadingState />
      ) : graph.nodes.length === 0 ? (
        <EmptyState />
      ) : graph.nodes.length > NODE_CAP ? (
        <div className="h-full w-full flex items-center justify-center text-text-tertiary text-sm">
          Graph too large — {graph.nodes.length} nodes (cap {NODE_CAP}).
        </div>
      ) : size.width > 0 && size.height > 0 ? (
        <GraphCanvas
          graph={graph}
          width={size.width}
          height={size.height}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onActivate={(entryId) => {
            addTab({
              id: "knowledge",
              type: "knowledge",
              title: "Knowledge",
              closable: true,
              dirty: false,
              data: {},
            });
            selectEntry(entryId);
          }}
        />
      ) : null}
    </div>
  );
}

function GraphCanvas({
  graph,
  width,
  height,
  selectedId,
  onSelect,
  onActivate,
}: {
  graph: ProjectGraph;
  width: number;
  height: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onActivate: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // We re-create the entire scene when graph identity OR canvas size
  // changes; selection updates are pushed in via a ref so we don't pay
  // a mount/unmount cycle for them.
  const sceneRef = useRef<SceneState>({
    selectedId,
    neighbors: new Set(),
    zoom: 1,
  });

  // Keep sceneRef in sync with selection without triggering re-render
  // of the canvas effect.
  useEffect(() => {
    const neighbors = new Set<string>();
    if (selectedId) {
      for (const e of graph.edges) {
        if (e.from === selectedId) neighbors.add(e.to);
        else if (e.to === selectedId) neighbors.add(e.from);
      }
    }
    sceneRef.current = {
      ...sceneRef.current,
      selectedId,
      neighbors,
    };
  }, [selectedId, graph.edges]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let teardown: (() => void) | null = null;
    let createdApp: Application | null = null;

    // Create the canvas imperatively each mount so React StrictMode's
    // double-mount (dev only) can't hand a half-destroyed WebGL canvas
    // back to a fresh Pixi Application — that path produced the
    // `shaderSource must be a WebGLShader` crash in WKWebView.
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);

    const app = new Application();
    createdApp = app;
    void app
      .init({
        canvas,
        width,
        height,
        resolution: RESOLUTION,
        antialias: true,
        backgroundAlpha: 0,
        autoDensity: true,
        // WKWebView's WebGL2 path is flaky on macOS Tauri; pin v1.
        // Pixi v8 falls back automatically if v1 isn't available.
        preferWebGLVersion: 1,
      })
      .then(() => {
        if (disposed) {
          // Already torn down before init resolved — drop the app.
          try { app.destroy(true, { children: true }); } catch { /* ignore */ }
          return;
        }
        teardown = buildScene(app, graph, width, height, sceneRef, onSelect, onActivate);
      })
      .catch(() => {
        // ignore — disposal cleanup below handles the fallout.
      });

    return () => {
      disposed = true;
      if (teardown) {
        try { teardown(); } catch { /* ignore */ }
      }
      if (createdApp) {
        try { createdApp.destroy(true, { children: true }); } catch { /* ignore */ }
      }
      try { host.removeChild(canvas); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, width, height]);

  return <div ref={hostRef} style={{ width: "100%", height: "100%" }} />;
}

/**
 * Builds the scene graph + Matter world + per-tick draw loop. Returns
 * a teardown function the caller uses to clean up. Kept outside the
 * component so it's easy to reason about as a pure imperative step.
 */
function buildScene(
  app: Application,
  graph: ProjectGraph,
  width: number,
  height: number,
  sceneRef: React.MutableRefObject<SceneState>,
  onSelect: (id: string | null) => void,
  onActivate: (id: string) => void,
): () => void {
  // ── Physics world ─────────────────────────────────────────────
  const engine = Matter.Engine.create();
  engine.gravity.x = 0;
  engine.gravity.y = 0;
  engine.constraintIterations = 7;

  // Static boundary walls
  const walls = [
    Matter.Bodies.rectangle(width / 2, height + 50, width + 200, 100, { isStatic: true }),
    Matter.Bodies.rectangle(width / 2, -50, width + 200, 100, { isStatic: true }),
    Matter.Bodies.rectangle(-50, height / 2, 100, height + 200, { isStatic: true }),
    Matter.Bodies.rectangle(width + 50, height / 2, 100, height + 200, { isStatic: true }),
  ];
  Matter.Composite.add(engine.world, walls);

  // ── Scene graph ───────────────────────────────────────────────
  const viewport = new Container();
  app.stage.addChild(viewport);
  // Background hit area for "click empty → clear selection".
  const bgHit = new Graphics();
  bgHit.rect(-1e5, -1e5, 2e5, 2e5).fill({ color: 0x000000, alpha: 0 });
  bgHit.eventMode = "static";
  bgHit.on("pointertap", () => onSelect(null));
  viewport.addChild(bgHit);

  const edgeLayer = new Container();
  const nodeLayer = new Container();
  const labelLayer = new Container();
  viewport.addChild(edgeLayer, nodeLayer, labelLayer);

  // ── Initial layout: circle so the simulation starts balanced. ─
  const nodesById = new Map<string, NodeView>();
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.35;
  const n = graph.nodes.length;

  const labelStyles = new Map<string, TextStyle>();
  const styleFor = (fill: string): TextStyle => {
    let s = labelStyles.get(fill);
    if (!s) {
      s = new TextStyle({
        fontFamily: "Inter, -apple-system, system-ui, sans-serif",
        fontSize: 11,
        fontWeight: "500",
        fill,
        align: "center",
      });
      labelStyles.set(fill, s);
    }
    return s;
  };

  graph.nodes.forEach((node, i) => {
    const angle = (i / Math.max(1, n)) * Math.PI * 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    const radius = nodeRadiusForDegree(node.inDegree + node.outDegree);
    const body = Matter.Bodies.circle(x, y, radius, {
      friction: 1,
      density: 0.1,
      restitution: 0,
      frictionAir: 0.09,
      frictionStatic: 1,
    });
    Matter.Composite.add(engine.world, body);

    const graphics = new Graphics();
    graphics.eventMode = "static";
    graphics.cursor = "pointer";
    let lastTapAt = 0;
    graphics.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      const now = performance.now();
      if (now - lastTapAt < DOUBLE_CLICK_MS) {
        onActivate(node.id);
        lastTapAt = 0;
      } else {
        onSelect(node.id);
        lastTapAt = now;
      }
    });
    nodeLayer.addChild(graphics);

    const label = new Text({ text: node.title, style: styleFor("#c4c4c4") });
    label.anchor.set(0.5);
    labelLayer.addChild(label);

    nodesById.set(node.id, { id: node.id, body, radius, graphics, label });
  });

  // Edges
  const edges: EdgeView[] = graph.edges.map((e) => {
    const g = new Graphics();
    edgeLayer.addChild(g);
    return { from: e.from, to: e.to, graphics: g };
  });

  // ── Mouse drag (Matter MouseConstraint) ───────────────────────
  const mouse = Matter.Mouse.create(app.canvas as HTMLCanvasElement);
  const mouseScale = RESOLUTION / Math.pow(RESOLUTION, 2);
  Matter.Mouse.setScale(mouse, { x: mouseScale, y: mouseScale });
  const mouseConstraint = Matter.MouseConstraint.create(engine, {
    mouse,
    constraint: {
      stiffness: 0.2,
      render: { visible: false } as Matter.IConstraintRenderDefinition,
    },
  });
  Matter.Composite.add(engine.world, mouseConstraint);

  // ── Viewport pan / zoom ───────────────────────────────────────
  let panStart: { startX: number; startY: number; origX: number; origY: number } | null = null;
  const canvas = app.canvas as HTMLCanvasElement;

  const onContext = (e: Event) => e.preventDefault();
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const lx = e.clientX - rect.left;
    const ly = e.clientY - rect.top;
    const oldScale = viewport.scale.x;
    const newScale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, oldScale * Math.exp(-e.deltaY * ZOOM_STEP)),
    );
    const worldX = (lx - viewport.position.x) / oldScale;
    const worldY = (ly - viewport.position.y) / oldScale;
    viewport.scale.set(newScale);
    viewport.position.set(lx - worldX * newScale, ly - worldY * newScale);
    sceneRef.current = { ...sceneRef.current, zoom: newScale };
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 1 && e.button !== 2) return;
    e.preventDefault();
    panStart = {
      startX: e.clientX,
      startY: e.clientY,
      origX: viewport.position.x,
      origY: viewport.position.y,
    };
    canvas.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!panStart) return;
    viewport.position.set(
      panStart.origX + (e.clientX - panStart.startX),
      panStart.origY + (e.clientY - panStart.startY),
    );
  };
  const onPointerUp = (e: PointerEvent) => {
    if (panStart) {
      panStart = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  };

  canvas.addEventListener("contextmenu", onContext);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  // ── Sleep/wake state ──────────────────────────────────────────
  let awake = true;
  let sleepFrames = 0;
  const wake = () => { awake = true; sleepFrames = 0; };
  window.addEventListener("pointerdown", wake);
  window.addEventListener("pointermove", wake);
  window.addEventListener("wheel", wake, { passive: true });

  // ── Per-tick draw ─────────────────────────────────────────────
  const tick = (ticker: Ticker) => {
    if (awake) {
      Matter.Engine.update(engine, ticker.deltaMS);
      let total = 0, count = 0;
      for (const node of nodesById.values()) {
        const v = node.body.velocity;
        total += Math.abs(v.x) + Math.abs(v.y);
        count += 1;
      }
      const avg = count > 0 ? total / count : 0;
      if (avg < 0.05) {
        sleepFrames += 1;
        if (sleepFrames > 30) awake = false;
      } else {
        sleepFrames = 0;
      }
    }

    const { selectedId, neighbors, zoom } = sceneRef.current;
    const hasSelection = selectedId !== null;
    const showLabels = zoom >= HIDE_LABEL_BELOW;

    // Nodes
    for (const node of nodesById.values()) {
      const isSelected = selectedId === node.id;
      const isNeighbor = neighbors.has(node.id);
      let color = COLOR_SECONDARY;
      let alpha = 1;
      let drawRadius = node.radius;
      if (hasSelection) {
        if (isSelected) {
          color = COLOR_PRIMARY;
          drawRadius = node.radius * 1.2;
        } else if (isNeighbor) {
          color = COLOR_PRIMARY;
        } else {
          color = COLOR_MUTED;
          alpha = 0.4;
        }
      }
      node.graphics.clear();
      if (isSelected) {
        node.graphics.circle(node.body.position.x, node.body.position.y, drawRadius + 3);
        node.graphics.stroke({ width: 2, color: COLOR_PRIMARY, alpha: 0.6 });
      }
      node.graphics.circle(node.body.position.x, node.body.position.y, drawRadius);
      node.graphics.fill({ color, alpha });

      // Label position + tint
      node.label.position.set(node.body.position.x, node.body.position.y + node.radius + 12);
      if (!showLabels) {
        node.label.alpha = 0;
      } else if (!hasSelection) {
        node.label.alpha = 0.85;
        node.label.style = styleFor("#c4c4c4");
      } else if (isSelected || isNeighbor) {
        node.label.alpha = 1;
        node.label.style = styleFor("#fafafa");
      } else {
        node.label.alpha = 0.3;
        node.label.style = styleFor("#5e5e5e");
      }
    }

    // Edges
    for (const edge of edges) {
      const a = nodesById.get(edge.from);
      const b = nodesById.get(edge.to);
      edge.graphics.clear();
      if (!a || !b) continue;
      const touchesSelection =
        hasSelection && (selectedId === edge.from || selectedId === edge.to);
      let color = COLOR_EDGE_DEFAULT;
      let alpha = 0.3;
      if (hasSelection) {
        if (touchesSelection) {
          color = COLOR_EDGE_SELECTED;
          alpha = 0.9;
        } else {
          color = COLOR_EDGE_DIM;
          alpha = 0.15;
        }
      }
      edge.graphics.moveTo(a.body.position.x, a.body.position.y);
      edge.graphics.lineTo(b.body.position.x, b.body.position.y);
      edge.graphics.stroke({ width: 1, color, alpha });
    }
  };
  app.ticker.add(tick);

  return () => {
    app.ticker.remove(tick);
    canvas.removeEventListener("contextmenu", onContext);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("pointerdown", wake);
    window.removeEventListener("pointermove", wake);
    window.removeEventListener("wheel", wake);
    Matter.Composite.clear(engine.world, false, true);
    Matter.Engine.clear(engine);
  };
}

function LoadingState() {
  return (
    <div className="h-full w-full flex items-center justify-center text-text-tertiary">
      <span className="text-[11px]">Building graph…</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center text-text-tertiary gap-2">
      <div className="text-[12px]">No notes yet — create some and reference them with</div>
      <div className="mono text-[11px] text-text-muted">[[note-id]]</div>
      <div className="text-[12px]">to see them connect here.</div>
    </div>
  );
}
