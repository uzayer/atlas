import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "../stores/layout-store";
import { ScrollArea } from "@/ui/scroll-area";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { BarChart3, Sparkles, GitCompare, Github } from "lucide-react";

// All four right-panel sub-panels are lazy so they don't run their first
// invokes / vendor parses during the boot-cascade window. The user lands
// on a project, sees the tab bar + skeleton instantly, and the data slides
// in as each chunk + IPC resolves. `ChangesPanel` in particular pulls in
// `@tanstack/react-virtual` and parses git diff text that can be large on
// active branches — keeping it lazy stops the right panel from blocking
// the post-`hydrate` render.
const ChangesPanel = lazy(() =>
  import("@/features/git/components/changes-panel").then((m) => ({
    default: m.ChangesPanel,
  }))
);
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
const GithubPanel = lazy(() =>
  import("@/features/github/components/github-panel").then((m) => ({
    default: m.GithubPanel,
  }))
);

const sections = [
  { id: "changes" as const, label: "Changes", icon: GitCompare },
  { id: "analysis" as const, label: "Analysis", icon: BarChart3 },
  { id: "explore" as const, label: "Explore", icon: Sparkles },
  { id: "github" as const, label: "GitHub", icon: Github },
];

export function RightPanel() {
  const activeSection = useLayoutStore.use.rightPanel().activeSection;
  const { setRightSection } = useLayoutStore.use.actions();

  return (
    <div className="h-full flex flex-col bg-bg-sidebar">
      <div className="flex items-center border-b border-border-default px-1 h-[29px] shrink-0 gap-0.5">
        {sections.map((s) => (
          <button
            key={s.id}
            onClick={() => setRightSection(s.id)}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer",
              activeSection === s.id
                ? "text-text-primary bg-bg-selected"
                : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover"
            )}
          >
            <s.icon size={12} />
            {s.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
        <Suspense
          fallback={
            <PanelSkeleton
              label={
                activeSection === "changes"
                  ? "Loading changes…"
                  : activeSection === "analysis"
                    ? "Loading analysis…"
                    : activeSection === "explore"
                      ? "Loading explore…"
                      : "Loading…"
              }
            />
          }
        >
          {activeSection === "changes" && <ChangesPanel />}
          {activeSection === "explore" && (
            <ScrollArea className="h-full p-2">
              <ExplorePanel />
            </ScrollArea>
          )}
          {activeSection === "analysis" && <AnalysisPanel />}
          {activeSection === "github" && <GithubPanel />}
        </Suspense>
      </div>
    </div>
  );
}
