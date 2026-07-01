import { memo, useCallback, useEffect, useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "../stores/canvas-store";
import { NodeHandles } from "./node-handles";

export interface TextNodeData extends Record<string, unknown> {
  text: string;
}

/** Chrome-less free text. Single-click selects / drag moves; double-click edits
 *  inline (contentEditable + `nodrag` so editing doesn't drag the node), commit
 *  on blur. Not editable while idle, so the node stays draggable. */
export const TextNode = memo(function TextNode({ id, data, selected }: NodeProps) {
  const d = data as TextNodeData;
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

  return (
    <div
      className={cn(
        "group relative rounded",
        selected && "outline outline-1 outline-[var(--accent-primary)]/50",
      )}
      onDoubleClick={() => setEditing(true)}
    >
      <NodeHandles selected={selected} />
      <div
        ref={ref}
        className={cn(
          "whitespace-pre-wrap break-words min-w-[40px] px-1 py-0.5 outline-none",
          "text-[15px] leading-snug text-[var(--text-primary)]",
          editing ? "nodrag cursor-text" : "cursor-default select-none",
        )}
        contentEditable={editing}
        suppressContentEditableWarning
        onBlur={commit}
      >
        {d.text}
      </div>
    </div>
  );
});
