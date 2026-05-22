// CodeMirror 6 extension that turns substrings of the document into atomic,
// styled chip widgets backed by a `MentionData` record.
//
// Model
//   - The document text always contains the **short-form** string for each
//     mention (e.g. `@file:src/foo.rs`). The agent reads this directly when
//     we ship `doc.toString()`.
//   - A `StateField<MentionRange[]>` tracks `{ mention, from, to }` triples
//     alongside the doc. On every transaction the ranges are mapped through
//     `tr.changes` so edits stay in sync; ranges that collapse to zero
//     length are dropped (= the user deleted the chip).
//   - `EditorView.decorations.from(field, …)` paints a `Decoration.replace`
//     with `widget: ChipWidget` over each range. `inclusive: false` keeps
//     the caret from creeping inside the chip on cursor motion.
//   - `EditorView.atomicRanges.of(…)` covers the same spans so single
//     Backspace / arrow-keypress treats the whole chip as one character.
//
// Inserts and removes are dispatched via `StateEffect`s rather than direct
// state mutation so other extensions (e.g. an `update` listener that wants
// to surface mention changes to React) can observe them.

import {
  Range,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import type { MentionData, MentionKind } from "./mentions";
import { toShortForm } from "./mentions";

// ── Trigger detection ────────────────────────────────────────────────────────

export interface MentionTrigger {
  /** Document position of the `@` (inclusive). */
  from: number;
  /** Caret position (exclusive). Slice [from+1, to] is the typed query. */
  to: number;
  /** What the user typed after the `@`. Empty if caret is right after `@`. */
  query: string;
  /** Viewport coords of the caret — anchor for the floating popover. */
  anchor: { x: number; y: number };
}

/** Build a ViewPlugin that watches doc + selection state and reports the
 *  current `@`-trigger range, if any. `onChange(null)` fires when the
 *  trigger closes (caret moved away, `@` deleted, query contains
 *  whitespace, …).
 *
 *  IMPORTANT: layout reads (`coordsAtPos`) are forbidden during a CM
 *  update. We compute positions synchronously inside `update()` but defer
 *  the coords measurement (and the React callback) to a microtask so it
 *  runs after the view finishes committing. */
export function mentionTriggerPlugin(
  onChange: (trigger: MentionTrigger | null) => void
): ViewPlugin<{ last: MentionTrigger | null; pending: number }> {
  return ViewPlugin.define((view) => {
    const state = {
      last: null as MentionTrigger | null,
      pending: 0,
    };
    schedule(view, state, onChange);
    return {
      update(u: ViewUpdate) {
        if (!u.docChanged && !u.selectionSet && !u.viewportChanged) return;
        schedule(u.view, state, onChange);
      },
    };
  });
}

function schedule(
  view: EditorView,
  state: { last: MentionTrigger | null; pending: number },
  onChange: (t: MentionTrigger | null) => void
): void {
  const ticket = ++state.pending;
  queueMicrotask(() => {
    // Drop the stale schedule if another update has fired since.
    if (ticket !== state.pending) return;
    recompute(view, state, onChange);
  });
}

function recompute(
  view: EditorView,
  state: { last: MentionTrigger | null; pending: number },
  onChange: (t: MentionTrigger | null) => void
): void {
  // The view may have been destroyed between the queueMicrotask schedule
  // and its callback firing (e.g. component unmount inside the same tick).
  if (!view.dom.isConnected) return;
  const trig = detectTrigger(view);
  if (sameTrigger(state.last, trig)) return;
  state.last = trig;
  onChange(trig);
}

function sameTrigger(a: MentionTrigger | null, b: MentionTrigger | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.from === b.from &&
    a.to === b.to &&
    a.query === b.query &&
    a.anchor.x === b.anchor.x &&
    a.anchor.y === b.anchor.y
  );
}

function detectTrigger(view: EditorView): MentionTrigger | null {
  const sel = view.state.selection.main;
  if (!sel.empty) return null;
  const caret = sel.head;
  const line = view.state.doc.lineAt(caret);
  // Scan backward from the caret for the most recent `@` on this line. Bail
  // if we hit whitespace before finding one, or if the `@` is preceded by a
  // non-space character (so `email@domain` doesn't open the picker).
  const lineBefore = view.state.doc.sliceString(line.from, caret);
  for (let i = lineBefore.length - 1; i >= 0; i--) {
    const ch = lineBefore[i];
    if (ch === "@") {
      const prev = i > 0 ? lineBefore[i - 1] : "";
      if (prev && !/\s/.test(prev) && prev !== "(" && prev !== "[") {
        return null;
      }
      const from = line.from + i;
      const query = lineBefore.slice(i + 1);
      if (query.includes("\n")) return null;
      // Ignore @ that's already inside a mention range (we don't want to
      // re-open the picker on a fresh chip).
      const ranges = view.state.field(mentionField, false) ?? [];
      for (const r of ranges) {
        if (from >= r.from && from < r.to) return null;
      }
      const coords = view.coordsAtPos(from);
      if (!coords) return null;
      return {
        from,
        to: caret,
        query,
        anchor: { x: coords.left, y: coords.top },
      };
    }
    if (/\s/.test(ch)) {
      return null;
    }
  }
  return null;
}

