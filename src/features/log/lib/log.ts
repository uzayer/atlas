import { useLogStore, type LogSource } from "../stores/log-store";

interface LogEventInput {
  source: LogSource;
  kind: string;
  summary: string;
  payload?: Record<string, unknown>;
  projectPath?: string;
  projectName?: string;
}

/**
 * Push one entry into the global activity log. Cheap, fire-and-forget; the
 * store handles capping (500) and auto-fills project name from the current
 * project context. Safe to call from anywhere (renderer-only).
 */
export function logEvent(entry: LogEventInput): void {
  try {
    useLogStore.getState().actions.append(entry);
  } catch {
    // Never let the log layer throw into the host call site.
  }
}
