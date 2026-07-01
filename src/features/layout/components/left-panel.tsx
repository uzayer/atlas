import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "../stores/layout-store";
import { FileTree } from "@/features/explorer/components/file-tree";
import { ScrollArea } from "@/ui/scroll-area";
import { PanelSkeleton } from "@/components/panel-skeleton";
import {
  Files,
  Brain,
  Sparkles,
  BarChart3,
  ChevronDown,
  RefreshCw,
} from "lucide-react";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useUsageReport } from "@/features/monitor/stores/usage-report-store";

// The project "Usage" report (token/cost donut). Lazy — it reads the
// on-disk Claude session stats only when the user expands it.
const UsagePanel = lazy(() =>
  import("@/features/monitor/components/usage-panel").then((m) => ({
    default: m.UsagePanel,
  }))
);

// Project analysis + explore panels — lazy so their first invokes / parses
// don't run during the boot cascade.
const AnalysisPanel = lazy(() =>
  import("@/features/analysis/components/analysis-panel").then((m) => ({
    default: m.AnalysisPanel,
  }))
);
const ExplorePanel = lazy(() =>
  import("@/features/analysis/components/explore-panel").then((m) => ({
    default: m.ExplorePanel,
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

const sections = [
  { id: "files" as const, icon: Files, label: "Files" },
  { id: "knowledge" as const, icon: Brain, label: "Knowledge" },
  { id: "analysis" as const, icon: BarChart3, label: "Analysis" },
  { id: "explore" as const, icon: Sparkles, label: "Explore" },
];

export function LeftPanel() {
  const activeSection = useLayoutStore.use.leftPanel().activeSection;
  const usagePanelVisible = useLayoutStore((s) => s.leftPanel.usagePanelVisible);
  const { setLeftSection, toggleUsagePanel } = useLayoutStore.use.actions();
  const cwd = useProjectStore((s) => s.currentProject?.path ?? null);
  const loadUsage = useUsageReport((s) => s.load);
  const usageLoading = useUsageReport((s) => s.loadingCwd === cwd);

  return (
    <div className="atlas-vibrant-panel h-full flex flex-col bg-[#060706]">
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
      <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
        {activeSection === "files" && <FileTree />}
        {activeSection === "knowledge" && (
          <Suspense fallback={<PanelSkeleton label="Loading knowledge…" rows={5} />}>
            <KnowledgeList />
          </Suspense>
        )}
        {activeSection === "analysis" && (
          <Suspense fallback={<PanelSkeleton label="Loading analysis…" rows={5} />}>
            <AnalysisPanel />
          </Suspense>
        )}
        {activeSection === "explore" && (
          <Suspense fallback={<PanelSkeleton label="Loading explore…" rows={5} />}>
            <ScrollArea className="h-full p-2">
              <ExplorePanel />
            </ScrollArea>
          </Suspense>
        )}
      </div>

      {/* Project usage report — collapsible accordion at the bottom. Shown only
          under Files/Knowledge; the data panels (Analysis/Explore) take the
          full height. */}
      {(activeSection === "files" || activeSection === "knowledge") && (
        <div
          className={cn(
            "border-t border-border-default flex flex-col shrink-0",
            usagePanelVisible ? "min-h-[200px] max-h-[50%]" : "",
          )}
        >
          <div className="flex items-center justify-between px-3 h-[28px] shrink-0 hover:bg-bg-hover transition-colors">
            <button
              type="button"
              onClick={toggleUsagePanel}
              className="flex items-center gap-1.5 flex-1 min-w-0 text-left text-[11px] font-medium text-text-secondary cursor-pointer"
              title={usagePanelVisible ? "Collapse usage" : "Expand usage"}
            >
              <BarChart3 size={12} className="shrink-0" />
              <span>Usage</span>
            </button>
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (cwd) void loadUsage(cwd);
                }}
                className={cn(
                  "p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-active transition-colors",
                  usageLoading && "animate-spin",
                )}
                title="Refresh usage"
              >
                <RefreshCw size={11} />
              </button>
              <button
                type="button"
                onClick={toggleUsagePanel}
                className="p-0.5 rounded text-text-tertiary cursor-pointer"
                title={usagePanelVisible ? "Collapse usage" : "Expand usage"}
              >
                <ChevronDown
                  size={12}
                  className={cn("transition-transform", !usagePanelVisible && "-rotate-90")}
                />
              </button>
            </div>
          </div>
          {usagePanelVisible && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <Suspense fallback={<PanelSkeleton rows={3} />}>
                <UsagePanel />
              </Suspense>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
