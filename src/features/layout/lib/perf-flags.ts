/**
 * Dark-shipped performance flags for the workspace-switching rework
 * (plan: memoized-knitting-panda.md). All default OFF so the new code paths
 * ship inert and can be enabled progressively per the rollout in that plan.
 *
 * Toggle at runtime from devtools, then reload:
 *   localStorage.setItem("atlas.perf.lazyFirstMount", "1")
 *   localStorage.setItem("atlas.perf.unmountBackgroundEditors", "1")
 *
 * Read live (localStorage access is cheap) so a toggle + component remount
 * takes effect without a rebuild. These are intentionally NOT in AppSettings —
 * they're experimental engineering flags, not user-facing preferences.
 */

const PREFIX = "atlas.perf.";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(PREFIX + key) === "1";
  } catch {
    // localStorage can throw in locked-down/embedded contexts — treat as off.
    return false;
  }
}

/** Phase 1: only mount a persistent tab's body after its first activation. */
export const lazyFirstMount = (): boolean => readFlag("lazyFirstMount");

/** Phase 2c: unmount editor tabs of BACKGROUND workspaces (warm model +
 *  view-state make remount lossless). Requires the warm-model path. */
export const unmountBackgroundEditors = (): boolean =>
  readFlag("unmountBackgroundEditors");

/** Dev instrumentation: log workspace-switch latency + live-editor count per
 *  switch (see switch-perf.ts). Off by default; enable to profile the flags. */
export const instrument = (): boolean => readFlag("instrument");
