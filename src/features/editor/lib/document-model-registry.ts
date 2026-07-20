/**
 * Warm document-model registry — the Void `VoidModelService` analog (plan:
 * memoized-knitting-panda.md, Phase 2).
 *
 * Holds the live edited document text (the current, possibly-unsaved content)
 * per file path, OUTSIDE React and outside any CodeMirror view, refcounted by
 * the number of open editor tabs targeting that path. This lets an editor
 * widget be unmounted (for a background workspace) while its content stays warm
 * in memory, so:
 *   - unsaved edits are never lost when the view is destroyed,
 *   - a "save" of a path with no mounted view can still read current content,
 *   - two tabs / splits on the same path share one authoritative text.
 *
 * Intentionally a plain module-level `Map`, NOT a Zustand store — like
 * `workspace-snapshot.ts`, it must never trigger React renders. The per-tab
 * VIEW-state (scroll/selection/folds) lives separately in the layout store; this
 * registry is only the shared DOCUMENT layer.
 *
 * NOTE: this is the shared-content substrate. Restore of a specific tab's exact
 * editor state is driven by the per-tab view-state memento (editor-view-state.ts);
 * that memento is the source of truth for correctness, so a bug here can never
 * cause data loss — at worst the registry is stale and the memento wins.
 */

import { Text } from "@codemirror/state";

interface DocModel {
  path: string;
  /** Current (possibly-dirty) document text. */
  doc: Text;
  /** How many open editor tabs target this path. */
  refcount: number;
  /** Sticky flag: keep warm at refcount 0 because content diverges from disk. */
  dirty: boolean;
  /** Monotonic touch counter for LRU eviction of retained-but-viewless models. */
  touchedAt: number;
}

/** Cap on retained-at-refcount-0 (dirty) models, to bound memory. */
const RETAINED_LRU_CAP = 16;

const models = new Map<string, DocModel>();
let clock = 0;

/**
 * Increment the refcount for `path`, creating the model from `seedDoc()` on
 * first acquire. Returns the model. Call from the editor mount effect.
 */
export function acquireModel(path: string, seedDoc: () => Text): DocModel {
  let m = models.get(path);
  if (!m) {
    m = { path, doc: seedDoc(), refcount: 0, dirty: false, touchedAt: ++clock };
    models.set(path, m);
  }
  m.refcount++;
  m.touchedAt = ++clock;
  return m;
}

/** Update the warm text (e.g. from a view's current doc on unmount/blur). */
export function writeBackModel(path: string, doc: Text, dirty: boolean): void {
  const m = models.get(path);
  if (!m) return;
  m.doc = doc;
  m.dirty = dirty;
  m.touchedAt = ++clock;
}

/**
 * Decrement the refcount for `path`. At refcount 0 the model is dropped UNLESS
 * it's dirty (unsaved content diverges from disk) — dirty models are retained so
 * reopening the tab restores edits, subject to an LRU cap. Call from the editor
 * unmount effect AFTER writing back.
 */
export function releaseModel(path: string): void {
  const m = models.get(path);
  if (!m) return;
  m.refcount = Math.max(0, m.refcount - 1);
  if (m.refcount === 0 && !m.dirty) {
    models.delete(path);
  }
  evictRetained();
}

/** Hard-drop a model regardless of refcount/dirty (explicit buffer close). */
export function dropModel(path: string): void {
  models.delete(path);
}

export function getModel(path: string): DocModel | undefined {
  return models.get(path);
}

/** Current warm text for `path`, or undefined if no model is held. */
export function getModelText(path: string): Text | undefined {
  return models.get(path)?.doc;
}

/** Evict the least-recently-touched RETAINED (refcount 0) models over the cap. */
function evictRetained(): void {
  const retained = [...models.values()].filter((m) => m.refcount === 0);
  if (retained.length <= RETAINED_LRU_CAP) return;
  retained
    .sort((a, b) => a.touchedAt - b.touchedAt)
    .slice(0, retained.length - RETAINED_LRU_CAP)
    .forEach((m) => models.delete(m.path));
}

/** Test/diagnostic helper. */
export function __modelCount(): number {
  return models.size;
}
