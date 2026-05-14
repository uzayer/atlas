import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "../stores/layout-store";
import { GitPanel } from "@/features/git/components/git-panel";
import { FileTree } from "@/features/explorer/components/file-tree";
import { KnowledgeList } from "@/features/knowledge/components/knowledge-list";
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

const sections = [
  { id: "files" as const, icon: Files, label: "Files" },
  { id: "knowledge" as const, icon: Brain, label: "Knowledge" },
  { id: "git-graph" as const, icon: Network, label: "Git Graph" },
];

export function LeftPanel() {
  const activeSection = useLayoutStore.use.leftPanel().activeSection;
  const { setLeftSection } = useLayoutStore.use.actions();

  return (
    <div className="h-full flex flex-col bg-bg-sidebar">
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
        {activeSection === "knowledge" && <KnowledgeList />}
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
        <div className="border-t border-border-default flex flex-col min-h-[180px] max-h-[50%]">
          <div className="flex items-center justify-between px-3 h-[28px] shrink-0">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary">
              <GitBranch size={12} />
              <span>Git</span>
            </div>
            <ChevronDown size={12} className="text-text-tertiary" />
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <GitPanel />
          </div>
        </div>
      )}
    </div>
  );
}
