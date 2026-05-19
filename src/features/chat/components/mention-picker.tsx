// Floating mention picker. Anchored to a fixed coordinate (the caret of the
// `@` in the CodeMirror composer), driven by an imperative keyboard API so
// the editor never loses focus.
//
// Two views:
//   • Empty query, no scope locked: "Recent files" (up to 5) → divider →
//     category headers. Headers act as scope-locks.
//   • Anything else: a single blended ranked list. Files dominate by
//     weight, but category-aliased queries (e.g. `@note auth`) boost the
//     matching kind so users can steer the result set.
//
// Keyboard contract: the parent component forwards Up/Down/Enter/Esc via
// the imperative handle so CM's focus stays put — the picker never has
// DOM focus.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";

import {
  MENTION_CATEGORIES,
  PROVIDERS,
  categoryForKind,
  rankMention,
  stripCategoryAlias,
  type MentionCategory,
  type MentionContext,
  type MentionData,
  type MentionKind,
} from "../lib/mentions";
import {
  useRecentFilesStore,
  type RecentFile,
} from "../stores/recent-files-store";

// ── Public API ───────────────────────────────────────────────────────────────

export interface MentionPickerHandle {
  /** Move the active row down by 1. Wraps. */
  moveDown(): void;
  /** Move the active row up by 1. Wraps. */
  moveUp(): void;
  /** Commit the active row. Returns true if a real selection happened
   *  (mention inserted, or scope locked). False if there were no results
   *  so the parent can decide what Enter does in that case. */
  commit(): boolean;
}

export interface MentionPickerProps {
  /** When false, the popover unmounts and providers stop firing. */
  open: boolean;
  /** Query text typed after the `@` (excluding the `@` itself). */
  query: string;
  /** Caret position in viewport coords, used to anchor the popover. */
  anchor: { x: number; y: number } | null;
  /** Active project root — required for project-scoped sources. */
  projectPath: string | null;
  /** A mention was picked. Parent inserts the chip. */
  onSelect: (mention: MentionData) => void;
  /** Picker closed itself (Esc, no anchor, etc). */
  onClose: () => void;
}

// ── Internal model ───────────────────────────────────────────────────────────

/** One renderable row. Either a real mention or a category header (which
 *  acts as a scope-lock button when activated). */
type Row =
  | { type: "header"; label: string }
  | { type: "category"; cat: MentionCategory }
  | { type: "mention"; mention: MentionData; recentLabel?: string };

const RECENT_LIMIT = 5;

// ── Picker component ────────────────────────────────────────────────────────

