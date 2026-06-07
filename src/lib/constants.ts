export const TAB_TYPES = [
  "chat",
  "model-chat",
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
  "svg",
  "pdf",
  "unsupported",
  "pomodoro",
] as const;

export type TabType = (typeof TAB_TYPES)[number];