// ── Keyboard intercept hook ──────────────────────────────────────────────────

/** A key passes through this when the picker is open. The interceptor is a
 *  mutable ref the parent sets; CodeMirror's keymap looks it up live so we
 *  don't have to reconfigure the view every time the picker opens. */
export type MentionKey = "Up" | "Down" | "Enter" | "Escape" | "Backspace";
export type MentionKeyInterceptor = (key: MentionKey) => boolean;

export const mentionKeymap = (
  getInterceptor: () => MentionKeyInterceptor | null
) => {
  const tryIntercept =
    (key: MentionKey) =>
    () => {
      const fn = getInterceptor();
      return fn ? fn(key) : false;
    };
  return [
    { key: "ArrowDown", run: tryIntercept("Down") },
    { key: "ArrowUp", run: tryIntercept("Up") },
    { key: "Enter", run: tryIntercept("Enter") },
    { key: "Escape", run: tryIntercept("Escape") },
    // Backspace is intercepted so the picker can "go back" one level
    // (e.g. close a past-session sublist) instead of deleting a character.
    // The interceptor returns false to let CM's default delete handler run
    // when there's nothing to back-navigate to.
    { key: "Backspace", run: tryIntercept("Backspace") },
  ];
};

// ── State ────────────────────────────────────────────────────────────────────

export interface MentionRange {
  mention: MentionData;
  from: number;
  to: number;
}

/** Insert a mention. The provided `from`/`to` is the slice of doc the
 *  shortform string already occupies — the caller is expected to have
 *  produced that text in the same transaction (see `insertMention`). */
export const addMentionEffect = StateEffect.define<MentionRange>();

/** Drop a mention by id without changing the doc. The doc text remains
 *  but loses chip rendering and atomic behavior. (We don't currently use
 *  this — kept for parity with `addMentionEffect`.) */
export const removeMentionEffect = StateEffect.define<{ id: string }>();

export const mentionField = StateField.define<MentionRange[]>({
  create: () => [],
  update(value, tr) {
    // Map existing ranges through the doc changes first.
    let next: MentionRange[] = [];
    for (const r of value) {
      const from = tr.changes.mapPos(r.from, 1);
      const to = tr.changes.mapPos(r.to, -1);
      if (to <= from) continue; // range collapsed → mention deleted
      next.push({ ...r, from, to });
    }
    for (const eff of tr.effects) {
      if (eff.is(addMentionEffect)) {
        next.push(eff.value);
      } else if (eff.is(removeMentionEffect)) {
        next = next.filter((r) => r.mention.id !== eff.value.id);
      }
    }
    // Keep ranges sorted by `from` so RangeSet.of() doesn't need `sort`.
    next.sort((a, b) => a.from - b.from);
    return next;
  },
});

// ── Widget ───────────────────────────────────────────────────────────────────

class ChipWidget extends WidgetType {
  constructor(private readonly mention: MentionData) {
    super();
  }