export const MentionPicker = forwardRef<MentionPickerHandle, MentionPickerProps>(
  function MentionPicker(
    { open, query, anchor, projectPath, onSelect, onClose },
    ref
  ) {
    const recentFiles = useRecentFilesStore.use.items();
    const [scope, setScope] = useState<MentionKind | null>(null);
    const [results, setResults] = useState<MentionData[]>([]);
    const [active, setActive] = useState(0);

    // Reset transient state when the popover (re-)opens.
    useEffect(() => {
      if (open) {
        setScope(null);
        setActive(0);
      } else {
        setResults([]);
      }
    }, [open]);

    // Run providers on every (query, scope, projectPath) change. Each
    // provider gets its own AbortSignal so stale results from a prior
    // query get dropped before they hit setState.
    useEffect(() => {
      if (!open) return;
      const controller = new AbortController();
      const ctx: MentionContext = { projectPath };
      void runSearch(query, scope, ctx, controller.signal).then((r) => {
        if (controller.signal.aborted) return;
        setResults(r);
        setActive(0);
      });
      return () => controller.abort();
    }, [open, query, scope, projectPath]);

    // Build the renderable row list. Order:
    //   no scope + empty query → Recents (header) → files → Categories header → categories
    //   no scope + query       → blended results sorted by rank
    //   scope locked           → header showing scope → results in that scope
    const rows = useMemo<Row[]>(() => {
      const out: Row[] = [];
      if (scope) {
        out.push({ type: "header", label: categoryForKind(scope).label });
        for (const m of results) {
          out.push({ type: "mention", mention: m });
        }
        return out;
      }
      if (!query.trim()) {
        const recents = recentFiles.slice(0, RECENT_LIMIT);
        if (recents.length > 0) {
          out.push({ type: "header", label: "Recent files" });
          for (const r of recents) {
            out.push({
              type: "mention",
              mention: recentToMention(r),
              recentLabel: dirOf(r.rel),
            });
          }
        }
        out.push({ type: "header", label: "Browse" });
        for (const cat of MENTION_CATEGORIES) {
          out.push({ type: "category", cat });
        }
        return out;
      }
      // Blended: rank everything together and slice.
      const recentSet = new Set(recentFiles.map((r) => r.absPath));
      const ranked = results
        .map((m) => ({
          m,
          score: rankMention(query, m, m.kind === "file" && recentSet.has(m.id)),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);
      for (const { m } of ranked) {
        out.push({ type: "mention", mention: m });
      }
      return out;
    }, [scope, query, results, recentFiles]);

    // Compute the navigable rows (skip headers). `active` is an index into
    // *navigable* rows, not the full list; the renderer maps it back.
    const navIndices = useMemo(() => {
      const idxs: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].type !== "header") idxs.push(i);
      }
      return idxs;
    }, [rows]);

    useEffect(() => {
      if (active >= navIndices.length) setActive(0);
    }, [active, navIndices.length]);

    const activeRowIdx = navIndices[active];
    const activeRow: Row | undefined = activeRowIdx === undefined ? undefined : rows[activeRowIdx];

    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useImperativeHandle(
      ref,
      (): MentionPickerHandle => ({
        moveDown: () => {
          if (navIndices.length === 0) return;
          setActive((a) => (a + 1) % navIndices.length);
        },
        moveUp: () => {
          if (navIndices.length === 0) return;
          setActive((a) => (a - 1 + navIndices.length) % navIndices.length);
        },
        commit: () => {
          if (!activeRow) return false;
          if (activeRow.type === "category") {
            setScope(activeRow.cat.kind);
            setActive(0);
            return true;
          }
          if (activeRow.type === "mention") {
            onSelectRef.current(activeRow.mention);
            return true;
          }
          return false;
        },
      }),
      [activeRow, navIndices.length]
    );

    if (!open || !anchor) return null;

    return (
      <Popover.Root open>
        <Popover.Anchor asChild>
          <div
            // Anchor element sits at the caret. Fixed positioning means it
            // doesn't move when the chat panel scrolls — Radix repositions
            // the floating popover on its own.
            style={{
              position: "fixed",
              left: anchor.x,
              top: anchor.y,
              width: 1,
              height: 1,
              pointerEvents: "none",
            }}
          />
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={6}
            // Don't steal focus from CodeMirror.
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            // Clicking outside / Escape are owned by the parent; Radix's
            // default would call onOpenChange which we don't wire.
            onPointerDownOutside={(e) => {
              // Only close if the user clicked truly outside both the
              // popover AND the editor.
              const target = e.target as HTMLElement | null;
              if (target?.closest(".atlas-chat-cm-host")) {
                e.preventDefault();
                return;
              }
              onCloseRef.current();
            }}
            onEscapeKeyDown={() => onCloseRef.current()}
            className={cn(
              "rounded-lg overflow-hidden",
              "bg-[var(--bg-secondary)] border border-[var(--border-default)]",
              "shadow-[0_8px_24px_rgba(0,0,0,0.5)]",
              "w-[420px] max-h-[360px] flex flex-col",
              "z-[var(--z-overlay)]"
            )}
            style={{ zIndex: 9999 }}
          >
            <div className="flex-1 overflow-y-auto py-1">
              {rows.length === 0 ? (
                <div className="px-3 py-6 text-center text-[11px] text-[var(--text-tertiary)]">
                  No matches
                </div>
              ) : (
                rows.map((row, i) => {
                  if (row.type === "header") {
                    return (
                      <div
                        key={`h-${i}`}
                        className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-wider text-[var(--text-tertiary)] font-semibold"
                      >
                        {row.label}
                      </div>
                    );
                  }
                  const isActive = i === activeRowIdx;
                  if (row.type === "category") {
                    return (
                      <button
                        key={`c-${row.cat.kind}`}
                        onMouseEnter={() => {
                          const navIdx = navIndices.indexOf(i);
                          if (navIdx >= 0) setActive(navIdx);
                        }}
                        onMouseDown={(e) => {
                          // Avoid stealing focus.
                          e.preventDefault();
                          setScope(row.cat.kind);
                          setActive(0);
                        }}
                        className={cn(
                          "w-full text-left px-3 h-[26px] flex items-center gap-2 text-[11.5px]",
                          isActive
                            ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                        )}
                      >
                        <span className="opacity-75 w-4 text-center">
                          {categoryGlyph(row.cat.kind)}
                        </span>
                        <span>{row.cat.label}</span>
                      </button>
                    );
                  }
                  // Mention row
                  const m = row.mention;
                  return (
                    <button
                      key={`m-${m.kind}-${m.id}`}
                      onMouseEnter={() => {
                        const navIdx = navIndices.indexOf(i);
                        if (navIdx >= 0) setActive(navIdx);
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onSelectRef.current(m);
                      }}
                      className={cn(
                        "w-full text-left px-3 h-[26px] flex items-center gap-2 text-[11.5px]",
                        isActive
                          ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                      )}
                      title={mentionTitle(m)}
                    >
                      <span className="opacity-75 w-4 text-center">
                        {categoryGlyph(m.kind)}
                      </span>
                      <span className="truncate flex-1 min-w-0">
                        {m.displayName}
                      </span>
                      <span className="text-[10px] text-[var(--text-tertiary)] truncate max-w-[160px]">
                        {row.recentLabel ?? secondaryLabel(m)}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            <div className="border-t border-[var(--border-default)] px-3 h-[24px] flex items-center justify-between text-[9px] text-[var(--text-tertiary)] uppercase tracking-wider shrink-0">
              <span>
                {scope
                  ? `Scope: ${categoryForKind(scope).label}`
                  : query
                    ? "Filtered"
                    : "Top: recents · then categories"}
              </span>
              <span>↑↓ · ↵ select · ⎋ close</span>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }
);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function runSearch(
  query: string,
  scope: MentionKind | null,
  ctx: MentionContext,
  signal: AbortSignal
): Promise<MentionData[]> {
  if (scope) {
    return PROVIDERS[scope]
      .search(stripCategoryAlias(query, scope), ctx, signal)
      .catch(() => []);
  }
  // Blended view — fan out to all providers in parallel and concatenate.
  // Ranking happens in the rows memo so providers can finish in any order.
  const settled = await Promise.allSettled(
    MENTION_CATEGORIES.map((cat) =>
      PROVIDERS[cat.kind].search(stripCategoryAlias(query, cat.kind), ctx, signal)
    )
  );
  if (signal.aborted) return [];
  const out: MentionData[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") out.push(...s.value);
  }
  return out;
}

function recentToMention(r: RecentFile): MentionData {
  return {
    kind: "file",
    id: r.absPath,
    displayName: r.rel,
    absPath: r.absPath,
  };
}

function dirOf(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx > 0 ? rel.slice(0, idx) : "";
}

function categoryGlyph(kind: MentionKind): string {
  switch (kind) {
    case "file":         return "📄";
    case "symbol":       return "⌬";
    case "knowledge":    return "✦";
    case "paper":        return "📑";
    case "branch":       return "⎇";
    case "past_message": return "✉";
  }
}

function secondaryLabel(m: MentionData): string {
  switch (m.kind) {
    case "file":         return dirOf(m.displayName);
    case "symbol":       return `${m.symbolKind} · ${shortPath(m.filePath)}`;
    case "knowledge":    return m.source;
    case "paper":        return m.authors[0] ?? "";
    case "branch":       return m.refKind + (m.isCurrent ? " · HEAD" : "");
    case "past_message": return m.sessionTitle;
  }
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.slice(-2).join("/");
}

function mentionTitle(m: MentionData): string {
  switch (m.kind) {
    case "file":         return m.absPath;
    case "symbol":       return `${m.filePath}:${m.line}`;
    case "knowledge":    return m.filePath;
    case "paper":        return m.metadataPath;
    case "branch":       return `${m.refKind} ${m.id} (${m.sha.slice(0, 7)})`;
    case "past_message": return m.content;
  }
}
