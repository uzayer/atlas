import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/ui/scroll-area";
import { useProjectStore } from "@/features/project/stores/project-store";
import { APP_ACCENTS, type AppAccent } from "@/features/theme/accents";

/**
 * Settings → Appearance → App Accent. A Slack-style grid of accent "tones"; the
 * active one is highlighted and clicking one applies + persists it immediately
 * (live-reskins the UI accent — active-tab underlines, primary buttons, focus
 * rings, mention chips). Independent of the code-editor theme. Mirrors
 * `code-editor-themes-settings.tsx`.
 */
export function AppAccentSettings() {
  const settings = useProjectStore.use.settings();
  const { updateSettings } = useProjectStore.use.actions();
  const active = settings.appAccent;
  const [query, setQuery] = useState("");

  const accents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return APP_ACCENTS;
    return APP_ACCENTS.filter((a) => a.name.toLowerCase().includes(q));
  }, [query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Search — full-width flush bar, like the Skills panel. */}
      <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border-default bg-bg-primary px-3">
        <Search size={11} className="shrink-0 text-text-tertiary" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search accents…"
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
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {accents.map((a) => {
            const selected = a.id === active;
            return (
              <button
                key={a.id}
                onClick={() => {
                  updateSettings({ appAccent: a.id });
                  toast.success(`Applied “${a.name}” accent`);
                }}
                className={cn(
                  "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors outline-none",
                  selected
                    ? "border-[var(--border-strong)] bg-bg-secondary"
                    : "border-border-default bg-bg-secondary hover:border-[var(--border-strong)]",
                )}
              >
                <AccentSwatch accent={a} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-medium text-text-primary">
                      {a.name}
                    </span>
                    {selected && (
                      <span className="text-[9px] font-medium text-text-tertiary">
                        • Active
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {accents.length === 0 && (
          <div className="py-6 text-center text-[11px] text-text-tertiary">
            No accents match “{query}”.
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

/** Glossy Slack-style orb rendered from the accent's own colors. */
function AccentSwatch({ accent }: { accent: AppAccent }) {
  return (
    <span
      className="h-9 w-9 shrink-0 rounded-full ring-1 ring-inset ring-white/10"
      style={{
        background: `radial-gradient(circle at 32% 28%, ${accent.hover} 0%, ${accent.primary} 46%, rgba(0,0,0,0.55) 130%)`,
      }}
    />
  );
}
