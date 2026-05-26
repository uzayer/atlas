export const APP_NAME = "Atlas";
export const APP_VERSION = "0.1.0";

export const PANEL_DEFAULTS = {
  left: { width: 240, minWidth: 180, maxWidth: 400 },
  right: { width: 280, minWidth: 200, maxWidth: 450 },
  bottom: { height: 32 },
} as const;

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
  "unsupported",
] as const;

export type TabType = (typeof TAB_TYPES)[number];
