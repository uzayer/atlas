/**
 * Per-tab editor view-state registry (plan: memoized-knitting-panda.md, Phase 2).
 *
 * A plain module-level `Map<tabId, EditorViewState>` — NOT a Zustand store and
 * NOT in the layout store. Keyed by the globally-unique tab id, so an editor's
 * serialized state is findable regardless of which workspace owns the tab. This
 * sidesteps a subtle ordering bug: on a workspace switch the outgoing editor
 * unmounts AFTER the layout mirror has swapped to the incoming workspace, so
 * writing view-state into the mirror would land on the wrong workspace. A global
 * tab-id map has no such ambiguity.
 *
 * Session-only (never persisted). Cleaned up on tab close and workspace teardown.
 */

import type { EditorViewState } from "./editor-view-state";

const byTab = new Map<string, EditorViewState>();

export function setTabViewState(tabId: string, vs: EditorViewState): void {
  byTab.set(tabId, vs);
}

export function getTabViewState(tabId: string): EditorViewState | undefined {
  return byTab.get(tabId);
}

export function clearTabViewState(tabId: string): void {
  byTab.delete(tabId);
}

/** Drop view-state for many tabs at once (workspace teardown/eviction). */
export function clearTabViewStates(tabIds: Iterable<string>): void {
  for (const id of tabIds) byTab.delete(id);
}
