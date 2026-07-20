/**
 * Editor view-state serialization — the VS Code `ICodeEditorViewState` analog
 * for our CodeMirror editors (plan: memoized-knitting-panda.md, Phase 2).
 *
 * Captures a mounted `EditorView`'s document + selection + undo history + folds
 * + scroll anchor as a PLAIN, structured-cloneable object so an editor can be
 * unmounted (freeing the widget) and later remounted with its exact state
 * restored — instead of keeping every editor's widget alive just to preserve
 * scroll/cursor. Stored per-tab in the layout store (`viewStateByTab`), so it
 * travels with `viewsByWs` across workspace switches.
 *
 * Scroll is stored as a 1-based LINE anchor (not raw pixels) so it survives
 * width/content changes; restore scrolls that line to the top.
 */

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { historyField } from "@codemirror/commands";
import { foldedRanges, foldEffect } from "@codemirror/language";

export interface EditorViewState {
  version: 1;
  /** `EditorState.toJSON({ history: historyField })` — doc + selection + undo. */
  state: unknown;
  /** Folded ranges, re-applied via `foldEffect` on restore (the fold StateField
   *  isn't reconstructable from JSON, so we track ranges explicitly). */
  folds: { from: number; to: number }[];
  /** 1-based line number at the top of the viewport when captured. */
  topLine: number;
}

/** The JSON codec config that pairs doc/selection with the undo-history field. */
const HISTORY_FIELDS = { history: historyField } as const;

/** Serialize a live view into a plain object. Call this BEFORE `view.destroy()`. */
export function captureViewState(view: EditorView): EditorViewState {
  const { state } = view;

  const folds: { from: number; to: number }[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    folds.push({ from, to });
  });

  let topLine = 1;
  try {
    const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
    topLine = state.doc.lineAt(block.from).number;
  } catch {
    // Measuring can throw if the view isn't laid out yet — default to top.
  }

  return {
    version: 1,
    state: state.toJSON(HISTORY_FIELDS),
    folds,
    topLine,
  };
}

/**
 * Rebuild an `EditorState` from a captured view-state, pairing it with the
 * caller's live `extensions` (theme/lang/keymaps/etc). Returns null if the blob
 * is missing/incompatible so the caller can fall back to a fresh `doc` seed.
 */
export function restoreEditorState(
  vs: EditorViewState | undefined,
  extensions: Extension,
): EditorState | null {
  if (!vs || vs.version !== 1 || vs.state == null) return null;
  try {
    return EditorState.fromJSON(
      vs.state as Parameters<typeof EditorState.fromJSON>[0],
      { extensions },
      HISTORY_FIELDS,
    );
  } catch {
    return null;
  }
}

/**
 * Re-apply folds + scroll AFTER the view is mounted and laid out. Folds must be
 * applied before scrolling (they change line heights). Call inside a
 * `requestAnimationFrame` following view creation.
 */
export function applyFoldsAndScroll(view: EditorView, vs: EditorViewState): void {
  const len = view.state.doc.length;
  const effects = vs.folds
    .filter((f) => f.from >= 0 && f.to <= len && f.from < f.to)
    .map((f) => foldEffect.of(f));
  if (effects.length) view.dispatch({ effects });

  const lineCount = view.state.doc.lines;
  const line = Math.min(Math.max(vs.topLine, 1), lineCount);
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.doc.line(line).from, { y: "start" }),
  });
}
