import { Crosshair, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { AtlasIcon } from "@/components/atlas-icon";

/**
 * Floating top-left board header (replaces the old fixed bar). Glassmorphic pill
 * with the board name + note count and quick actions (fit, fullscreen).
 */
export function CanvasHeader({
  noteCount,
  fullscreen,
  onFit,
  onToggleFullscreen,
}: {
  noteCount: number;
  fullscreen: boolean;
  onFit: () => void;
  onToggleFullscreen: () => void;
}) {
  return (
    <div
      className={cn(
        "absolute left-3 top-3 z-20 flex items-center gap-1.5 pl-2 pr-1 py-1",
        "rounded-xl border border-white/10 bg-[var(--bg-secondary)]/70 backdrop-blur-2xl shadow-[var(--shadow-overlay)]",
      )}
    >
      <AtlasIcon size={16} className="rounded-md shrink-0" />
      <span className="text-[12px] font-semibold text-text-primary">Spaces</span>
      <span className="text-[10px] text-text-tertiary">· {noteCount}</span>
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
