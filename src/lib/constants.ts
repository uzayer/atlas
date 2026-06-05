export const TAB_TYPES = [
  "chat",
  "canvas",
  "browser",
  "tasks",
  "editor",
  "research",
  "knowledge",
  "knowledge-graph",
  "terminal",
  "diff",
  "settings",
  "log",
  "media",
  "pdf",
  "unsupported",
  "pomodoro",
] as const;

export type TabType = (typeof TAB_TYPES)[number];
