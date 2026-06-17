import { useGitStore } from "@/features/git/stores/git-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { GitBranch } from "lucide-react";

/**
 * Status-bar branch indicator. Shows the current branch name; clicking it opens
 * the right panel on the Source Control pane (where the full branch switcher +
 * changes live). No inline popup — the source-control panel is the one place to
 * manage branches.
 */
export function BranchPopover() {
  const branch = useGitStore.use.branch();
  const isRepo = useGitStore.use.isRepo();
  const { revealRightSection } = useLayoutStore.use.actions();

  if (!isRepo) return null;

  return (
    <button
      onClick={() => revealRightSection("changes")}
      title="Open Source Control"
      className="flex items-center gap-1.5 px-1.5 h-5 rounded text-[11px] text-[#777] hover:text-[#aaa] hover:bg-[#ffffff08] transition-colors cursor-pointer"
    >
      <GitBranch size={11} />
      <span className="font-mono">{branch}</span>
    </button>
  );
}
