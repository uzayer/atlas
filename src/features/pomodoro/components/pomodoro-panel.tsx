import { useEffect } from "react";
import { useProjectStore } from "@/features/project/stores/project-store";
import { usePomodoroStore, attachPersistence } from "../stores/pomodoro-store";
import { nowMinOfDay } from "../lib/format";
import { DayRail } from "./day-rail";
import { DayTimeline } from "./day-timeline";
import { ActiveTimer } from "./active-timer";
import { NewSessionSheet } from "./new-session-sheet";

export function PomodoroPanel() {
  const currentProject = useProjectStore.use.currentProject();
  const days = usePomodoroStore.use.days();
  const activeDayIdx = usePomodoroStore.use.activeDayIdx();
  const blocks = usePomodoroStore.use.blocks();
  const isRunning = usePomodoroStore.use.isRunning();
  const { tick, hydrate, openSheet } = usePomodoroStore.use.actions();

  // Hydrate once per project + attach persistence.
  useEffect(() => {
    if (!currentProject?.path) return;
    hydrate(currentProject.path);
    const unsub = attachPersistence(currentProject.path);
    return unsub;
  }, [currentProject?.path, hydrate]);

  // Tick driver — single interval at the panel root.
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => tick(), 1000);
    return () => clearInterval(id);
  }, [isRunning, tick]);

  const day = days[activeDayIdx] ?? days[0];

  return (
    <div
      className="h-full min-h-0 grid"
      style={{ gridTemplateColumns: "280px minmax(0, 1fr) 320px" }}
    >
      <DayRail />
      <div className="overflow-auto hide-scrollbar min-h-0 min-w-0">
        {day && (
          <DayTimeline
            day={day}
            blocks={day.today ? blocks : []}
            nowMin={day.today ? nowMinOfDay() : -1}
            onNewSession={openSheet}
          />
        )}
      </div>
      <ActiveTimer />
      <NewSessionSheet />
    </div>
  );
}
