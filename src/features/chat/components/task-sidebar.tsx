import { cn } from "@/lib/utils";
import type { AgentTask } from "@/types/agent";
import { Plus, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

interface TaskSidebarProps {
  tasks: AgentTask[];
}

export function TaskSidebar({ tasks }: TaskSidebarProps) {
  return (
    <div className="w-[200px] shrink-0 border-r border-[var(--border-default)] bg-[var(--bg-primary)] flex flex-col">
      <div className="flex items-center justify-between px-3 h-[36px] border-b border-[var(--border-subtle)]">
        <span className="text-[11px] font-semibold text-[var(--text-secondary)]">
          Tasks
        </span>
        <button className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors">
          <Plus size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {tasks.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-[var(--text-tertiary)]">
            No tasks yet
          </div>
        )}

        {tasks.map((task) => (
          <TaskItem key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}

function TaskItem({ task }: { task: AgentTask }) {
  const statusIcon = {
    action_needed: (
      <AlertCircle size={12} className="text-[var(--status-warning)]" />
    ),
    running: (
      <Loader2 size={12} className="animate-spin text-[var(--accent-primary)]" />
    ),
    done: <CheckCircle2 size={12} className="text-[var(--status-success)]" />,
    error: <AlertCircle size={12} className="text-[var(--status-error)]" />,
  }[task.status];

  const statusLabel = {
    action_needed: "Action Needed",
    running: "Running",
    done: "Done",
    error: "Error",
  }[task.status];

  return (
    <button
      className={cn(
        "w-full text-left px-3 py-2 hover:bg-[var(--bg-hover)] transition-colors",
        "border-l-2 border-transparent",
        task.status === "running" && "border-l-[var(--accent-primary)]",
        task.status === "action_needed" && "border-l-[var(--status-warning)]"
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">{statusIcon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-[var(--text-primary)] truncate">
            {task.title}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-[var(--text-tertiary)]">
              {statusLabel}
            </span>
            {(task.linesAdded > 0 || task.linesRemoved > 0) && (
              <span className="text-[10px] font-mono">
                <span className="text-[var(--diff-added-text)]">
                  +{task.linesAdded}
                </span>{" "}
                <span className="text-[var(--diff-removed-text)]">
                  -{task.linesRemoved}
                </span>
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}
