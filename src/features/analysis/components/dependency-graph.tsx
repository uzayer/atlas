import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

interface DepEdge {
  from: string;
  to: string;
  symbol: string;
}

export function DependencyGraph({ edges: depEdges }: { edges: DepEdge[] }) {
  const { initialNodes, initialEdges } = useMemo(() => {
    // Collect unique files
    const fileSet = new Set<string>();
    for (const e of depEdges) {
      fileSet.add(e.from);
      fileSet.add(e.to);
    }
    const files = Array.from(fileSet);

    // Position nodes in a circle (Obsidian-style)
    const cx = 300;
    const cy = 250;
    const radius = Math.max(120, files.length * 18);

    // Count connections per file for sizing
    const connectionCount: Record<string, number> = {};
    for (const e of depEdges) {
      connectionCount[e.from] = (connectionCount[e.from] || 0) + 1;
      connectionCount[e.to] = (connectionCount[e.to] || 0) + 1;
    }
    const maxConn = Math.max(1, ...Object.values(connectionCount));

    const nodes: Node[] = files.map((file, i) => {
      const angle = (2 * Math.PI * i) / files.length - Math.PI / 2;
      const conns = connectionCount[file] || 1;
      const sizeFactor = 0.6 + (conns / maxConn) * 0.8;
      const shortName = file.split("/").pop() ?? file;

      return {
        id: file,
        position: {
          x: cx + radius * Math.cos(angle),
          y: cy + radius * Math.sin(angle),
        },
        data: { label: shortName },
        style: {
          background: "var(--bg-elevated)",
          border: `1.5px solid var(--accent-primary)`,
          borderRadius: "50%",
          width: Math.round(32 * sizeFactor),
          height: Math.round(32 * sizeFactor),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: Math.max(7, Math.round(9 * sizeFactor)),
          color: "var(--text-primary)",
          padding: "2px",
          boxShadow: `0 0 ${Math.round(6 * sizeFactor)}px rgba(158, 108, 10, ${0.15 * sizeFactor})`,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap" as const,
        },
        draggable: true,
      };
    });

    const edges: Edge[] = depEdges.map((e, i) => ({
      id: `dep-${i}`,
      source: e.from,
      target: e.to,
      animated: false,
      style: {
        stroke: "var(--accent-primary)",
        strokeWidth: 1,
        opacity: 0.4,
      },
      label: e.symbol,
      labelStyle: {
        fontSize: 7,
        fill: "var(--text-tertiary)",
      },
      labelBgStyle: {
        fill: "var(--bg-base)",
        opacity: 0.8,
      },
    }));

    return { initialNodes: nodes, initialEdges: edges };
  }, [depEdges]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [flowEdges, , onEdgesChange] = useEdgesState(initialEdges);

  if (depEdges.length === 0) {
    return (
      <div className="text-[10px] text-text-tertiary text-center py-3">
        No shared symbols detected
      </div>
    );
  }

  return (
    <div style={{ height: Math.min(350, 120 + depEdges.length * 8), width: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        style={{ background: "transparent" }}
        nodesDraggable
        panOnDrag={[0, 1, 2]}
        panOnScroll
        zoomOnScroll
        zoomOnPinch
        preventScrolling
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={16}
          size={0.5}
          color="var(--border-subtle)"
        />
      </ReactFlow>
    </div>
  );
}
