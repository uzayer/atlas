import { cn } from "@/lib/utils";
import { useLayoutStore } from "../stores/layout-store";
import { ExplorePanel } from "@/features/analysis/components/explore-panel";
import { AnalysisPanel } from "@/features/analysis/components/analysis-panel";
import { ChangesPanel } from "@/features/git/components/changes-panel";
import { GithubPanel } from "@/features/github/components/github-panel";
import { ScrollArea } from "@/ui/scroll-area";
import { BarChart3, Sparkles, GitCompare, Github } from "lucide-react";

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
        {activeSection === "changes" && <ChangesPanel />}
        {activeSection === "explore" && (
          <ScrollArea className="h-full p-2">
            <ExplorePanel />
          </ScrollArea>
        )}
        {activeSection === "analysis" && <AnalysisPanel />}
        {activeSection === "github" && <GithubPanel />}
      </div>
    </div>
  );
}
