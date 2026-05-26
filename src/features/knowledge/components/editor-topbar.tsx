import { ChevronRight, Folder, PanelRight } from "lucide-react";

interface EditorTopbarProps {
  /** Folder/segment trail (empty for root-level pages). */
  breadcrumbs?: string[];
  /** Trailing page name. */
  title: string;
  /** Icon emoji or null. Falls back to a doc glyph. */
  icon?: string | null;
  /** Tag pill on the right ("NOTE", "PAPER", "REPO" etc.). */
  kind?: string;
  /** Show a small dirty dot before the inspector toggle. */
  isDirty?: boolean;
  /** Toggle the right inspector panel. */
  onToggleInspector?: () => void;
}

/**
 * Compact note topbar. Just breadcrumbs + kind pill + a single
 * inspector toggle on the right — History / Pin / More were removed in
 * batch 1 of the user's feedback since none of them wire to anything.
 */
export function EditorTopbar({
  breadcrumbs = [],
  title,
  icon,
  kind = "NOTE",
  isDirty,
  onToggleInspector,
}: EditorTopbarProps) {
  return (
    <div
      className="flex items-center shrink-0 border-b border-border-subtle"
      style={{
        height: 36,
        gap: 8,
        padding: "0 14px",
        background: "var(--bg-canvas)",
      }}
    >
      {/* Breadcrumbs */}
      <div
        className="flex items-center min-w-0"
        style={{ gap: 6, fontSize: 12, color: "var(--text-tertiary)" }}
      >
        {breadcrumbs.map((segment, i) => (
          <span key={i} className="flex items-center" style={{ gap: 6 }}>
            <Folder size={11} className="text-text-muted shrink-0" strokeWidth={1.5} />
            <span className="truncate">{segment}</span>
            <ChevronRight size={10} className="text-text-muted shrink-0" />
          </span>
        ))}
        <span
          className="flex items-center text-text-primary truncate"
          style={{ gap: 5 }}
        >
          <span className="leading-none">{icon ?? "📄"}</span>
          <span className="truncate">{title}</span>
        </span>
      </div>

      <span className="pill pill-bare" style={{ height: 18, fontSize: 9.5, padding: "0 6px" }}>
        {kind}
      </span>

      <span className="flex-1" />

      {isDirty && (
        <span
          className="dot"
          style={{ background: "var(--text-primary)", width: 6, height: 6 }}
          title="Unsaved changes"
        />
      )}
      {onToggleInspector && (
        <button
          onClick={onToggleInspector}
          className="p-1 rounded text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors"
          title="Toggle inspector"
          style={{ width: 22, height: 22 }}
        >
          <PanelRight size={12} />
        </button>
      )}
    </div>
  );
}
