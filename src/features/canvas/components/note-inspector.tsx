import { useEffect, useMemo, useState } from "react";
import { X, Trash2, Eye, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/lib/markdown";
import { useCanvasStore } from "../stores/canvas-store";

interface NoteInspectorProps {
  onClose: () => void;
  onJumpToNode?: (id: string) => void;
}

export function NoteInspector({ onClose, onJumpToNode }: NoteInspectorProps) {
  const selectedId = useCanvasStore.use.selectedId();
  const nodes = useCanvasStore.use.nodes();
  const edges = useCanvasStore.use.edges();
  const { updateNote, deleteNote, setSelected } = useCanvasStore.use.actions();
  const note = nodes.find((n) => n.id === selectedId) ?? null;

  const [mode, setMode] = useState<"preview" | "edit">("preview");
  // Auto-edit when opening a brand-new empty note.
  useEffect(() => {
    if (!note) return;
    if (!note.body.trim() && note.title === "Untitled") {
      setMode("edit");
    } else {
      setMode("preview");
    }
  }, [note?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on Esc.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const connections = useMemo(() => {
    if (!note) return [];
    return edges
      .filter((e) => e.source === note.id || e.target === note.id)
      .map((e) => {
        const otherId = e.source === note.id ? e.target : e.source;
        const other = nodes.find((n) => n.id === otherId);
        return other ? { id: other.id, title: other.title || "Untitled" } : null;
      })
      .filter((x): x is { id: string; title: string } => Boolean(x));
  }, [note, edges, nodes]);

  if (!note) return null;

  const created = new Date(note.createdAt);
  const updated = new Date(note.updatedAt);

  return (
    <div
      className={cn(
        "absolute right-0 top-0 h-full w-[360px] z-10 flex flex-col",
        "border-l border-white/10 bg-[var(--bg-base)]/60 backdrop-blur-2xl backdrop-saturate-150 shadow-2xl"
      )}
    >
      {/* Inner glow */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/5 to-transparent opacity-50" />

      {/* Top bar */}
      <div className="relative flex items-center justify-between px-3 h-[34px] border-b border-white/10 shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
          Note
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setMode(mode === "edit" ? "preview" : "edit")}
            className="p-1 rounded hover:bg-white/10 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
            title={mode === "edit" ? "Preview" : "Edit"}
          >
            {mode === "edit" ? <Eye size={12} /> : <Pencil size={12} />}
          </button>
          <button
            onClick={() => {
              deleteNote(note.id);
              onClose();
            }}
            className="p-1 rounded hover:bg-white/10 text-[var(--text-tertiary)] hover:text-[var(--status-error)] cursor-pointer transition-colors"
            title="Delete note"
          >
            <Trash2 size={12} />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-white/10 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
            title="Close"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar p-4 space-y-4 relative">
        {/* Title */}
        <Section label="Title">
          {mode === "edit" ? (
            <input
              value={note.title}
              onChange={(e) => updateNote(note.id, { title: e.target.value })}
              placeholder="Untitled"
              className="w-full bg-transparent outline-none text-[14px] font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] border-b border-white/10 pb-1 focus:border-[var(--accent-primary)]/60"
            />
          ) : (
            <div className="text-[14px] font-semibold text-[var(--text-primary)]">
              {note.title || "Untitled"}
            </div>
          )}
        </Section>

        {/* Body */}
        <Section label="Body">
          {mode === "edit" ? (
            <textarea
              value={note.body}
              onChange={(e) => updateNote(note.id, { body: e.target.value })}
              placeholder="Markdown supported — lists, code, links…"
              className={cn(
                "w-full min-h-[240px] bg-transparent outline-none resize-none",
                "text-[12px] leading-relaxed font-mono",
                "text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]",
                "border border-white/10 rounded-md p-2 focus:border-[var(--accent-primary)]/60"
              )}
            />
          ) : note.body.trim() ? (
            <div className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
              <Markdown>{note.body}</Markdown>
            </div>
          ) : (
            <div className="text-[11px] text-[var(--text-tertiary)] italic">Empty — click Edit to add content.</div>
          )}
        </Section>

        {/* Connections */}
        {connections.length > 0 && (
          <Section label={`Connections · ${connections.length}`}>
            <div className="rounded-md border border-white/10 bg-white/5 divide-y divide-white/10 overflow-hidden">
              {connections.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setSelected(c.id);
                    onJumpToNode?.(c.id);
                  }}
                  className="w-full text-left px-2.5 py-2 text-[11px] text-[var(--text-secondary)] hover:bg-white/10 hover:text-[var(--text-primary)] cursor-pointer truncate"
                >
                  {c.title}
                </button>
              ))}
            </div>
          </Section>
        )}

        {/* Metadata */}
        <Section label="Metadata">
          <div className="space-y-1 text-[10px] font-mono text-[var(--text-tertiary)]">
            <div>created · {created.toLocaleString()}</div>
            <div>updated · {updated.toLocaleString()}</div>
            <div className="truncate">id · {note.id}</div>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
        {label}
      </div>
      {children}
    </div>
  );
}
