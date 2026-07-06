import { Crosshair, Maximize2, Minimize2, PanelLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_PAGE_ICON } from "./pages-panel";

/**
 * Floating top-left board header (replaces the old fixed bar). Glassmorphic pill
 * with the pages toggle + active page emoji/name + quick actions (fit, fullscreen).
 */
export function CanvasHeader({
  pageName,
  pageIcon,
  pagesOpen,
  onTogglePages,
  fullscreen,
  onFit,
  onToggleFullscreen,
}: {
  pageName: string;
  pageIcon?: string | null;
  pagesOpen: boolean;
  onTogglePages: () => void;
  fullscreen: boolean;
  onFit: () => void;
  onToggleFullscreen: () => void;
}) {
  return (
    <div
      className={cn(
        "absolute left-3 top-3 z-20 flex items-center gap-1.5 pl-1 pr-1 py-1",
        "rounded-xl border border-white/10 bg-[var(--bg-secondary)]/70 backdrop-blur-2xl shadow-[var(--shadow-overlay)]",
      )}
    >
      <button
        type="button"
        onClick={onTogglePages}
        title={pagesOpen ? "Hide pages" : "Show pages"}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-md transition-colors cursor-pointer",
          pagesOpen
            ? "bg-bg-selected text-text-primary"
            : "text-text-tertiary hover:bg-bg-hover hover:text-text-primary",
        )}
      >
        <PanelLeft size={13} />
      </button>
      <div className="mx-0.5 h-4 w-px bg-white/10" />
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[12px] leading-none">
        {pageIcon || DEFAULT_PAGE_ICON}
      </span>
      <span className="max-w-[180px] truncate text-[12px] font-semibold text-text-primary">
        {pageName || "Spaces"}
      </span>
      <div className="mx-0.5 h-4 w-px bg-white/10" />
      <button
        type="button"
        onClick={onFit}
        title="Fit to view"
        className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
      >
        <Crosshair size={12} />
      </button>
      <button
        type="button"
        onClick={onToggleFullscreen}
        title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
      >
        {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
      </button>
    </div>
  );
}
