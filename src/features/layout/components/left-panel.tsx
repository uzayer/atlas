import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "../stores/layout-store";
import { FileTree } from "@/features/explorer/components/file-tree";
import { PanelSkeleton } from "@/components/panel-skeleton";
import {
  Files,
  Brain,
  GitBranch,
  Network,
  ChevronDown,
} from "lucide-react";

// xyflow + the layout pass are heavy; load only when the user opens the tab.
const GitGraphPanel = lazy(() =>
  import("@/features/git/components/git-graph-panel").then((m) => ({
    default: m.GitGraphPanel,
  }))
);
// `KnowledgeList` only mounts when the user clicks the Knowledge section
// in the sidebar — keeping it lazy spares its store imports + render cost
// at boot.
const KnowledgeList = lazy(() =>
  import("@/features/knowledge/components/knowledge-list").then((m) => ({
    default: m.KnowledgeList,
  }))
);
// `GitPanel` (bottom of the Files / Knowledge views) fires `git_status`
// + `git_log` Tauri commands on mount. On a large repo or one with many
// changes these can take a noticeable beat to come back — keep it lazy
// so the file tree renders first.
const GitPanel = lazy(() =>
  import("@/features/git/components/git-panel").then((m) => ({
    default: m.GitPanel,
  }))
);

const sections = [
  { id: "files" as const, icon: Files, label: "Files" },
  { id: "knowledge" as const, icon: Brain, label: "Knowledge" },
  { id: "git-graph" as const, icon: Network, label: "Git Graph" },
];

export function LeftPanel() {
  const activeSection = useLayoutStore.use.leftPanel().activeSection;
  const gitPanelVisible = useLayoutStore(
    (s) => s.leftPanel.gitPanelVisible,
  );
  const { setLeftSection, toggleGitPanel } = useLayoutStore.use.actions();

  return (
    <div className="atlas-vibrant-panel h-full flex flex-col bg-[color-mix(in_srgb,var(--bg-sidebar)_90%,transparent)]">
      {/* Icon-only tabs (horizontal, like VS Code) */}
      <div className="flex items-center border-b border-border-default px-2 h-[29px] shrink-0 gap-1.5">
        {sections.map((s) => (
          <button
            key={s.id}
            onClick={() => setLeftSection(s.id)}
            className={cn(
              "flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer",
              activeSection === s.id
                ? "text-text-primary bg-bg-selected"
                : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover"
            )}
            title={s.label}
          >
            <s.icon size={15} strokeWidth={1.5} />
          </button>
        ))}
      </div>

      {/* Section content */}
      <div
        className={cn(
          "flex-1 min-h-0",
          // Git graph panel takes over its own scrolling (via ReactFlow); other panels scroll vertically.
          activeSection === "git-graph" ? "overflow-hidden" : "overflow-auto hide-scrollbar"
        )}
      >
        {activeSection === "files" && <FileTree />}
        {activeSection === "knowledge" && (
          <Suspense fallback={<PanelSkeleton label="Loading knowledge…" rows={5} />}>
            <KnowledgeList />
          </Suspense>
        )}
        {activeSection === "git-graph" && (
          <Suspense
            fallback={
              <div className="h-full flex items-center justify-center text-[11px] text-text-tertiary">
                Loading graph…
              </div>
            }
          >
            <GitGraphPanel />
          </Suspense>
        )}
      </div>

      {/* Git panel (bottom) — hidden when the dedicated Git Graph tab is active */}
      {activeSection !== "git-graph" && (
        <div
          className={cn(
            "border-t border-border-default flex flex-col shrink-0",
            // When collapsed the section is just the header strip; when
            // visible it gets a reasonable min/max so it doesn't crowd
            // the file tree but stays usable.
            gitPanelVisible ? "min-h-[180px] max-h-[50%]" : "",
          )}
        >
          <button
            type="button"
            onClick={toggleGitPanel}
            className="flex items-center justify-between px-3 h-[28px] shrink-0 cursor-pointer hover:bg-bg-hover transition-colors"
            title={gitPanelVisible ? "Collapse Git" : "Expand Git"}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary">
              <GitBranch size={12} />
              <span>Git</span>
            </div>
            <ChevronDown
              size={12}
              className={cn(
                "text-text-tertiary transition-transform",
                !gitPanelVisible && "-rotate-90",
              )}
            />
          </button>
          {gitPanelVisible && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <Suspense fallback={<PanelSkeleton rows={3} />}>
                <GitPanel />
              </Suspense>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
