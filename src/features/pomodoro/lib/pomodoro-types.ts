export type Phase = "focus" | "rest" | "idle";
export type PresetId = "25-5" | "50-10" | "90-15" | "custom";

export interface Block {
  id: string;
  /** Minutes from start of day. */
  startMin: number;
  endMin: number;
  type: "focus" | "rest";
  title: string;
  tags?: string[];
  cycle?: number;
  distractions?: number;
  /** True while this is the actively-running block; cleared on rollover. */
  current?: boolean;
  /** Elapsed minutes within `current` block (for progress fill). */
  elapsedMin?: number;
}

export interface DayAggregate {
  /** ISO yyyy-mm-dd. */
  date: string;
  today?: boolean;
  focusMin: number;
  sessions: number;
  distractions: number;
  /** 24-slot histogram of focus minutes per hour. */
  hours: number[];
  summary?: string;
}

export interface PomodoroFile {
  /** Persisted today + recent days. */
  days: DayAggregate[];
  /** Today's blocks. Older days are summarized in `days[].hours`. */
  blocks: Block[];
  /** Known tags accumulated across sessions — used as autocomplete suggestions. */
  knownTags?: string[];
}

export interface SessionConfig {
  task: string;
  tags: string[];
  presetId: PresetId;
  focusMin: number;
  breakMin: number;
  cycles: number;
}
