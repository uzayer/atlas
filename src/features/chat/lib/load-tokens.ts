// Per-tab click-token table for cancelling stale in-flight session loads.
//
// Each attempt to load/resume a session into a tab bumps that tab's token;
// in-flight async work captured an older token and bails (via `isLoadStale`)
// before mutating state or hitting the agent. This prevents:
//   - rapid sidebar re-clicks stacking N concurrent `loadSession` calls, and
//   - a load that's still resolving from repainting a tab the user has since
//     reset (e.g. clicked "New chat" → `invalidateLoad`).
//
// Module-level on purpose: the identity must outlive any single component
// instance so a load started in the sidebar can be invalidated from elsewhere
// (e.g. `openNewAgentChat`).

const loadTokens: Record<string, number> = {};

/** Bump `tabId`'s load token and return the new value. The caller holds this
 *  token and checks it via {@link isLoadStale} after every await. */
export function bumpLoadToken(tabId: string): number {
  const next = (loadTokens[tabId] ?? 0) + 1;
  loadTokens[tabId] = next;
  return next;
}

/** True once `token` is no longer the active token for `tabId` — i.e. a newer
 *  {@link bumpLoadToken} or {@link invalidateLoad} has superseded this load. */
export function isLoadStale(tabId: string, token: number): boolean {
  return loadTokens[tabId] !== token;
}

/** Invalidate any in-flight load for `tabId` without starting a new one, so its
 *  continuation bails. Use when resetting a tab (e.g. New Chat) to stop a
 *  resolving hydration from overwriting the freshly cleared session. */
export function invalidateLoad(tabId: string): void {
  loadTokens[tabId] = (loadTokens[tabId] ?? 0) + 1;
}