  eq(other: ChipWidget): boolean {
    return (
      other.mention.kind === this.mention.kind &&
      other.mention.id === this.mention.id &&
      other.mention.displayName === this.mention.displayName
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "atlas-mention-chip";
    el.setAttribute("data-mention-kind", this.mention.kind);
    el.setAttribute("data-mention-id", this.mention.id);
    el.title = chipTitle(this.mention);

    const icon = document.createElement("span");
    icon.className = "atlas-mention-chip__icon";
    icon.innerHTML = kindGlyph(this.mention.kind);
    el.appendChild(icon);

    const label = document.createElement("span");
    label.className = "atlas-mention-chip__label";
    label.textContent = this.mention.displayName;
    el.appendChild(label);

    return el;
  }

  ignoreEvent(): boolean {
    // Let clicks fall through so the user can click the chip to position
    // the caret on either side.
    return false;
  }
}

// Lucide icon SVG markup, kept inline so CM widgets (vanilla DOM, no React)
// can render the same icon set as the React mention picker. Paths copied
// from lucide-react@0.468 — keep in sync with `CategoryIcon` in
// mention-picker.tsx. Stroke uses `currentColor` so the per-kind colors
// declared in globals.css cascade through.
function lucideSvg(body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" ` +
    `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  );
}

const ICON_FILE = lucideSvg(
  `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>` +
    `<path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/>` +
    `<path d="M16 13H8"/><path d="M16 17H8"/>`,
);
const ICON_FOLDER = lucideSvg(
  `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
);
const ICON_HASH = lucideSvg(
  `<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/>` +
    `<line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>`,
);
const ICON_BOOK_OPEN = lucideSvg(
  `<path d="M12 7v14"/>` +
    `<path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>`,
);
const ICON_FOLDER_GIT = lucideSvg(
  `<path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5"/>` +
    `<circle cx="13" cy="12" r="2"/>` +
    `<path d="M18 19c-2.8 0-5-2.2-5-5v8"/>` +
    `<circle cx="20" cy="19" r="2"/>`,
);
const ICON_NEWSPAPER = lucideSvg(
  `<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/>` +
    `<path d="M18 14h-8"/><path d="M15 18h-5"/>` +
    `<path d="M10 6h8v4h-8V6Z"/>`,
);
const ICON_GIT_BRANCH = lucideSvg(
  `<line x1="6" x2="6" y1="3" y2="15"/>` +
    `<circle cx="18" cy="6" r="3"/>` +
    `<circle cx="6" cy="18" r="3"/>` +
    `<path d="M18 9a9 9 0 0 1-9 9"/>`,
);
const ICON_MESSAGE_SQUARE = lucideSvg(
  `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,
);

function kindGlyph(kind: MentionKind): string {
  switch (kind) {
    case "file":         return ICON_FILE;
    case "folder":       return ICON_FOLDER;
    case "symbol":       return ICON_HASH;
    case "knowledge":    return ICON_BOOK_OPEN;
    case "repo":         return ICON_FOLDER_GIT;
    case "paper":        return ICON_NEWSPAPER;
    case "branch":       return ICON_GIT_BRANCH;
    case "past_message": return ICON_MESSAGE_SQUARE;
  }
}

function chipTitle(m: MentionData): string {
  switch (m.kind) {
    case "file":         return m.absPath;
    case "folder":       return m.absPath;
    case "symbol":       return `${m.symbolKind} · ${m.filePath}:${m.line}`;
    case "knowledge":    return `${m.source} · ${m.filePath}`;
    case "repo":         return m.absPath;
    case "paper":        return m.authors.length ? m.authors.join(", ") : "paper";
    case "branch":       return `${m.refKind} · ${m.sha.slice(0, 7)}`;
    case "past_message": return m.sessionTitle;
  }
}

// ── Extension assembly ───────────────────────────────────────────────────────

function buildDecorations(ranges: readonly MentionRange[]): DecorationSet {
  const decos: Range<Decoration>[] = ranges.map((r) =>
    Decoration.replace({
      widget: new ChipWidget(r.mention),
      inclusive: false,
    }).range(r.from, r.to)
  );
  return Decoration.set(decos, /* sort */ true);
}

/** The atomicRanges facet is a function that returns a RangeSet — anything
 *  inside those ranges is treated as a single character for cursor motion
 *  and Backspace. We point it at the same field so chips stay atomic. */
function mentionAtomicRanges(view: EditorView): RangeSet<Decoration> {
  const ranges = view.state.field(mentionField, false) ?? [];
  if (ranges.length === 0) return RangeSet.empty;
  return RangeSet.of(
    ranges.map((r) => Decoration.mark({}).range(r.from, r.to)),
    true
  );
}

/** Bundle everything an editor needs. Add to your `extensions` array. */
export const mentionExtension = [
  mentionField,
  EditorView.decorations.from(mentionField, buildDecorations),
  EditorView.atomicRanges.of(mentionAtomicRanges),
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Replace [from..to] with the mention's shortform and register the range
 *  in the field. If `from === to`, this becomes a pure insertion at `from`.
 *  A trailing space is appended after the chip so the next keystroke isn't
 *  visually glued to the pill. */
export function insertMention(
  view: EditorView,
  mention: MentionData,
  from: number,
  to: number
): void {
  const shortform = toShortForm(mention);
  const insertText = shortform + " ";
  view.dispatch({
    changes: { from, to, insert: insertText },
    effects: addMentionEffect.of({
      mention,
      from,
      to: from + shortform.length,
    }),
    selection: { anchor: from + insertText.length },
  });
}

/** Read the current mentions out of the view. Used at submit time. */
export function getMentions(view: EditorView): MentionData[] {
  const ranges = view.state.field(mentionField, false) ?? [];
  return ranges.map((r) => r.mention);
}
