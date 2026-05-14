import { cn } from "@/lib/utils";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { ScrollArea } from "@/ui/scroll-area";
import {
  CheckCircle2,
  Circle,
  Clock,
  Loader2,
  AlertCircle,
} from "lucide-react";
import type { AgentTask } from "@/types/agent";

const STATUS_ICON: Record<AgentTask["status"], React.ReactNode> = {
  action_needed: <AlertCircle size={12} className="text-warning" />,
  running: <Loader2 size={12} className="animate-spin text-accent" />,
  done: <CheckCircle2 size={12} className="text-success" />,
  error: <AlertCircle size={12} className="text-error" />,
};

const STATUS_LABEL: Record<AgentTask["status"], string> = {
  action_needed: "Action Needed",
  running: "Running",
  done: "Done",
  error: "Error",
};

const COLUMNS = [
  { id: "running" as const, label: "Running", icon: Loader2 },
  { id: "action_needed" as const, label: "Needs Action", icon: Clock },
  { id: "done" as const, label: "Done", icon: CheckCircle2 },
  { id: "error" as const, label: "Error", icon: AlertCircle },
] as const;

export function TaskBoard() {
  const sessions = useChatStore.use.sessions();

  // Collect all tasks from all agent sessions
  const allTasks = Object.values(sessions).flatMap((s) => s.tasks);
  const hasAnyTasks = allTasks.length > 0;

  if (!hasAnyTasks) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center px-4 h-[32px] shrink-0 border-b border-border-subtle bg-bg-primary">
          <span className="text-[11px] font-semibold text-text-secondary">Agent Tasks</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-2 px-6">
            <Circle size={24} className="text-text-tertiary mx-auto opacity-40" />
            <p className="text-[11px] text-text-tertiary">
              No agent tasks are running or have ran on this project.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center px-4 h-[32px] shrink-0 border-b border-border-subtle bg-bg-primary">
        <span className="text-[11px] font-semibold text-text-secondary">Agent Tasks</span>
        <span className="text-[10px] text-text-tertiary ml-2">{allTasks.length} tasks</span>
      </div>

      <div className="flex-1 flex gap-3 p-3 overflow-x-auto">
        {COLUMNS.map((col) => {
          const Icon = col.icon;
          const columnTasks = allTasks.filter((t) => t.status === col.id);
          if (columnTasks.length === 0) return null;

          return (
            <div key={col.id} className="flex flex-col w-[240px] shrink-0">
              <div className="flex items-center gap-1.5 px-2 h-[28px] mb-2">
                <Icon
                  size={12}
                  className={cn(
                    col.id === "done" ? "text-success" : "text-text-tertiary",
                    col.id === "running" && "animate-spin text-accent"
                  )}
                />
                <span className="text-[11px] font-semibold text-text-secondary">
                  {col.label}
                </span>
                <span className="text-[10px] text-text-tertiary">{columnTasks.length}</span>
              </div>

              <ScrollArea className="flex-1 space-y-1.5 px-0.5">
                {columnTasks.map((task) => (
                  <div
                    key={task.id}
                    className="rounded-lg border border-border-default bg-bg-secondary p-2.5 transition-colors cursor-default"
                  >
                    <div className="flex items-start gap-1.5">
                      <span className="mt-0.5 shrink-0">{STATUS_ICON[task.status]}</span>
                      <div className="min-w-0 flex-1">
                        <span className="text-[11px] text-text-primary leading-relaxed">
                          {task.title}
                        </span>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-text-tertiary">
                            {STATUS_LABEL[task.status]}
                          </span>
                          {(task.linesAdded > 0 || task.linesRemoved > 0) && (
                            <span className="text-[10px] font-mono">
                              <span className="text-success">+{task.linesAdded}</span>{" "}
                              <span className="text-error">-{task.linesRemoved}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </ScrollArea>
            </div>
          );
        })}
      </div>
    </div>
  );
}
