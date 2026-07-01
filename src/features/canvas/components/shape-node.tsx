import { memo, useCallback, useEffect, useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import { useCanvasStore, type ShapeType } from "../stores/canvas-store";
import { NodeHandles } from "./node-handles";

export interface ShapeNodeData extends Record<string, unknown> {
  shapeType: ShapeType;
  text: string;
  width?: number;
  height?: number;
}

/** The shape outline, drawn in a normalized 100×100 viewBox stretched to the
 *  node box (`preserveAspectRatio: none`). `vector-effect: non-scaling-stroke`
 *  keeps the border an even width regardless of the box's aspect ratio. */
function ShapeSvg({ type, stroke }: { type: ShapeType; stroke: string }) {
  const common = {
    fill: "var(--bg-secondary)",
    fillOpacity: 0.7,
    stroke,
    strokeWidth: 1.5,
    vectorEffect: "non-scaling-stroke" as const,
  };
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      {type === "ellipse" ? (
        <ellipse cx={50} cy={50} rx={49} ry={49} {...common} />
      ) : type === "diamond" ? (
        <polygon points="50,1 99,50 50,99 1,50" {...common} />
      ) : (
        <rect x={1} y={1} width={98} height={98} rx={type === "rounded" ? 14 : 0} {...common} />
      )}
    </svg>
  );
}

/** Geometric flowchart shape. Connectable from any side (shared handles); the
 *  only editable content is a centered text label (double-click to edit). */
export const ShapeNode = memo(function ShapeNode({ id, data, selected }: NodeProps) {
  const d = data as ShapeNodeData;
  const { updateNote } = useCanvasStore.use.actions();
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    updateNote(id, { text: ref.current?.innerText ?? "" });
  }, [id, updateNote]);

  const stroke = selected ? "var(--accent-primary)" : "rgba(255,255,255,0.25)";

  return (
    <div
      className="group relative"
      style={{ width: d.width ?? 160, height: d.height ?? 90 }}
      onDoubleClick={() => setEditing(true)}
    >
      <NodeHandles selected={selected} />
      <ShapeSvg type={d.shapeType} stroke={stroke} />
      {/* Centered label overlay */}
      <div className="absolute inset-0 flex items-center justify-center p-3">
        <div
          ref={ref}
          className={cn(
            "max-w-full whitespace-pre-wrap break-words text-center outline-none",
            "text-[12px] leading-snug text-[var(--text-primary)]",
            editing ? "nodrag cursor-text" : "cursor-default select-none",
          )}
          contentEditable={editing}
          suppressContentEditableWarning
          onBlur={commit}
        >
          {d.text}
        </div>
      </div>
    </div>
  );
});
