import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/features/project/stores/project-store";
import { EDITOR_THEMES } from "@/features/editor/themes/themes";
import { CodeEditorThemeThumbnail } from "./code-editor-theme-thumbnail";

/**
 * Settings → Appearance → Code editor theme. Grid of previews (mirrors the
 * Layouts picker); the active theme is highlighted and clicking one applies +
 * persists it immediately (live-reskins the editor + diff surfaces).
 */
export function CodeEditorThemesSettings() {
  const settings = useProjectStore.use.settings();
  const { updateSettings } = useProjectStore.use.actions();
  const active = settings.codeEditorTheme;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold text-text-primary">Code editor theme</h3>
        <p className="text-[11px] text-text-tertiary mt-0.5">
          Syntax highlighting for the code editor, the diff viewer and the source-control
          diff views. The background stays Atlas’s AMOLED black across every theme.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {EDITOR_THEMES.map((t) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              onClick={() => {
                updateSettings({ codeEditorTheme: t.id });
                toast.success(`Applied “${t.name}” editor theme`);
              }}
              className={cn(
                "text-left rounded-xl border p-3 transition-colors outline-none",
                selected
                  ? "border-[var(--border-strong)] bg-bg-secondary"
                  : "border-border-default bg-bg-secondary hover:border-[var(--border-strong)]",
              )}
            >
              <CodeEditorThemeThumbnail theme={t} />
              <div className="mt-2 flex items-center gap-1.5">
                <span className="text-[12px] font-medium text-text-primary">{t.name}</span>
                {selected && (
                  <span className="text-[9px] font-medium text-text-tertiary">• Active</span>
                )}
              </div>
              <div className="text-[10px] text-text-tertiary leading-snug">{t.description}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
