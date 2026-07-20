/**
 * Workspace-switch instrumentation (plan: memoized-knitting-panda.md — the
 * Phase-0 measurement harness that gates the profiling-dependent Phase 3
 * optimizations). Off unless `atlas.perf.instrument` is set:
 *   localStorage.setItem("atlas.perf.instrument", "1")
 *
 * Logs, per switch, the time from switch-request to the first post-swap paint
 * (the perceived latency) plus the number of live CodeMirror editors in the DOM
 * — the headline metric for the buffer/view-split work (it should drop to the
 * active workspace's editors once `unmountBackgroundEditors` is on). Also emits
 * a `performance.measure` so the switch shows up on the devtools Performance
 * timeline.
 */

import { instrument } from "./perf-flags";

/** Live `.cm-editor` (CodeMirror) nodes in the document, or -1 if unavailable. */
export function liveEditorCount(): number {
  try {
    return document.querySelectorAll(".cm-editor").length;
  } catch {
    return -1;
  }
}

/** Timestamp to pass to {@link logSwitchPerf}. Cheap even when instrument is off. */
export function switchClockStart(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

/**
 * Log a completed switch. Call from `deferAfterPaint` so `startMs` → now spans
 * request → first paint. No-op unless the instrument flag is on.
 */
export function logSwitchPerf(label: string, startMs: number): void {
  if (!instrument()) return;
  const dur = (typeof performance !== "undefined" ? performance.now() : 0) - startMs;
  // eslint-disable-next-line no-console
  console.info(
    `[atlas.switch] ${label} — ${dur.toFixed(1)}ms · ${liveEditorCount()} live editors`,
  );
  try {
    performance.measure(`atlas.switch:${label}`, { start: startMs, duration: dur });
  } catch {
    // The options form of performance.measure may be unsupported — the console
    // line above is the fallback signal.
  }
}
