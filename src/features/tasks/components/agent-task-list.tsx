import { cn } from "@/lib/utils";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { ScrollArea } from "@/ui/scroll-area";
import {
  ChevronRight,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { useState } from "react";
import type { AgentTask } from "@/types/agent";

const STATUS_ICON: Record<AgentTask["status"], React.ReactNode> = {
  action_needed: <AlertCircle size={10} className="text-warning" />,
  running: <Loader2 size={10} className="animate-spin text-accent" />,
  done: <CheckCircle2 size={10} className="text-success" />,
  error: <AlertCircle size={10} className="text-error" />,
};

export function AgentTaskList() {
  const sessions = useChatStore.use.sessions();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const sessionsWithTasks = Object.values(sessions).filter(
    (s) => s.tasks.length > 0
  );

  const toggleSession = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center px-2 h-[28px] shrink-0">
        <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wide">
          Agent Tasks
        </span>
      </div>

      <ScrollArea className="flex-1">
        {sessionsWithTasks.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-text-tertiary text-center">
            No agent tasks yet
          </div>
        ) : (
          sessionsWithTasks.map((session) => {
            const isExpanded = expanded[session.id] !== false; // default open
            const done = session.tasks.filter((t) => t.status === "done").length;

            return (
              <div key={session.id}>
                {/* Session header */}
                <button
                  onClick={() => toggleSession(session.id)}
                  className="w-full flex items-center gap-1 h-[20px] text-left text-[11px] hover:bg-bg-hover transition-colors px-2"
                >
                  <ChevronRight
                    size={10}
                    className={cn(
                      "text-text-tertiary shrink-0 transition-transform",
                      isExpanded && "rotate-90"
                    )}
                  />
                  <span className="truncate text-text-secondary font-medium">
                    {session.title}
                  </span>
                  <span className="text-[9px] text-text-tertiary ml-auto shrink-0">
                    {done}/{session.tasks.length}
                  </span>
                </button>

                {/* Task items */}
                {isExpanded &&
                  session.tasks.map((task) => (
                    <div
                      key={task.id}
                      className="flex items-center gap-1.5 h-[20px] text-[11px] text-text-secondary"
                      style={{ paddingLeft: 22 }}
                    >
                      <span className="shrink-0">{STATUS_ICON[task.status]}</span>
                      <span
                        className={cn(
                          "truncate",
                          task.status === "done" && "text-text-tertiary line-through"
                        )}
                      >
                        {task.title}
                      </span>
                      {(task.linesAdded > 0 || task.linesRemoved > 0) && (
                        <span className="text-[9px] font-mono ml-auto shrink-0 pr-2">
                          <span className="text-success">+{task.linesAdded}</span>
                          {" "}
                          <span className="text-error">-{task.linesRemoved}</span>
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            );
          })
        )}
      </ScrollArea>
    </div>
  );
}
