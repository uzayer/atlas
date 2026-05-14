import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { useKnowledgeStore } from "../stores/knowledge-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { ScrollArea } from "@/ui/scroll-area";
import { FileText, BookOpen, Brain, Plus, RefreshCw } from "lucide-react";

const SOURCE_ICONS: Record<string, React.ElementType> = {
  note: FileText,
  paper: BookOpen,
  chat: Brain,
};

export function KnowledgeList() {
  const entries = useKnowledgeStore.use.entries();
  const loading = useKnowledgeStore.use.loading();
  const { loadEntries, createEntry } = useKnowledgeStore.use.actions();
  const { addTab } = useLayoutStore.use.actions();
  const currentProject = useProjectStore.use.currentProject();

  useEffect(() => {
    if (currentProject) {
      loadEntries(currentProject.path);
    }
  }, [currentProject?.path, loadEntries]);

  const handleOpen = (id: string, title: string) => {
    addTab({
      id: `knowledge-${id}`,
      type: "knowledge",
      title,
      closable: true,
      dirty: false,
      data: { entryId: id },
    });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-2 h-[28px] shrink-0">
        <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wide">
          Notes ({entries.length})
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => currentProject && loadEntries(currentProject.path)}
            className={cn(
              "p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors",
              loading && "animate-spin"
            )}
            title="Refresh"
          >
            <RefreshCw size={11} />
          </button>
          <button
            onClick={() => currentProject && createEntry(currentProject.path)}
            className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors"
            title="New note"
          >
            <Plus size={11} />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        {entries.length === 0 && !loading ? (
          <div className="px-3 py-4 text-[11px] text-text-tertiary text-center">
            No notes yet
          </div>
        ) : (
          entries.map((entry) => {
            const Icon = SOURCE_ICONS[entry.source] ?? FileText;
            return (
              <button
                key={entry.id}
                onClick={() => handleOpen(entry.id, entry.title)}
                className="w-full flex items-center gap-1.5 h-[20px] text-left text-[11px] hover:bg-bg-hover transition-colors group px-2"
              >
                <Icon size={10} className="text-text-tertiary shrink-0" />
                <span className="truncate text-text-secondary group-hover:text-text-primary">
                  {entry.title}
                </span>
                <span className="text-[8px] text-text-tertiary ml-auto shrink-0 uppercase">
                  {entry.source}
                </span>
              </button>
            );
          })
        )}
      </ScrollArea>
    </div>
  );
}
