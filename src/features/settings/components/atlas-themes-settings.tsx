import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/ui/scroll-area";
import { useProjectStore } from "@/features/project/stores/project-store";
import { ATLAS_THEMES, type AtlasTheme } from "@/features/theme/themes";

/**
 * Settings → Appearance → Interface theme. A grid of complete dark palettes; the
 * active one is highlighted and clicking one applies + persists it immediately
 * (live-reskins the whole UI — background, panels, text, borders and accent).
 * Independent of the code-editor syntax theme. Mirrors
 * `code-editor-themes-settings.tsx`.
 */
export function AtlasThemesSettings() {
  const settings = useProjectStore.use.settings();
  const { updateSettings } = useProjectStore.use.actions();
  const active = settings.atlasTheme;
  const [query, setQuery] = useState("");

  const themes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ATLAS_THEMES;
    return ATLAS_THEMES.filter((t) => t.name.toLowerCase().includes(q));
  }, [query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Search — full-width flush bar, like the Skills panel. */}
      <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border-default bg-bg-primary px-3">
        <Search size={11} className="shrink-0 text-text-tertiary" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search themes…"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="shrink-0 cursor-pointer text-text-tertiary hover:text-text-primary"
          >
            <X size={11} />
          </button>
        )}
      </div>

      <ScrollArea className="flex-1 p-6">
        <div className="grid grid-cols-2 gap-4">
          {themes.map((t) => {
            const selected = t.id === active;
            return (
              <button
                key={t.id}
                onClick={() => {
                  updateSettings({ atlasTheme: t.id });
                  toast.success(`Applied “${t.name}” theme`);
                }}
                className={cn(
                  "text-left rounded-xl border p-2 transition-colors outline-none",
                  selected
                    ? "border-[var(--border-strong)] bg-bg-secondary"
                    : "border-border-default bg-bg-secondary hover:border-[var(--border-strong)]",
                )}
              >
                <ThemePreview theme={t} />
                <div className="mt-2 flex items-center gap-1.5 px-1">
                  <span className="text-[12px] font-medium text-text-primary">
                    {t.name}
                  </span>
                  {selected && (
                    <span className="text-[9px] font-medium text-text-tertiary">
                      • Active
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {themes.length === 0 && (
          <div className="py-6 text-center text-[11px] text-text-tertiary">
            No themes match “{query}”.
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

/** Mini app-window preview rendered from the theme's own palette — rail + panel
 *  + content with an accent title dot and text bars, so the tile reads as a
 *  complete theme rather than a single swatch. */
function ThemePreview({ theme }: { theme: AtlasTheme }) {
  const s = theme.spec;
  return (
    <div
      className="flex h-[210px] w-full overflow-hidden rounded-lg ring-1 ring-inset ring-white/5"
      style={{ background: s.base }}
    >
      {/* Rail */}
      <div
        className="flex w-6 flex-col items-center gap-1.5 py-2"
        style={{ background: s.panel, borderRight: `1px solid ${s.borderSubtle}` }}
      >
        <span className="h-2 w-2 rounded-full" style={{ background: s.accent }} />
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.textTertiary }} />
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.textGhost }} />
      </div>
      {/* Side panel */}
      <div
        className="flex w-[38%] flex-col gap-1.5 p-2"
        style={{ background: s.panel, borderRight: `1px solid ${s.borderSubtle}` }}
      >
        <span className="h-1.5 w-3/4 rounded-full" style={{ background: s.textSecondary }} />
        <span className="h-1.5 w-1/2 rounded-full" style={{ background: s.textTertiary }} />
        <span className="h-1.5 w-2/3 rounded-full" style={{ background: s.textTertiary }} />
        <span className="mt-auto h-3 w-full rounded" style={{ background: s.elevated }} />
      </div>
      {/* Content */}
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <span className="h-2 w-1/2 rounded-full" style={{ background: s.accent }} />
        <span className="h-1.5 w-full rounded-full" style={{ background: s.textSecondary }} />
        <span className="h-1.5 w-5/6 rounded-full" style={{ background: s.textTertiary }} />
        <span
          className="mt-auto h-4 w-full rounded"
          style={{ background: s.elevated, border: `1px solid ${s.borderDefault}` }}
        />
      </div>
    </div>
  );
}
